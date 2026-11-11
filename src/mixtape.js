// ─────────────────────────────────────────────────────────────────────────────
// mixtape.js — pure mixtape model: custom playlists with a cassette look.
//
// No DOM / browser globals (portable like model.js; tested in
// test/mixtape.test.mjs and test/mixtape-v3.test.mjs). Drawing lives in
// src/cassette/*, UI + persistence glue in mixtape-ui.js.
//
// A mixtape = name + author + ordered track REFS + a cassette `cfg` (style
// id, pen, wear, gloss, optional ink colour, label text). Refs are metadata
// ({title, artist, album, id?}), not file handles: a browser can't persist a
// File across sessions, so a ref is matched back to the library at play time
// (resolveTracks): stable track id first (libindex.js: hash of tags +
// size/duration), then exact (artist, album, title), then loose (artist,
// title). The library itself is persisted as metadata, so a ref usually
// resolves to a "needs re-link" track (no File yet) rather than to nothing;
// unmatched refs stay in the tape, shown as unavailable.
//
// Versions
//   v1  refs {title, artist, album}; style/font/fontColor from the 8 original
//       procedural placeholder shells.
//   v2  refs may carry `id`. Same placeholder style/font/fontColor.
//   v3  the owner's cassette system: `cfg` {style (one of 37), pen, wear,
//       gloss, slots{ink}, text{subtitle,note,side}} + `author`. The mixtape
//       name is cfg.text.title in the renderer (single source: `name`).
// Writers emit v3; readers accept v1, v2 and v3. v1/v2 style/font/colour ids
// migrate to the nearest new style / pen (LEGACY_* tables below). Anything
// newer than v3 is refused/ignored, never guessed (the UI backs the blob up).
//
// JSON follows theme.js conventions: { version, ... }, never-throwing parser
// that names the exact failure, colours "#RRGGBB"/"#AARRGGBB" validated by
// theme.js's validateHexColor; the UI shows the pasted text verbatim before
// anything is imported (plain-text preview).
// ─────────────────────────────────────────────────────────────────────────────

import { validateHexColor } from './theme.js';
import { Cassette } from './cassette/index.js';

export const MIXTAPE_VERSION = 3;
export const MIN_MIXTAPE_VERSION = 1;
const versionOk = (v) => Number.isInteger(v) && v >= MIN_MIXTAPE_VERSION && v <= MIXTAPE_VERSION;
export const MAX_NAME = 40;
export const MAX_TAGLINE = 48;
export const MAX_NOTE = 48;
export const MAX_AUTHOR = 28;

// ── Cassette catalogue: the 37 styles live in src/cassette (single source) ───
export const cassetteStyles = () => Cassette.styles();
export const hasStyle = (id) => typeof id === 'string' && !!Cassette.style(id);
export const PEN_IDS = Object.freeze(Object.keys(Cassette.PENS));
export const hasPen = (id) => PEN_IDS.includes(id);
export const DEFAULT_STYLE_ID = 'clear';
export const DEFAULT_PEN = 'marker';
export const DEFAULT_WEAR = 0.15;
export const DEFAULT_GLOSS = 0.6;

/** Ink colours offered by the label editor (plain hex, so JSON can carry any). */
export const FONT_COLOURS = Object.freeze([
  { id: 'ink',    name: 'Ink',    hex: '#1a1a1f' },
  { id: 'red',    name: 'Red',    hex: '#c0392b' },
  { id: 'blue',   name: 'Blue',   hex: '#1f4fd8' },
  { id: 'green',  name: 'Green',  hex: '#1e7a4a' },
  { id: 'violet', name: 'Violet', hex: '#6d4cff' },
  { id: 'orange', name: 'Orange', hex: '#e07a1f' },
  { id: 'paper',  name: 'Paper',  hex: '#f4efe2' },
  { id: 'white',  name: 'White',  hex: '#ffffff' },
]);

