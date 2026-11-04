// ─────────────────────────────────────────────────────────────────────────────
// mixtape.js — pure mixtape model: custom playlists with a cassette look.
//
// No DOM / browser globals (portable like model.js; tested in
// test/mixtape.test.mjs). Drawing lives in cassette.js, UI + persistence glue
// in mixtape-ui.js.
//
// A mixtape = name + ordered track REFS + style variant id + font id + font
// colour. Refs are metadata ({title, artist, album}), not file handles: a
// browser can't persist a File across sessions, so a ref is matched back to
// the library at play time (resolveTracks): stable track id first (libindex.js:
// hash of tags + size/duration), then exact (artist, album, title), then loose
// (artist, title). The library itself is persisted as metadata, so a ref
// usually resolves to a "needs re-link" track (no File yet) rather than to
// nothing; unmatched refs stay in the tape, shown as unavailable.
//
// JSON follows theme.js conventions: { version, ... }, never-throwing parser
// that names the exact failure, colours as "#RRGGBB"/"#AARRGGBB" validated by
// theme.js's validateHexColor; the UI shows the pasted text verbatim before
// anything is imported (plain-text preview).
// ─────────────────────────────────────────────────────────────────────────────

import { validateHexColor } from './theme.js';

// v1: refs {title, artist, album}. v2: refs may also carry `id` (stable track
// id from libindex.js). Writers emit v2; readers accept v1 and v2 (a v1 doc is
// a valid v2 doc with no ids). Anything newer is refused/ignored, never guessed.
export const MIXTAPE_VERSION = 2;
export const MIN_MIXTAPE_VERSION = 1;
const versionOk = (v) => Number.isInteger(v) && v >= MIN_MIXTAPE_VERSION && v <= MIXTAPE_VERSION;
export const MAX_NAME = 40;

// ── Procedural cassette shell styles (drawn in cassette.js; no image assets) ─
// `pattern` picks a drawing routine; the colours feed it. Add a style by adding
// a row here (and, for a new pattern, a case in cassette.js).
export const CASSETTE_STYLES = Object.freeze([
  { id: 'clear-chrome', name: 'Clear Chrome',   pattern: 'clear',   shell: '#2a2d33', shell2: '#4a4f58', label: '#ece6d3', stripe: '#c0392b', accent: '#b9c2cf' },
  { id: 'ferric-red',   name: 'Ferric Red',     pattern: 'solid',   shell: '#8e1f1f', shell2: '#c0392b', label: '#f4efe2', stripe: '#1b1b1b', accent: '#e8c9a0' },
  { id: 'noir',         name: 'Noir Matte',     pattern: 'solid',   shell: '#151517', shell2: '#2a2a2e', label: '#d9d9d2', stripe: '#8E7BFF', accent: '#777777' },
  { id: 'sunburst',     name: 'Sunburst',       pattern: 'rays',    shell: '#e8a02e', shell2: '#d2542c', label: '#fff4d6', stripe: '#6b2a14', accent: '#ffd98a' },
  { id: 'neon-grid',    name: 'Neon Grid',      pattern: 'grid',    shell: '#140a2e', shell2: '#3c1470', label: '#1d1038', stripe: '#ff3cac', accent: '#2de2e6' },
  { id: 'checker',      name: 'Checker',        pattern: 'checker', shell: '#1b3a5c', shell2: '#f0f0f0', label: '#fafafa', stripe: '#1b3a5c', accent: '#e63946' },
  { id: 'waves',        name: 'Seafoam Waves',  pattern: 'waves',   shell: '#1f7a8c', shell2: '#bfdbf7', label: '#f6fbfb', stripe: '#022b3a', accent: '#e1e5f2' },
  { id: 'pastel-dots',  name: 'Pastel Dots',    pattern: 'dots',    shell: '#f7c8d8', shell2: '#fff1f5', label: '#ffffff', stripe: '#a2678a', accent: '#cfe8ef' },
]);

