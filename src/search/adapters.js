// adapters.js — turns what the app already has into the plain records the search index takes, and gives the UI the lookups it needs
// for drill-downs (an artist's albums, an album's songs). Pure: everything is passed in. Tolerates absence and odd shapes (the
// library read-model is being replaced by the device library; this reads `tracks` / `albums` defensively and adapts).
//
//   adaptLibrary(library)            -> { data: { tracks, albums, artists }, lookup }
//   adaptMixtapes(list)              -> [mixtape records]          (list = MixtapeUI.list; name, author, the flat `tracks`)
//   adaptStations({ radioModel, cannedIndex, aiOn }) -> [station records]
//   buildSearchData({ library, mixtapes, radioModel, cannedIndex, aiOn }) -> { data, lookup }
//
// Station records carry the real Station object (`station`) so the UI can hand it straight to searchActions.playStation().
import { fold } from './fold.js';
import { stationFromEntry, stationKey } from '../radio-store.js';
import { parseStationsIndex, cannedStation, buildCatalog, AI_STYLE_TYPE, CANNED_TYPE } from '../radio/canned/catalog.js';
import { aiYouStation } from '../stations.js';

const str = (v, max = 240) => (typeof v === 'string' ? v : '').slice(0, max);
const isObj = (v) => !!v && typeof v === 'object';
const UNKNOWN = /^(unknown artist|<unknown>|various artists?)?$/i;

function tracksOf(lib) {
  try {
    if (Array.isArray(lib)) return lib;
    if (!isObj(lib)) return [];
    const t = typeof lib.tracks === 'function' ? lib.tracks() : lib.tracks;
    if (Array.isArray(t)) return t;
    if (typeof lib.getTracks === 'function') { const g = lib.getTracks(); if (Array.isArray(g)) return g; }
  } catch { /* a broken model reads as empty */ }
  return [];
}
function albumsOf(lib) {
  try {
    if (!isObj(lib) || Array.isArray(lib)) return null;
    const a = typeof lib.albums === 'function' ? lib.albums() : lib.albums;
    return Array.isArray(a) ? a : null;
  } catch { return null; }
}

/** Library -> { data: { tracks, albums, artists }, lookup }. `lookup` answers drill-downs without searching. */
export function adaptLibrary(lib) {
  const src = tracksOf(lib);
  const tracks = [];
  const byId = new Map();
  for (const t of src) {
    if (!isObj(t)) continue;
    const id = str(t.id, 120) || `t${tracks.length}`;
    const rec = { id, title: str(t.title) || str(t.name) || 'Untitled', artist: str(t.artist) || str(t.albumArtist), album: str(t.album), genre: str(t.genre, 60), albumId: '', relink: !!t.relink, raw: t };
    if (UNKNOWN.test(rec.artist) && /^unknown/i.test(rec.artist)) rec.artist = '';
    tracks.push(rec); byId.set(id, rec);
  }
  // albums: the library's own shelf when it has one, else group by (artist, album)
  const albums = [];
  const shelf = albumsOf(lib);
  if (shelf) {
    for (const a of shelf) {
      if (!isObj(a)) continue;
      const list = (Array.isArray(a.tracks) ? a.tracks : []).map((x) => (isObj(x) ? str(x.id, 120) : '')).filter(Boolean);
      const rec = { id: str(a.id, 120) || `a${albums.length}`, name: str(a.album) || str(a.name) || str(a.title) || 'Untitled album', artist: str(a.artist), kind: a.kind === 'cd' ? 'cd' : 'vinyl', genre: str(a.genre, 60), trackCount: list.length || (Array.isArray(a.tracks) ? a.tracks.length : 0), trackIds: list, raw: a };
      albums.push(rec);
    }
  } else {
    const groups = new Map();
    for (const t of tracks) {
      const key = fold(t.artist) + '\0' + fold(t.album || '');
      if (!t.album) continue;
      let g = groups.get(key);
      if (!g) { g = { id: `alb:${groups.size}`, name: t.album, artist: t.artist, kind: 'vinyl', genre: t.genre, trackIds: [] }; groups.set(key, g); albums.push(g); }
      g.trackIds.push(t.id);
    }
    for (const g of albums) g.trackCount = g.trackIds.length;
  }
  const albumById = new Map();
  for (const a of albums) { albumById.set(a.id, a); for (const id of a.trackIds) { const t = byId.get(id); if (t && !t.albumId) t.albumId = a.id; } }

  // artists
  const art = new Map();
  const slot = (name) => {
    const k = fold(name);
    if (!k || UNKNOWN.test(name.trim())) return null;
    let a = art.get(k);
    if (!a) { a = { name, albums: new Set(), tracks: [] }; art.set(k, a); }
    return a;
  };
  for (const t of tracks) { const a = slot(t.artist); if (a) { a.tracks.push(t.id); if (t.albumId) a.albums.add(t.albumId); } }
  for (const al of albums) { const a = slot(al.artist); if (a) a.albums.add(al.id); }
  const artists = [...art.values()].map((a) => ({ name: a.name, albums: a.albums.size, tracks: a.tracks.length }));

  const lookup = {
    track: (id) => byId.get(id) || null,
    album: (id) => albumById.get(id) || null,
    albumTracks: (id) => { const a = albumById.get(id); return a ? a.trackIds.map((i) => byId.get(i)).filter(Boolean) : []; },
    artistKey: (name) => fold(name),
    artistTracks: (name) => { const a = art.get(fold(name)); return a ? a.tracks.map((i) => byId.get(i)).filter(Boolean) : []; },
    artistAlbums: (name) => { const a = art.get(fold(name)); return a ? [...a.albums].map((i) => albumById.get(i)).filter(Boolean) : []; },
  };
  const pubTracks = tracks.map(({ raw, ...r }) => r);
  const pubAlbums = albums.map(({ raw, trackIds, ...r }) => r);
  return { data: { tracks: pubTracks, albums: pubAlbums, artists }, lookup };
}

