// ─────────────────────────────────────────────────────────────────────────────
// mixtape-pick.js — the mixtape editor's song picker core (pure, no DOM).
//
// An index over the library (diacritic- and case-insensitive; tokens are ANDed over
// title + artist + album), results GROUPED BY ALBUM, a flat row list for a virtualised
// DOM list, and the "already on tape" key set.
//
// Search adapter seam: the editor only calls the three functions of `defaultSearch`
// ({ buildIndex(tracks), query(index, text, opts) -> { groups, total, truncated }, browse(index) }).
// When the global search module (src/search/) is available, wrap its buildIndex/query in an
// object of that shape and pass it to createPicker({ search }): swapping is one line.
// ─────────────────────────────────────────────────────────────────────────────

import { groupTracks } from './albums.js';
import { trackKey } from './mixtape.js';

/** Lower-case, strip diacritics, non-alphanumerics -> single spaces. "Sigur Rós" -> "sigur ros". */
export function fold(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').replace(/[øØ]/g, 'o').replace(/[æÆ]/g, 'ae').replace(/[łŁ]/g, 'l').replace(/[đĐ]/g, 'd')
    .toLowerCase().replace(/[^a-z0-9Ͱ-ϿЀ-ӿ぀-ヿ一-鿿]+/g, ' ').trim();
}

/** The identity used for "already on tape" (library id, else artist/album/title). */
export const identOf = (t) => (t && t.id) || trackKey(t || {});

/** Set of identities already on the tape (both id and loose key, so a re-tagged ref still counts). */
export function tapeKeys(m) {
  const s = new Set();
  for (const r of m.tracks) { if (r.id) s.add(r.id); s.add(trackKey(r)); }
  return s;
}
export const isOnTape = (set, t) => !!t && ((t.id && set.has(t.id)) || set.has(trackKey(t)));

function buildIndex(tracks) {
  const albums = groupTracks(tracks);
  const rows = [], albumOf = new Map();
  albums.forEach((a, ai) => {
    a.tracks.forEach((t, ti) => {
      albumOf.set(t, ai);
      rows.push({ t, ai, ti, title: fold(t.title), hay: fold(`${t.title} ${t.artist} ${t.album || a.title} ${t.albumArtist || ''}`) });
    });
  });
  return { albums, rows, size: rows.length };
}

const headOf = (a) => ({ key: a.key, title: a.title, artist: a.artist, kind: a.kind, count: a.tracks.length });

/** All albums, in the library's order: groups of { album, tracks }. */
function browse(index) {
  return index.albums.map((a) => ({ album: headOf(a), tracks: a.tracks }));
}

function query(index, text, { limit = 400 } = {}) {
  const toks = fold(text).split(' ').filter(Boolean);
  if (!toks.length) return { groups: browse(index), total: index.size, truncated: false, empty: true };
  const hits = new Map();   // ai -> { score, rows: [] }
  let total = 0;
  for (const r of index.rows) {
    let score = 0, ok = true;
    for (const k of toks) {
      if (!r.hay.includes(k)) { ok = false; break; }
      score += r.title.startsWith(k) ? 3 : r.title.includes(' ' + k) ? 2 : r.title.includes(k) ? 1.5 : 1;
    }
    if (!ok) continue;
    total++;
    let g = hits.get(r.ai);
    if (!g) { g = { score: 0, rows: [] }; hits.set(r.ai, g); }
    g.rows.push(r); if (score > g.score) g.score = score;
  }
  const order = [...hits.entries()].sort((a, b) => b[1].score - a[1].score || a[0] - b[0]);
  const groups = [];
  let used = 0, truncated = false;
  for (const [ai, g] of order) {
    if (used >= limit) { truncated = true; break; }
    const take = g.rows.slice(0, limit - used);
    if (take.length < g.rows.length) truncated = true;
    used += take.length;
    groups.push({ album: headOf(index.albums[ai]), tracks: take.map((r) => r.t) });
  }
  return { groups, total, truncated, empty: false };
}

/** The built-in search (diacritics, tokens, grouping). A src/search adapter must have this shape. */
export const defaultSearch = Object.freeze({ buildIndex, query, browse });

/** Groups -> flat rows for a virtual list: [{ kind:'head', album }, { kind:'track', t, album }]. */
export function flattenGroups(groups) {
  const rows = [];
  for (const g of groups) {
    rows.push({ kind: 'head', album: g.album });
    for (const t of g.tracks) rows.push({ kind: 'track', t, album: g.album });
  }
  return rows;
}

/** Fixed-height virtual window: which rows [from, to) to draw for scrollTop/viewport, with overscan. */
export function virtualWindow({ count, rowH, scrollTop, viewH, overscan = 6 }) {
  const first = Math.min(count, Math.max(0, Math.floor(scrollTop / rowH) - overscan));
  const last = Math.min(count, Math.ceil((scrollTop + viewH) / rowH) + overscan);
  return { from: first, to: Math.max(first, last), totalH: count * rowH };
}

/** createPicker(tracks, { search }) -> { query(text), browse(), size }. Rebuild when the library changes. */
export function createPicker(tracks, { search = defaultSearch } = {}) {
  const index = search.buildIndex(tracks || []);
  return {
    size: index.size,
    query: (text, opts) => search.query(index, text, opts),
    browse: () => search.browse(index),
    index,
  };
}

/** A list of tracks for one album group, ready for addMany. */
export const groupTracksOf = (g) => g.tracks.slice();