// ── Fonts: system stacks only (no downloads, works offline in the WebView) ──
export const FONTS = Object.freeze([
  { id: 'marker',     name: 'Marker',     css: '"Marker Felt","Segoe Print","Comic Sans MS","Comic Neue",cursive', weight: 700, style: 'normal' },
  { id: 'typewriter', name: 'Typewriter', css: '"American Typewriter","Courier New",Courier,monospace', weight: 400, style: 'normal' },
  { id: 'serif',      name: 'Serif',      css: 'Georgia,"Times New Roman",serif', weight: 700, style: 'italic' },
  { id: 'sans',       name: 'Sans',       css: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif', weight: 800, style: 'normal' },
  { id: 'condensed',  name: 'Condensed',  css: '"Arial Narrow","Roboto Condensed","Helvetica Neue",Arial,sans-serif', weight: 700, style: 'normal' },
  { id: 'mono',       name: 'Mono',       css: 'ui-monospace,"SF Mono",Menlo,Consolas,monospace', weight: 700, style: 'normal' },
]);

// ── Font colours: plain hex, so a user can also paste their own in JSON ─────
export const FONT_COLOURS = Object.freeze([
  { id: 'ink',     name: 'Ink',     hex: '#1a1a1f' },
  { id: 'red',     name: 'Red',     hex: '#c0392b' },
  { id: 'blue',    name: 'Blue',    hex: '#1f4fd8' },
  { id: 'green',   name: 'Green',   hex: '#1e7a4a' },
  { id: 'violet',  name: 'Violet',  hex: '#6d4cff' },
  { id: 'orange',  name: 'Orange',  hex: '#e07a1f' },
  { id: 'paper',   name: 'Paper',   hex: '#f4efe2' },
  { id: 'neon',    name: 'Neon',    hex: '#2de2e6' },
]);

export const DEFAULT_STYLE_ID = CASSETTE_STYLES[0].id;
export const DEFAULT_FONT_ID = FONTS[0].id;
export const DEFAULT_FONT_COLOUR = FONT_COLOURS[0].hex;

export const styleById = (id) => CASSETTE_STYLES.find((s) => s.id === id) || CASSETTE_STYLES[0];
export const fontById = (id) => FONTS.find((f) => f.id === id) || FONTS[0];

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

/** `id` is a parameter (not generated here) so the model stays deterministic. */
export function createMixtape({ id, name, tracks = [], styleId, fontId, fontColor } = {}) {
  return {
    id: id || 'mt-0',
    name: cleanName(name),
    tracks: tracks.map(makeTrackRef),
    styleId: styleById(styleId).id,
    fontId: fontById(fontId).id,
    fontColor: validateHexColor(fontColor, 'fontColor') === null ? fontColor : DEFAULT_FONT_COLOUR,
  };
}

export function cleanName(name) {
  const n = String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return n || 'Untitled Mixtape';
}

export const withName = (m, name) => ({ ...m, name: cleanName(name) });
export const withStyle = (m, styleId) => ({ ...m, styleId: styleById(styleId).id });
export const withFont = (m, fontId) => ({ ...m, fontId: fontById(fontId).id });
export const withFontColor = (m, hex) =>
  validateHexColor(hex, 'fontColor') === null ? { ...m, fontColor: hex } : m;
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

// ── JSON (theme.js conventions) ──────────────────────────────────────────────

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** One mixtape -> pretty JSON text (what the UI previews verbatim). */
export function serializeMixtape(m) {
  return JSON.stringify({
    version: MIXTAPE_VERSION,
    name: m.name,
    style: m.styleId,
    font: m.fontId,
    fontColor: m.fontColor,
    tracks: m.tracks.map((t) => (t.id
      ? { title: t.title, artist: t.artist, album: t.album, id: t.id }
      : { title: t.title, artist: t.artist, album: t.album })),
  }, null, 2);
}

/**
 * Parse + validate one mixtape document. Never throws; returns
 * { ok: true, mixtape } or { ok: false, error } naming the exact problem.
 * Unknown style/font ids are an error (like a bad hex in theme.js) rather than
 * silently substituted, so a pasted tape never changes under the user.
 */
export function parseMixtape(text, { id } = {}) {
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { return { ok: false, error: `Not valid JSON: ${e.message}` }; }
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'Mixtape must be a JSON object (got ' + (Array.isArray(raw) ? 'an array' : typeof raw) + ').' };
  }
  if (!('version' in raw)) return { ok: false, error: `Missing "version" field (expected ${MIN_MIXTAPE_VERSION} or ${MIXTAPE_VERSION}).` };
  if (!versionOk(raw.version)) {
    return { ok: false, error: `Unsupported "version": ${JSON.stringify(raw.version)} (expected ${MIN_MIXTAPE_VERSION} or ${MIXTAPE_VERSION}).` };
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) return { ok: false, error: 'Missing "name" (a non-empty string).' };
  if (!CASSETTE_STYLES.some((s) => s.id === raw.style)) {
    return { ok: false, error: `Unknown "style": ${JSON.stringify(raw.style)} (one of ${CASSETTE_STYLES.map((s) => s.id).join(', ')}).` };
  }
  if (!FONTS.some((f) => f.id === raw.font)) {
    return { ok: false, error: `Unknown "font": ${JSON.stringify(raw.font)} (one of ${FONTS.map((f) => f.id).join(', ')}).` };
  }
  const colErr = validateHexColor(raw.fontColor, 'fontColor');
  if (colErr) return { ok: false, error: colErr };
  if (!Array.isArray(raw.tracks)) return { ok: false, error: 'Missing "tracks" array.' };
  for (let i = 0; i < raw.tracks.length; i++) {
    const t = raw.tracks[i];
    if (!isPlainObject(t) || typeof t.title !== 'string' || !t.title.trim()) {
      return { ok: false, error: `Invalid "tracks[${i}]": needs a non-empty "title".` };
    }
  }
  return {
    ok: true,
    mixtape: createMixtape({
      id, name: raw.name, tracks: raw.tracks, styleId: raw.style, fontId: raw.font, fontColor: raw.fontColor,
    }),
  };
}