// ── v1/v2 -> v3 migration tables (the old 8 placeholder shells / 6 fonts) ────
// Nearest new style by palette: clear-chrome (smoked clear, red stripe) -> Smoke,
// ferric-red -> Crimson, noir -> Noir, sunburst (amber/orange rays) -> Tangerine,
// neon-grid (deep purple, pink+cyan) -> Lilac, checker -> Checker, waves
// (seafoam) -> Aqua, pastel-dots (pink) -> Bubblegum.
export const LEGACY_STYLE_MAP = Object.freeze({
  'clear-chrome': 'smoke', 'ferric-red': 'crimson', 'noir': 'noir', 'sunburst': 'tangerine',
  'neon-grid': 'lilac', 'checker': 'checker', 'waves': 'aqua', 'pastel-dots': 'bubblegum',
});
// Old font ids -> nearest pen (marker/script/type/bold).
export const LEGACY_FONT_MAP = Object.freeze({
  marker: 'marker', typewriter: 'type', serif: 'script', sans: 'bold', condensed: 'bold', mono: 'type',
});
const LEGACY_DEFAULT_INK = '#1a1a1f'; // the old default font colour: "no override"

// ── Track refs ───────────────────────────────────────────────────────────────
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** The identity a ref is matched on. */
export function trackKey(t) {
  return `${norm(t.artist)}\0${norm(t.album)}\0${norm(t.title)}`;
}

/** A library track (or any {title, artist, album}) -> a persistable ref. */
export function makeTrackRef(t) {
  const ref = {
    title: String(t.title || '').trim() || 'Untitled',
    artist: String(t.artist || '').trim(),
    album: String(t.album || '').trim(),
  };
  if (typeof t.id === 'string' && t.id && t.id.length <= 64) ref.id = t.id;
  return ref;
}

/**
 * Match refs to live library tracks. Returns an array parallel to
 * mixtape.tracks: the library track, or null when it isn't in the library
 * right now. Exact (artist, album, title) first; falls back to (artist, title)
 * so a re-tagged album still finds its tracks. Each library track is used at
 * most once per exact pass, but a tape may list the same song twice.
 */
export function resolveTracks(mixtape, libraryTracks) {
  const byId = new Map();
  const exact = new Map();
  const loose = new Map();
  // A track that needs re-link (no File yet) loses to a live one with the same key.
  const put = (m, k, t) => {
    const cur = m.get(k);
    if (!cur || (cur.relink && !t.relink)) m.set(k, t);
  };
  for (const t of libraryTracks) {
    if (typeof t.id === 'string' && t.id) put(byId, t.id, t);
    put(exact, trackKey(t), t);
    put(loose, `${norm(t.artist)}\0${norm(t.title)}`, t);
  }
  return mixtape.tracks.map((r) =>
    (r.id && byId.get(r.id)) || exact.get(trackKey(r)) || loose.get(`${norm(r.artist)}\0${norm(r.title)}`) || null);
}

// ── Construction + pure edits (all return NEW mixtapes) ──────────────────────

const clamp01 = (v, d) => (typeof v === 'number' && isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : d);
const str = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

export function cleanName(name) {
  const n = str(name, MAX_NAME);
  return n || 'Untitled Mixtape';
}

/** Valid hex or null ("use the style's own ink"). */
const inkOf = (hex) => (typeof hex === 'string' && validateHexColor(hex, 'ink') === null ? hex : null);

function cleanCfg(c = {}, legacy = {}) {
  const style = hasStyle(c.style) ? c.style
    : (legacy.styleId && LEGACY_STYLE_MAP[legacy.styleId]) || (hasStyle(legacy.styleId) ? legacy.styleId : DEFAULT_STYLE_ID);
  const pen = hasPen(c.pen) ? c.pen : (legacy.fontId && LEGACY_FONT_MAP[legacy.fontId]) || DEFAULT_PEN;
  let ink = inkOf(c.slots && c.slots.ink);
  if (!ink && legacy.fontColor) {
    const lc = inkOf(legacy.fontColor);
    ink = lc && lc.toLowerCase() !== LEGACY_DEFAULT_INK ? lc : null;
  }
  const t = c.text || {};
  const cfg = {
    style, pen,
    wear: clamp01(c.wear, DEFAULT_WEAR),
    gloss: clamp01(c.gloss, DEFAULT_GLOSS),
    text: { subtitle: str(t.subtitle, MAX_TAGLINE), note: str(t.note, MAX_NOTE), side: (str(t.side, 2) || 'A').toUpperCase() },
  };
  if (ink) cfg.slots = { ink };
  return cfg;
}

