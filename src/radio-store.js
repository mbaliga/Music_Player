// ─────────────────────────────────────────────────────────────────────────────
// radio-store.js — pure favourites / recents / last-played model for the dial.
//
// No DOM. Storage is injected (anything with getItem/setItem) and every access
// is try/caught, so a private window, blocked storage or garbage JSON degrades
// to an empty model instead of throwing.
//
// "One dial": every entry is keyed by (station.type, station.id), so a real
// station ('radio-browser', 'rb:<uuid>') and a future AI station ('ai-you',
// 'you') live in the same lists with no migration. An entry carries a SNAPSHOT
// of the station (name, stream URLs, favicon, tags, country, ...) so a favourite
// still plays when the directory is unreachable. AI stations have no stream URL;
// their snapshot is just identity + display fields.
//
// Persisted JSON: { v:1, favs:[Entry], recents:[Entry], last: Entry|null }
//   Entry = { k, type, id, at, snap }   (k = "type|id", at = epoch ms)
// ─────────────────────────────────────────────────────────────────────────────

export const STORE_KEY = 'runout.radio.v1';
export const STORE_VERSION = 1;
export const MAX_RECENTS = 20;
export const MAX_FAVOURITES = 200;

const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

export const emptyModel = () => ({ v: STORE_VERSION, favs: [], recents: [], last: null });

/** Stable identity of a station on the dial. null when type/id are unusable. */
export function stationKey(s) {
  return s && typeof s.type === 'string' && s.type && typeof s.id === 'string' && s.id ? `${s.type}|${s.id}` : null;
}

/** The persisted subset of a station (strings capped, arrays bounded). */
export function snapshotOf(s) {
  const o = { name: str(s.name, 200) };
  if (Array.isArray(s.streamUrls) || s.streamUrl) {
    const urls = [s.streamUrl, ...(Array.isArray(s.streamUrls) ? s.streamUrls : [])].filter(isHttp);
    const uniq = [...new Set(urls)].slice(0, 4);
    if (uniq.length) { o.streamUrl = uniq[0]; o.streamUrls = uniq; }
  }
  if (isHttp(s.favicon)) o.favicon = str(s.favicon, 500);
  if (isHttp(s.homepage)) o.homepage = str(s.homepage, 500);
  if (typeof s.dial === 'string' && s.dial) o.dial = str(s.dial, 12);          // canned stations: refreshed from the stations index
  if (typeof s.tagline === 'string' && s.tagline) o.tagline = str(s.tagline, 200);
  o.country = str(s.country, 80);
  o.tags = Array.isArray(s.tags) ? s.tags.filter((t) => typeof t === 'string').slice(0, 5).map((t) => t.slice(0, 40)) : [];
  o.codec = str(s.codec, 20);
  o.bitrate = Number(s.bitrate) > 0 ? Math.min(Number(s.bitrate), 9999) | 0 : 0;
  return o;
}

/** Entry -> a Station object usable by createSessionFor() (works with no network). */
export function stationFromEntry(e) {
  return { ...e.snap, type: e.type, id: e.id };
}

function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const k = stationKey(e);
  if (!k || !e.snap || typeof e.snap !== 'object' || typeof e.snap.name !== 'string' || !e.snap.name.trim()) return null;
  return { k, type: e.type, id: e.id, at: Number.isFinite(e.at) ? e.at : 0, snap: snapshotOf({ ...e.snap, type: e.type, id: e.id }) };
}

function cleanList(v, cap) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of v) {
    const e = cleanEntry(raw);
    if (e && !seen.has(e.k)) { seen.add(e.k); out.push(e); }
    if (out.length >= cap) break;
  }
  return out;
}

/** JSON text or object -> a valid model. Never throws; unknown/garbage -> empty. */
export function parseModel(input) {
  try {
    const j = typeof input === 'string' ? JSON.parse(input) : input;
    if (!j || typeof j !== 'object' || j.v !== STORE_VERSION) return emptyModel();
    return { v: STORE_VERSION, favs: cleanList(j.favs, MAX_FAVOURITES), recents: cleanList(j.recents, MAX_RECENTS), last: cleanEntry(j.last) };
  } catch { return emptyModel(); }
}

export const serializeModel = (m) => JSON.stringify({ v: STORE_VERSION, favs: m.favs, recents: m.recents, last: m.last });

