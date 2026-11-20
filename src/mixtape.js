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
//   v4  a real cassette: `tape {length: C30|C60|C90}`, TWO SIDES
//       `sides {A:[refs], B:[refs]}`, `autoReverse`, refs may carry a duration
//       hint `dur` (seconds) and every side has a hard capacity (see CAPS).
//       `m.tracks` is kept as the derived flat list (A then B) so the
//       resolver / queue code that predates sides keeps working.
// Writers emit v4; readers accept v1..v4. v1/v2 style/font/colour ids migrate
// to the nearest new style / pen (LEGACY_* tables below); a v1-v3 single list
// migrates to side A on a C60 (a C90 when it does not fit) (spilling to side B
// only when even a C90 side A cannot, and never dropping a song). Anything
// newer than v4 is refused/ignored, never guessed (the UI backs the blob up).
//
// JSON follows theme.js conventions: { version, ... }, never-throwing parser
// that names the exact failure, colours "#RRGGBB"/"#AARRGGBB" validated by
// theme.js's validateHexColor; the UI shows the pasted text verbatim before
// anything is imported (plain-text preview).
// ─────────────────────────────────────────────────────────────────────────────

import { validateHexColor } from './theme.js';
import { Cassette } from './cassette/index.js';

export const MIXTAPE_VERSION = 4;
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

// ── Tape CAPS (the owner asked for fixed maxima) ─────────────────────────────
// Each tape length is a real cassette: C30 = 15 min per side, C60 = 30, C90 = 45.
// Tolerance is 0 seconds: a song that does not fit is refused, never squeezed.
// On top of the time cap there is a hard 20-songs-per-side limit (40 per tape).
export const TAPES = Object.freeze({
  C30: Object.freeze({ id: 'C30', name: 'C30', minutes: 30, sideSec: 15 * 60 }),
  C60: Object.freeze({ id: 'C60', name: 'C60', minutes: 60, sideSec: 30 * 60 }),
  C90: Object.freeze({ id: 'C90', name: 'C90', minutes: 90, sideSec: 45 * 60 }),
});
export const TAPE_IDS = Object.freeze(Object.keys(TAPES));
export const DEFAULT_TAPE = 'C60';
export const MAX_SONGS_PER_SIDE = 20;
export const TOLERANCE_SEC = 0;
export const UNKNOWN_DURATION_SEC = 240;     // conservative estimate, shown with '~'
export const MAX_DUR_SEC = 24 * 3600;        // hint sanity bound
export const SIDES = Object.freeze(['A', 'B']);
export const hasTape = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(TAPES, id);
export const isSide = (s) => s === 'A' || s === 'B';

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
  const d = cleanDur(t.dur != null ? t.dur : t.durationSec);
  if (d) ref.dur = d;
  return ref;
}