/**
 * `id` is a parameter (not generated here) so the model stays deterministic.
 * Accepts the v3 shape ({name, author, cfg, tracks}) and, for migration, the
 * v1/v2 fields {styleId, fontId, fontColor}.
 */
export function createMixtape({ id, name, author, tracks = [], cfg, styleId, fontId, fontColor } = {}) {
  return {
    id: id || 'mt-0',
    name: cleanName(name),
    author: str(author, MAX_AUTHOR),
    tracks: tracks.map(makeTrackRef),
    cfg: cleanCfg(cfg, { styleId, fontId, fontColor }),
  };
}

export const withName = (m, name) => ({ ...m, name: cleanName(name) });
export const withAuthor = (m, a) => ({ ...m, author: str(a, MAX_AUTHOR) });
export const withStyle = (m, styleId) => (hasStyle(styleId) ? { ...m, cfg: { ...m.cfg, style: styleId } } : m);
export const withPen = (m, pen) => (hasPen(pen) ? { ...m, cfg: { ...m.cfg, pen } } : m);
export const withWear = (m, v) => ({ ...m, cfg: { ...m.cfg, wear: clamp01(v, m.cfg.wear) } });
export const withGloss = (m, v) => ({ ...m, cfg: { ...m.cfg, gloss: clamp01(v, m.cfg.gloss) } });
/** hex -> ink override; null/'' -> back to the style's own ink; bad hex -> unchanged. */
export function withInk(m, hex) {
  if (hex == null || hex === '') { const { slots, ...rest } = m.cfg; return { ...m, cfg: rest }; }
  return inkOf(hex) ? { ...m, cfg: { ...m.cfg, slots: { ...(m.cfg.slots || {}), ink: hex } } } : m;
}
/** patch any of {subtitle, note, side}. */
export function withText(m, patch) {
  return { ...m, cfg: { ...m.cfg, text: cleanCfg({ text: { ...m.cfg.text, ...patch } }).text } };
}
export const inkHex = (m) => (m.cfg.slots && m.cfg.slots.ink) || null;
export const addTrack = (m, t) => ({ ...m, tracks: [...m.tracks, makeTrackRef(t)] });
export const removeTrack = (m, i) =>
  (i >= 0 && i < m.tracks.length ? { ...m, tracks: m.tracks.filter((_, j) => j !== i) } : m);

/** Move track `from` to index `to` (clamped). Out-of-range `from` is a no-op. */
export function moveTrack(m, from, to) {
  const n = m.tracks.length;
  if (from < 0 || from >= n) return m;
  const dest = Math.max(0, Math.min(n - 1, to));
  if (dest === from) return m;
  const tracks = m.tracks.slice();
  const [t] = tracks.splice(from, 1);
  tracks.splice(dest, 0, t);
  return { ...m, tracks };
}

/** The label note the cassette prints when the user left it blank. */
export function autoNote(m) {
  const n = m.tracks.length;
  return `Side ${m.cfg.text.side || 'A'} · ${n} ${n === 1 ? 'song' : 'songs'}`;
}

/** Mixtape -> the cfg the Cassette renderer takes (title = name, blank note = auto). */
export function cassetteCfg(m, extra = {}) {
  const t = m.cfg.text;
  return {
    style: m.cfg.style, pen: m.cfg.pen, wear: m.cfg.wear, gloss: m.cfg.gloss,
    ...(m.cfg.slots ? { slots: { ...m.cfg.slots } } : {}),
    seed: m.id,
    text: { title: m.name, subtitle: t.subtitle, note: t.note || autoNote(m), side: t.side || 'A' },
    ...extra,
  };
}

// ── Tape reels: radius is a pure function of progress ────────────────────────
// Tape is conserved: area moved off the supply reel lands on the take-up reel,
// so rSupply² + rTake² is constant. Start: supply full (rMax), take-up bare
// (rMin); end: swapped. Radii therefore change with sqrt, not linearly, which
// is what a real cassette looks like (the take-up reel visibly "catches up").