const entryFor = (station, now) => ({ k: stationKey(station), type: station.type, id: station.id, at: now, snap: snapshotOf(station) });
const CANNED = 'canned';
const usable = (station) => !!station && !!stationKey(station) && typeof station.name === 'string' && !!station.name.trim();

export const isFavourite = (m, station) => { const k = stationKey(station); return !!k && m.favs.some((e) => e.k === k); };

/** Add (newest first) or remove a favourite. Returns a new model. */
export function toggleFavourite(m, station, now = Date.now()) {
  if (!usable(station)) return m;
  const k = stationKey(station);
  if (m.favs.some((e) => e.k === k)) return { ...m, favs: m.favs.filter((e) => e.k !== k) };
  return { ...m, favs: [entryFor(station, now), ...m.favs].slice(0, MAX_FAVOURITES) };
}

/**
 * A station reached 'playing': move it to the front of recents (deduped, capped),
 * make it the resume target, and refresh its favourite snapshot (stream URLs drift).
 */
export function recordPlayed(m, station, now = Date.now(), index = null) {
  if (!usable(station)) return m;
  let st = station;
  if (station.type === CANNED) {
    // The pack text lives in the app, not in the snapshot: the stations index is the truth, and a stale copy handed in by
    // Resume / a saved row must never overwrite a fresh one. A station the index no longer lists is not recorded at all.
    const e0 = (Array.isArray(index) && index.length) ? index.find((x) => x && x.id === station.id) : null;
    if (Array.isArray(index) && index.length && !e0) return m;
    if (e0) st = { ...station, name: e0.name, dial: e0.dial, tagline: e0.tagline };
    else {
      const old = [m.last, ...m.favs, ...m.recents].find((x) => x && x.k === stationKey(station));
      if (old) st = { ...station, name: old.snap.name, dial: old.snap.dial, tagline: old.snap.tagline };
    }
  }
  const e = entryFor(st, now);
  return {
    ...m,
    favs: m.favs.map((f) => (f.k === e.k ? { ...f, snap: e.snap } : f)),
    recents: [e, ...m.recents.filter((r) => r.k !== e.k)].slice(0, MAX_RECENTS),
    last: e,
  };
}

/**
 * Canned stations are defined by the app's stations index (content/stations/index.json), so a favourite / recent / resume entry
 * for one is only a cache. Refresh name, tagline and dial of every matching 'canned|<id>' entry from `index` ([{id,name,dial,tagline}]).
 * An empty / missing index changes nothing (a failed load is not proof that a station is gone). Returns the SAME model when
 * nothing differs, so callers can skip a save.
 */
export function refreshCannedSnapshots(m, index) {
  if (!Array.isArray(index) || !index.length) return m;
  const byId = new Map(index.filter((x) => x && typeof x.id === 'string').map((x) => [x.id, x]));
  let changed = false;
  const fix = (e) => {
    if (!e || e.type !== CANNED) return e;
    const x = byId.get(e.id);
    if (!x) return e;
    const snap = { ...e.snap, name: str(x.name, 200) || e.snap.name };
    if (typeof x.dial === 'string' && x.dial) snap.dial = str(x.dial, 12); else delete snap.dial;
    if (typeof x.tagline === 'string' && x.tagline) snap.tagline = str(x.tagline, 200); else delete snap.tagline;
    if (JSON.stringify(snap) === JSON.stringify(e.snap)) return e;
    changed = true;
    return { ...e, snap };
  };
  const out = { ...m, favs: m.favs.map(fix), recents: m.recents.map(fix), last: fix(m.last) };
  return changed ? out : m;
}

/** true when `station` is a canned one the (loaded, non-empty) stations index does not list any more. */
export const isMissingCanned = (station, index) =>
  !!station && station.type === CANNED && Array.isArray(index) && index.length > 0 && !index.some((x) => x && x.id === station.id);

/** Drop one station (by key) from favourites, recents and Resume. */
export function removeEntry(m, key) {
  if (!key) return m;
  return { ...m, favs: m.favs.filter((e) => e.k !== key), recents: m.recents.filter((e) => e.k !== key), last: m.last && m.last.k === key ? null : m.last };
}

export const clearRecents = (m) => ({ ...m, recents: [] });

// ── Storage (injected; all access guarded) ──────────────────────────────────

export function loadModel(storage) {
  try { return parseModel(storage.getItem(STORE_KEY)); } catch { return emptyModel(); }
}

/** true when written. */
export function saveModel(storage, m) {
  try { storage.setItem(STORE_KEY, serializeModel(m)); return true; } catch { return false; }
}