/** A duration hint in whole seconds (rounded UP so a tape is never over-filled), or 0 when unusable. */
export function cleanDur(v) {
  return typeof v === 'number' && isFinite(v) && v > 0 && v <= MAX_DUR_SEC ? Math.ceil(v - 1e-9) : 0;
}
/** { sec, est } of one ref: its hint, else the conservative 4:00 estimate (est = true). */
export function refSeconds(ref) {
  const d = cleanDur(ref && ref.dur);
  return d ? { sec: d, est: false } : { sec: UNKNOWN_DURATION_SEC, est: true };
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

// ── Sides, caps, pure side edits ────────────────────────────────────────────
const cleanRefs = (arr) => (Array.isArray(arr) ? arr : []).filter((t) => t && typeof t === 'object' && !Array.isArray(t)).map(makeTrackRef);

/** Seconds a list of refs occupies (unknown durations count as the 4:00 estimate). */
export function listSeconds(refs) { return refs.reduce((a, r) => a + refSeconds(r).sec, 0); }

/** The sides a mixtape has, with the flat `tracks` list re-derived. The ONE place `tracks` is written. */
function withSides(m, A, B) {
  return { ...m, sides: { A, B }, tracks: [...A, ...B] };
}

/** Per-side capacity in seconds for this tape. */
export const sideCapacity = (m) => TAPES[m.tape.length].sideSec;
export const sideRefs = (m, side) => m.sides[side === 'B' ? 'B' : 'A'];

/** { sec, est, count } — est is true when any song on the side has no real duration yet. */
export function sideInfo(m, side) {
  const refs = sideRefs(m, side);
  let sec = 0, est = false;
  for (const r of refs) { const d = refSeconds(r); sec += d.sec; if (d.est) est = true; }
  return { sec, est, count: refs.length };
}
export const sideDuration = (m, side) => sideInfo(m, side).sec;
/** Free space on a side: { sec, slots } (never negative). */
export function remaining(m, side) {
  const i = sideInfo(m, side);
  return { sec: Math.max(0, sideCapacity(m) - i.sec), slots: Math.max(0, MAX_SONGS_PER_SIDE - i.count) };
}
/** True when a side holds more than its caps allow (only reachable by migration or by a decoded real duration). */
export const isOverCap = (m, side) => {
  if (!side) return isOverCap(m, 'A') || isOverCap(m, 'B');
  const i = sideInfo(m, side);
  return i.sec > sideCapacity(m) || i.count > MAX_SONGS_PER_SIDE;
};
export const tapeSeconds = (m) => sideDuration(m, 'A') + sideDuration(m, 'B');
export const songCount = (m) => m.sides.A.length + m.sides.B.length;

/** 4:05 / 1:02:03 */
export function fmtDur(sec, est = false) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const body = h ? `${h}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
  return (est ? '~' : '') + body;
}

/**
 * Can `track` (library track or ref) go on `side`? -> { ok, reason, code }.
 * Zero tolerance: used + duration must be <= capacity. A reason is a sentence
 * the UI shows verbatim ("Side A has 2:10 left; this song is 3:45").
 */
export function canAdd(m, side, track, { extraSec = 0, extraCount = 0 } = {}) {
  if (!isSide(side)) return { ok: false, code: 'side', reason: 'Pick side A or B.' };
  const info = sideInfo(m, side), d = refSeconds(makeTrackRef(track || {}));
  if (info.count + extraCount >= MAX_SONGS_PER_SIDE) {
    return { ok: false, code: 'count', reason: `Side ${side} is full: ${MAX_SONGS_PER_SIDE} songs is the most a side holds.` };
  }
  const left = sideCapacity(m) - info.sec - extraSec;
  if (d.sec > left) {
    const l = Math.max(0, left);
    return { ok: false, code: 'time', reason: `Side ${side} has ${fmtDur(l)} left; this song is ${fmtDur(d.sec, d.est)}.` };
  }
  return { ok: true, code: 'ok', reason: '' };
}

/** Append to a side if it fits (else unchanged). Use tryAdd when the reason matters. */
export function addTrack(m, t, side = 'A') { return tryAdd(m, side, t).mixtape; }

/** { mixtape, ok, reason } — add at the end of `side` (or at `index`). */
export function tryAdd(m, side, t, index) {
  const c = canAdd(m, side, t);
  if (!c.ok) return { mixtape: m, ...c };
  const ref = makeTrackRef(t), list = sideRefs(m, side).slice();
  const at = Number.isInteger(index) ? Math.max(0, Math.min(list.length, index)) : list.length;
  list.splice(at, 0, ref);
  return { mixtape: side === 'B' ? withSides(m, m.sides.A, list) : withSides(m, list, m.sides.B), ok: true, code: 'ok', reason: '' };
}

/**
 * Add several in order; each that fits goes on, the rest are skipped with a reason.
 * -> { mixtape, added, skipped: [{ track, reason, code }] }
 */
export function addMany(m, side, tracks) {
  let cur = m, added = 0;
  const skipped = [];
  for (const t of tracks) {
    const r = tryAdd(cur, side, t);
    if (r.ok) { cur = r.mixtape; added++; } else skipped.push({ track: t, reason: r.reason, code: r.code });
  }
  return { mixtape: cur, added, skipped };
}

/** Remove the song at `i` of `side`. */
export function removeFromSide(m, side, i) {
  if (!isSide(side)) return m;
  const list = sideRefs(m, side);
  if (!(i >= 0 && i < list.length)) return m;
  const next = list.filter((_, j) => j !== i);
  return side === 'B' ? withSides(m, m.sides.A, next) : withSides(m, next, m.sides.B);
}
/** Legacy flat-index remove (A then B). */
export function removeTrack(m, i) {
  const nA = m.sides.A.length;
  if (!(i >= 0 && i < m.tracks.length)) return m;
  return i < nA ? removeFromSide(m, 'A', i) : removeFromSide(m, 'B', i - nA);
}

/** Move within one side (dest clamped). Out-of-range `from` is a no-op. */
export function moveInSide(m, side, from, to) {
  if (!isSide(side)) return m;
  const list = sideRefs(m, side), n = list.length;
  if (!(from >= 0 && from < n)) return m;
  const dest = Math.max(0, Math.min(n - 1, to));
  if (dest === from) return m;
  const next = list.slice();
  const [t] = next.splice(from, 1);
  next.splice(dest, 0, t);
  return side === 'B' ? withSides(m, m.sides.A, next) : withSides(m, next, m.sides.B);
}
/** Legacy flat move: reorders inside whichever side `from` is on (dest clamped to that side). */
export function moveTrack(m, from, to) {
  const nA = m.sides.A.length;
  if (!(from >= 0 && from < m.tracks.length)) return m;
  return from < nA ? moveInSide(m, 'A', from, to) : moveInSide(m, 'B', from - nA, to - nA);
}
/** Move a song to the OTHER side (or `toSide`), at `toIndex` (default end), honouring the caps there. -> { mixtape, ok, reason } */
export function moveAcross(m, fromSide, i, toSide = fromSide === 'A' ? 'B' : 'A', toIndex) {
  const src = sideRefs(m, fromSide);
  if (!isSide(fromSide) || !isSide(toSide) || !(i >= 0 && i < src.length)) return { mixtape: m, ok: false, code: 'range', reason: 'No such song.' };
  if (fromSide === toSide) return { mixtape: moveInSide(m, fromSide, i, toIndex == null ? i : toIndex), ok: true, code: 'ok', reason: '' };
  const ref = src[i];
  const c = canAdd(removeFromSide(m, fromSide, i), toSide, ref);
  if (!c.ok) return { mixtape: m, ...c };
  return { ...tryAdd(removeFromSide(m, fromSide, i), toSide, ref, toIndex) };
}

/**
 * Fill `side` with as many of `pool` (in order) as fit, skipping songs already on the tape
 * (by id, else artist/album/title). -> same shape as addMany.
 */
export function autoFill(m, side, pool) {
  const have = new Set([...m.sides.A, ...m.sides.B].map((r) => r.id || trackKey(r)));
  const fresh = pool.filter((t) => !have.has(t.id || trackKey(t)));
  return addMany(m, side, fresh);
}

/** Replace the flat tape contents: pour `tracks` into A then B honouring caps. Returns { mixtape, skipped }. */
export function fillTape(m, tracks) {
  const empty = withSides(m, [], []);
  const a = addMany(empty, 'A', tracks);
  const b = addMany(a.mixtape, 'B', a.skipped.map((s) => s.track));
  return { mixtape: b.mixtape, skipped: b.skipped };
}

export function withTape(m, length) {
  return hasTape(length) ? { ...m, tape: { length } } : m;
}
export const withAutoReverse = (m, on) => ({ ...m, autoReverse: !!on });

/** Does the tape fit a different length? (the editor refuses a shrink that would drop songs) */
export function canResize(m, length) {
  if (!hasTape(length)) return { ok: false, reason: 'Unknown tape length.' };
  const cap = TAPES[length].sideSec;
  for (const side of SIDES) {
    const i = sideInfo(m, side);
    if (i.sec > cap) return { ok: false, reason: `Side ${side} holds ${fmtDur(i.sec, i.est)}; a ${length} side takes ${fmtDur(cap)}.` };
  }
  return { ok: true, reason: '' };
}

/**
 * Refresh the duration hints from the resolved library (real durations beat estimates):
 * `resolved` is resolveTracks(m, lib) (parallel to m.tracks). Returns the same object when nothing changed.
 */
export function withDurations(m, resolved) {
  let changed = false;
  const fix = (refs, off) => refs.map((r, i) => {
    const t = resolved[off + i], d = t ? cleanDur(t.durationSec) : 0;
    if (d && d !== r.dur) { changed = true; return { ...r, dur: d }; }
    return r;
  });
  const A = fix(m.sides.A, 0), B = fix(m.sides.B, m.sides.A.length);
  return changed ? withSides(m, A, B) : m;
}

/**
 * Legacy list -> sides on the smallest tape that holds it in side A; when even a C90 side A can't,
 * A is filled to its caps and the REST stays on B (even past B's caps): nothing is ever dropped.
 */
export function sidesFromLegacy(refs, wantTape) {
  const probe = (len) => {
    const cap = TAPES[len].sideSec;
    return refs.length <= MAX_SONGS_PER_SIDE && listSeconds(refs) <= cap;
  };
  // At least the default C60 (a C30 filled with 4:00 estimates would leave no room to add), else C90.
  const length = hasTape(wantTape) ? wantTape : (['C60', 'C90'].find(probe) || 'C90');
  const cap = TAPES[length].sideSec;
  const A = [];
  let used = 0, i = 0;
  for (; i < refs.length; i++) {
    const d = refSeconds(refs[i]).sec;
    if (A.length >= MAX_SONGS_PER_SIDE || used + d > cap) break;
    A.push(refs[i]); used += d;
  }
  return { length, A, B: refs.slice(i) };
}

/**
 * `id` is a parameter (not generated here) so the model stays deterministic.
 * Accepts the v4 shape ({name, author, cfg, tape, sides, autoReverse}), the
 * v1-v3 shape (tracks[] -> side A) and, for migration, {styleId, fontId, fontColor}.
 */
export function createMixtape({ id, name, author, tracks, sides, tape, autoReverse, cfg, styleId, fontId, fontColor } = {}) {
  let A, B, length;
  if (sides && typeof sides === 'object') {
    A = cleanRefs(sides.A); B = cleanRefs(sides.B);
    length = hasTape(tape && tape.length) ? tape.length : (hasTape(tape) ? tape : null);
    if (!length) {
      const probe = TAPE_IDS.find((l) => listSeconds(A) <= TAPES[l].sideSec && listSeconds(B) <= TAPES[l].sideSec && A.length <= MAX_SONGS_PER_SIDE && B.length <= MAX_SONGS_PER_SIDE);
      length = probe || 'C90';
    }
  } else {
    const r = sidesFromLegacy(cleanRefs(tracks), hasTape(tape && tape.length) ? tape.length : (hasTape(tape) ? tape : undefined));
    A = r.A; B = r.B; length = r.length;
    if (!(Array.isArray(tracks) && tracks.length)) length = hasTape(tape && tape.length) ? tape.length : DEFAULT_TAPE;
  }
  return withSides({
    id: id || 'mt-0',
    name: cleanName(name),
    author: str(author, MAX_AUTHOR),
    tape: { length },
    autoReverse: autoReverse === undefined ? true : !!autoReverse,
    cfg: cleanCfg(cfg, { styleId, fontId, fontColor }),
  }, A, B);
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
/** The label note the cassette prints when the user left it blank: "Side A · 6 songs". */
export function autoNote(m, side) {
  const sd = isSide(side) ? side : (m.cfg.text.side === 'B' ? 'B' : 'A');
  const n = m.sides[sd].length;
  return `Side ${sd} · ${n} ${n === 1 ? 'song' : 'songs'}`;
}

/**
 * Mixtape -> the cfg the Cassette renderer takes (title = name, blank note = auto).
 * extra.side ('A'|'B') picks which side the label shows (default: cfg.text.side).
 */
export function cassetteCfg(m, extra = {}) {
  const t = m.cfg.text;
  const { side: sideX, ...rest } = extra;
  const side = isSide(sideX) ? sideX : (t.side === 'B' ? 'B' : 'A');
  return {
    style: m.cfg.style, pen: m.cfg.pen, wear: m.cfg.wear, gloss: m.cfg.gloss,
    ...(m.cfg.slots ? { slots: { ...m.cfg.slots } } : {}),
    seed: m.id,
    text: { title: m.name, subtitle: t.subtitle, note: t.note || autoNote(m, side), side },
    ...rest,
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

// ── Per-side tape position ───────────────────────────────────────────────────
// Each side is its own tape with its own 0..1 position (side B's progress is NOT
// a mirror of A's). `durations` are that side's per-song seconds (real where known).
/** Durations of a side's songs: hint, else the library's real value via `real(ref, i)`, else null. */
export function sideDurations(m, side, real) {
  return sideRefs(m, side).map((r, i) => {
    const d = (real && real(r, i)) || cleanDur(r.dur);
    return d > 0 ? d : null;
  });
}
/** Whole-side progress from (song index within the side, fraction of that song). */
export function sideProgress(m, side, index, frac, durations) {
  return tapeProgress(index, sideRefs(m, side).length, frac, durations);
}
/**
 * Inverse for one side: progress in [0,1] -> { side, index, frac } (index within the side).
 * `durations` null entries are tolerated (equal weighting then, like locateTape).
 */
export function locate(m, side, progress, durations) {
  const n = sideRefs(m, side).length;
  return { side: side === 'B' ? 'B' : 'A', ...locateTape(progress, n, durations) };
}
/** Flat index (A then B) of a song `i` on `side`. */
export const flatIndex = (m, side, i) => (side === 'B' ? m.sides.A.length : 0) + i;
/** Inverse: flat index -> { side, index }. */
export function sideOfFlat(m, flat) {
  const nA = m.sides.A.length;
  return flat < nA ? { side: 'A', index: flat } : { side: 'B', index: flat - nA };
}

// ── JSON (theme.js conventions) ──────────────────────────────────────────────

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const refOut = (t) => ({
  title: t.title, artist: t.artist, album: t.album,
  ...(t.id ? { id: t.id } : {}),
  ...(t.dur ? { dur: t.dur } : {}),
});
const sidesOut = (m) => ({ A: m.sides.A.map(refOut), B: m.sides.B.map(refOut) });

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
    tape: { length: m.tape.length },
    autoReverse: m.autoReverse,
    sides: sidesOut(m),
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
  if (raw.version >= 4) {
    if (!isPlainObject(raw.sides)) return { ok: false, error: 'Missing "sides" object (with "A" and "B" arrays).' };
    for (const sd of SIDES) {
      const list = raw.sides[sd];
      if (list === undefined && sd === 'B') continue;
      if (!Array.isArray(list)) return { ok: false, error: `Missing "sides.${sd}" array.` };
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (!isPlainObject(t) || typeof t.title !== 'string' || !t.title.trim()) {
          return { ok: false, error: `Invalid "sides.${sd}[${i}]": needs a non-empty "title".` };
        }
      }
    }
    if (raw.tape !== undefined && !(isPlainObject(raw.tape) && hasTape(raw.tape.length))) {
      return { ok: false, error: `Unknown "tape.length": ${JSON.stringify(raw.tape && raw.tape.length)} (one of ${TAPE_IDS.join(', ')}).` };
    }
    return { ok: true, mixtape: createMixtape({ id, name: raw.name, author: raw.author, sides: raw.sides, tape: raw.tape,
      autoReverse: typeof raw.autoReverse === 'boolean' ? raw.autoReverse : undefined, cfg, ...legacy }) };
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
      id: m.id, name: m.name, author: m.author, cfg: cfgOut(m),
      tape: { length: m.tape.length }, autoReverse: m.autoReverse, sides: sidesOut(m),
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
    if (!isPlainObject(e) || typeof e.id !== 'string') continue;
    if (raw.version >= 4) {
      if (!isPlainObject(e.sides)) continue;
      out.push(createMixtape({
        id: e.id, name: e.name, author: e.author, sides: e.sides, tape: isPlainObject(e.tape) ? e.tape : undefined,
        autoReverse: typeof e.autoReverse === 'boolean' ? e.autoReverse : undefined,
        cfg: isPlainObject(e.cfg) ? e.cfg : {},
      }));
      continue;
    }
    if (!Array.isArray(e.tracks)) continue;
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