/** progress in [0,1] (clamped) -> { supply, take } radii. */
export function reelRadii(progress, rMin, rMax) {
  const p = progress > 0 ? (progress < 1 ? progress : 1) : 0; // NaN -> 0
  const swing = rMax * rMax - rMin * rMin;
  return {
    supply: Math.sqrt(rMax * rMax - p * swing),
    take: Math.sqrt(rMin * rMin + p * swing),
  };
}

/**
 * Whole-tape progress from the playing position.
 *   index: current track index, n: track count, frac: progress inside the
 *   current track, durations (optional, seconds per track): when every entry is
 *   a positive finite number the tape is time-weighted, otherwise each track
 *   counts equally (durations of un-decoded tracks aren't known up front).
 */
export function tapeProgress(index, n, frac, durations) {
  if (!(n > 0)) return 0;
  const f = frac > 0 ? (frac < 1 ? frac : 1) : 0;
  const i = Math.max(0, Math.min(n - 1, index | 0));
  if (durations && durations.length === n && durations.every((d) => d > 0 && isFinite(d))) {
    const total = durations.reduce((a, b) => a + b, 0);
    let before = 0;
    for (let j = 0; j < i; j++) before += durations[j];
    return (before + f * durations[i]) / total;
  }
  return (i + f) / n;
}


/** Estimated total tape length in seconds (unknown durations -> mean of the known, else 4 min). */
export function estimateTapeSeconds(durations, n) {
  const ok = (durations || []).filter((d) => d > 0 && isFinite(d));
  const mean = ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : 240;
  let total = 0;
  for (let i = 0; i < n; i++) total += durations && durations[i] > 0 && isFinite(durations[i]) ? durations[i] : mean;
  return total;
}

/**
 * Inverse of tapeProgress: whole-tape progress -> { index, frac }. Uses the same
 * weighting (time-weighted when every duration is known, else equal).
 */
export function locateTape(p, n, durations) {
  if (!(n > 0)) return { index: 0, frac: 0 };
  const q = p > 0 ? (p < 1 ? p : 1) : 0;
  const timed = durations && durations.length === n && durations.every((d) => d > 0 && isFinite(d));
  if (!timed) {
    const x = q * n, i = Math.min(n - 1, Math.floor(x));
    return { index: i, frac: x - i };
  }
  const total = durations.reduce((a, b) => a + b, 0);
  let acc = 0, x = q * total;
  for (let i = 0; i < n; i++) {
    if (x <= acc + durations[i] || i === n - 1) return { index: i, frac: Math.max(0, Math.min(1, (x - acc) / durations[i])) };
    acc += durations[i];
  }
  return { index: n - 1, frac: 1 };
}

// ── JSON (theme.js conventions) ──────────────────────────────────────────────

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const refOut = (t) => (t.id
  ? { title: t.title, artist: t.artist, album: t.album, id: t.id }
  : { title: t.title, artist: t.artist, album: t.album });

const cfgOut = (m) => ({
  style: m.cfg.style, pen: m.cfg.pen, wear: m.cfg.wear, gloss: m.cfg.gloss,
  ...(m.cfg.slots ? { slots: { ...m.cfg.slots } } : {}),
  text: { subtitle: m.cfg.text.subtitle, note: m.cfg.text.note, side: m.cfg.text.side },
});

/** One mixtape -> pretty JSON text (what the UI previews verbatim). */
export function serializeMixtape(m) {
  return JSON.stringify({
    version: MIXTAPE_VERSION,
    name: m.name,
    author: m.author,
    cfg: cfgOut(m),
    tracks: m.tracks.map(refOut),
  }, null, 2);
}

/**
 * Parse + validate one mixtape document (v1, v2 or v3). Never throws; returns
 * { ok: true, mixtape } or { ok: false, error } naming the exact problem.
 * Unknown style/pen ids are an error (like a bad hex in theme.js) rather than
 * silently substituted, so a pasted tape never changes under the user. v1/v2
 * documents carry the old placeholder style/font ids and migrate through
 * LEGACY_*_MAP (an id in neither table is an error).
 */