// ── Persistence payload (localStorage 'runout.mixtapes') ─────────────────────

export const STORAGE_KEY = 'runout.mixtapes';

export function serializeCollection(list) {
  return JSON.stringify({
    version: MIXTAPE_VERSION,
    mixtapes: list.map((m) => ({
      id: m.id, name: m.name, style: m.styleId, font: m.fontId, fontColor: m.fontColor,
      tracks: m.tracks,
    })),
  });
}

/**
 * Tolerant: a corrupt blob reads as empty; bad entries are dropped, good ones kept.
 * v1 blobs migrate in place (refs just have no id); the next save writes v2.
 * A blob from a NEWER version reads as empty here; callers that would
 * overwrite it should check isFutureCollection first (mixtape-ui.js keeps a backup).
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
      id: e.id, name: e.name, tracks: e.tracks.filter((t) => isPlainObject(t)),
      styleId: e.style, fontId: e.font, fontColor: e.fontColor,
    }));
  }
  return out;
}

/** True when `text` is a well-formed collection written by a newer app version. */
export function isFutureCollection(text) {
  try { const r = JSON.parse(text); return isPlainObject(r) && Number.isInteger(r.version) && r.version > MIXTAPE_VERSION; }
  catch { return false; }
}

/** Collision-free id from a clock + a random draw (both injected by the caller). */
export function newMixtapeId(nowMs, rand01, existing = []) {
  const taken = new Set(existing.map((m) => m.id));
  let id = `mt-${Math.floor(nowMs).toString(36)}-${Math.floor(rand01 * 1296).toString(36)}`;
  while (taken.has(id)) id += 'x';
  return id;
}