/** Mixtape list (MixtapeUI.list or parseCollection output) -> records. Uses the flat `tracks` (A then B). */
export function adaptMixtapes(list) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (!isObj(m)) continue;
    out.push({ id: str(m.id, 120), name: str(m.name), author: str(m.author), tracks: (Array.isArray(m.tracks) ? m.tracks : []).slice(0, 200).map((t) => (isObj(t) ? { title: str(t.title, 120), artist: str(t.artist, 120) } : str(t, 120))) });
  }
  return out;
}

/**
 * Radio channels: the pre-written shows, saved favourites and recents, You Radio and the AI style cards (the last two only when
 * the radio.ai flag is on; the style cards are listed disabled, never startable). No network: the directory is a separate, explicit row.
 */
export function adaptStations({ radioModel = null, cannedIndex = [], aiOn = false } = {}) {
  const out = [];
  const seen = new Set();
  const saved = new Map();      // key -> { fav, at }
  try {
    const m = radioModel || {};
    for (const e of Array.isArray(m.favs) ? m.favs : []) if (e && e.k) saved.set(e.k, { fav: true, at: Number(e.at) || 0, e });
    for (const e of [...(Array.isArray(m.recents) ? m.recents : []), ...(m.last ? [m.last] : [])]) {
      if (!e || !e.k) continue;
      const cur = saved.get(e.k);
      if (cur) cur.at = Math.max(cur.at, Number(e.at) || 0); else saved.set(e.k, { fav: false, at: Number(e.at) || 0, e });
    }
  } catch { /* an unreadable model reads as empty */ }

  const index = Array.isArray(cannedIndex) ? cannedIndex : parseStationsIndex(cannedIndex);
  for (const e of index) {
    const st = cannedStation(e), key = stationKey(st);
    const sv = saved.get(key);
    seen.add(key);
    out.push({
      key, id: e.id, type: CANNED_TYPE, name: e.name, dial: e.dial, tagline: e.tagline, hosts: e.hosts, source: 'canned', station: st,
      subtitle: `${e.dial ? e.dial + ' · ' : ''}Works offline`, fav: !!(sv && sv.fav), plays: sv ? (sv.fav ? 5 : 1) : 0, lastPlayed: sv ? sv.at : 0,
    });
  }
  for (const [key, sv] of saved) {
    if (seen.has(key)) continue;
    let st; try { st = stationFromEntry(sv.e); } catch { continue; }
    if (!st || !st.name) continue;
    if (String(st.type).startsWith('ai-') && !aiOn) continue;       // a saved AI station is hidden while the flag is off
    seen.add(key);
    const bits = [st.country, st.tags && st.tags.slice(0, 2).join(', ')].filter(Boolean).join(' · ');
    out.push({ key, id: st.id, type: st.type, name: st.name, tags: st.tags, country: st.country, source: 'saved', station: st, subtitle: bits || (sv.fav ? 'Favourite station' : 'Recent station'), fav: sv.fav, plays: sv.fav ? 5 : 1, lastPlayed: sv.at });
  }
  if (aiOn) {
    const you = aiYouStation(), key = stationKey(you);
    if (!seen.has(key)) out.push({ key, id: you.id, type: you.type, name: you.name, source: 'you', station: you, subtitle: 'Hosts talk between your own songs · offline', tags: ['ai'], plays: saved.get(key) ? 3 : 0, lastPlayed: saved.get(key) ? saved.get(key).at : 0 });
    try {
      for (const c of buildCatalog({ index, flagOn: true }).styles) {
        out.push({ key: c.key, id: c.id, type: AI_STYLE_TYPE, name: c.name, source: 'style', disabled: true, note: 'Coming soon', subtitle: `${c.subtitle || 'AI station'} · coming soon`, tags: ['ai'] });
      }
    } catch { /* styles are decoration */ }
  }
  return out;
}

/** Everything the index and the UI need, from the app's live objects. Each part is optional. */
export function buildSearchData({ library = null, mixtapes = [], radioModel = null, cannedIndex = [], aiOn = false } = {}) {
  const lib = adaptLibrary(library);
  return {
    data: { ...lib.data, mixtapes: adaptMixtapes(mixtapes), stations: adaptStations({ radioModel, cannedIndex, aiOn }) },
    lookup: lib.lookup,
  };
}