export function parseMixtape(text, { id } = {}) {
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { return { ok: false, error: `Not valid JSON: ${e.message}` }; }
  return parseMixtapeObject(raw, { id });
}

function parseMixtapeObject(raw, { id } = {}) {
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'Mixtape must be a JSON object (got ' + (Array.isArray(raw) ? 'an array' : typeof raw) + ').' };
  }
  if (!('version' in raw)) return { ok: false, error: `Missing "version" field (expected ${MIN_MIXTAPE_VERSION}..${MIXTAPE_VERSION}).` };
  if (!versionOk(raw.version)) {
    return { ok: false, error: `Unsupported "version": ${JSON.stringify(raw.version)} (expected ${MIN_MIXTAPE_VERSION}..${MIXTAPE_VERSION}).` };
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) return { ok: false, error: 'Missing "name" (a non-empty string).' };
  let cfg, legacy = {};
  if (raw.version >= 3) {
    if (!isPlainObject(raw.cfg)) return { ok: false, error: 'Missing "cfg" object.' };
    cfg = raw.cfg;
    if (!hasStyle(cfg.style)) {
      return { ok: false, error: `Unknown "cfg.style": ${JSON.stringify(cfg.style)} (one of ${cassetteStyles().map((s) => s.id).join(', ')}).` };
    }
    if (!hasPen(cfg.pen)) {
      return { ok: false, error: `Unknown "cfg.pen": ${JSON.stringify(cfg.pen)} (one of ${PEN_IDS.join(', ')}).` };
    }
    if (cfg.slots && isPlainObject(cfg.slots) && cfg.slots.ink != null) {
      const colErr = validateHexColor(cfg.slots.ink, 'cfg.slots.ink');
      if (colErr) return { ok: false, error: colErr };
    }
  } else {
    if (!(raw.style in LEGACY_STYLE_MAP)) {
      return { ok: false, error: `Unknown "style": ${JSON.stringify(raw.style)} (one of ${Object.keys(LEGACY_STYLE_MAP).join(', ')}).` };
    }
    if (!(raw.font in LEGACY_FONT_MAP)) {
      return { ok: false, error: `Unknown "font": ${JSON.stringify(raw.font)} (one of ${Object.keys(LEGACY_FONT_MAP).join(', ')}).` };
    }
    const colErr = validateHexColor(raw.fontColor, 'fontColor');
    if (colErr) return { ok: false, error: colErr };
    legacy = { styleId: raw.style, fontId: raw.font, fontColor: raw.fontColor };
  }
  if (!Array.isArray(raw.tracks)) return { ok: false, error: 'Missing "tracks" array.' };
  for (let i = 0; i < raw.tracks.length; i++) {
    const t = raw.tracks[i];
    if (!isPlainObject(t) || typeof t.title !== 'string' || !t.title.trim()) {
      return { ok: false, error: `Invalid "tracks[${i}]": needs a non-empty "title".` };
    }
  }
  return { ok: true, mixtape: createMixtape({ id, name: raw.name, author: raw.author, tracks: raw.tracks, cfg, ...legacy }) };
}

// ── One-way import of the owner's standalone Mixtape Deck data ───────────────
// The handoff app kept {items:[{id, cfg:{style,pen,wear,gloss,text{title,...}},
// tracks:[{title,artist,album}], author}]} under localStorage 'mixtape-deck:v1'.
// Runout does NOT adopt that shape or key; this reads it once, tolerantly.

/** One handoff item -> mixtape (title becomes the name), or null if unusable. */
export function fromDeckItem(it, { id } = {}) {
  if (!isPlainObject(it) || !isPlainObject(it.cfg)) return null;
  const c = it.cfg, t = isPlainObject(c.text) ? c.text : {};
  const tracks = (Array.isArray(it.tracks) ? it.tracks : [])
    .map((x) => (typeof x === 'string' ? { title: x } : x))
    .filter((x) => isPlainObject(x) && typeof x.title === 'string' && x.title.trim());
  return createMixtape({
    id: id || (typeof it.id === 'string' ? it.id : undefined),
    name: t.title, author: it.author, tracks,
    cfg: { style: c.style, pen: c.pen, wear: c.wear, gloss: c.gloss, slots: c.slots, text: { subtitle: t.subtitle, note: t.note, side: t.side } },
  });
}

/**
 * Import text in any supported shape: one Runout mixtape (v1-v3), a Runout
 * collection, a handoff deck blob ({items}) or a single handoff item.
 * Returns { ok, mixtapes[] } | { ok:false, error }. `newId()` supplies ids.
 */
export function parseImport(text, { newId } = {}) {
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { return { ok: false, error: `Not valid JSON: ${e.message}` }; }
  const mk = (() => { let n = 0; return () => (newId ? newId(n++) : `imp-${n++}`); })();
  if (isPlainObject(raw) && Array.isArray(raw.items)) {
    const list = raw.items.map((it) => fromDeckItem(it, { id: mk() })).filter(Boolean);
    return list.length ? { ok: true, mixtapes: list, source: 'deck' } : { ok: false, error: 'No usable mixtapes in "items".' };
  }
  if (isPlainObject(raw) && !('version' in raw) && isPlainObject(raw.cfg)) {
    const m = fromDeckItem(raw, { id: mk() });
    return m ? { ok: true, mixtapes: [m], source: 'deck' } : { ok: false, error: 'Not a mixtape.' };
  }
  if (isPlainObject(raw) && Array.isArray(raw.mixtapes)) {
    const list = parseCollection(text).map((m) => ({ ...m, id: mk() }));
    return list.length ? { ok: true, mixtapes: list, source: 'collection' } : { ok: false, error: 'No usable mixtapes in "mixtapes".' };
  }
  const r = parseMixtapeObject(raw, { id: mk() });
  return r.ok ? { ok: true, mixtapes: [r.mixtape], source: 'mixtape' } : r;
}

// ── Persistence payload (localStorage 'runout.mixtapes') ─────────────────────

export const STORAGE_KEY = 'runout.mixtapes';

export function serializeCollection(list) {
  return JSON.stringify({
    version: MIXTAPE_VERSION,
    mixtapes: list.map((m) => ({
      id: m.id, name: m.name, author: m.author, cfg: cfgOut(m), tracks: m.tracks.map(refOut),
    })),
  });
}

/**
 * Tolerant: a corrupt blob reads as empty; bad entries are dropped, good ones kept.
 * v1/v2 blobs migrate in place (style/font/colour -> nearest new style/pen; refs
 * keep their ids); the next save writes v3. A blob from a NEWER version reads as
 * empty here; callers that would overwrite it should check isFutureCollection
 * first (mixtape-ui.js keeps a backup, and also keeps one of a pre-v3 blob).
 */
export function parseCollection(text) {
  if (!text) return [];
  let raw;
  try { raw = JSON.parse(text); } catch { return []; }
  if (!isPlainObject(raw) || !versionOk(raw.version) || !Array.isArray(raw.mixtapes)) return [];
  const out = [];
  for (const e of raw.mixtapes) {
    if (!isPlainObject(e) || typeof e.id !== 'string' || !Array.isArray(e.tracks)) continue;
    out.push(createMixtape({
      id: e.id, name: e.name, author: e.author, tracks: e.tracks.filter((t) => isPlainObject(t)),
      ...(raw.version >= 3
        ? { cfg: isPlainObject(e.cfg) ? e.cfg : {} }
        : { styleId: e.style, fontId: e.font, fontColor: e.fontColor }),
    }));
  }
  return out;
}

/** Version number of a well-formed collection blob, else null. */
export function collectionVersion(text) {
  try { const r = JSON.parse(text); return isPlainObject(r) && Number.isInteger(r.version) ? r.version : null; }
  catch { return null; }
}

/** True when `text` is a well-formed collection written by a newer app version. */
export function isFutureCollection(text) {
  const v = collectionVersion(text);
  return v !== null && v > MIXTAPE_VERSION;
}

/** Collision-free id from a clock + a random draw (both injected by the caller). */
export function newMixtapeId(nowMs, rand01, existing = []) {
  const taken = new Set(existing.map((m) => m.id));
  let id = `mt-${Math.floor(nowMs).toString(36)}-${Math.floor(rand01 * 1296).toString(36)}`;
  while (taken.has(id)) id += 'x';
  return id;
}
