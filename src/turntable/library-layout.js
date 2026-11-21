// ─────────────────────────────────────────────────────────────────────────────
// library-layout.js — the pure half of the turntable library (no DOM, no
// browser globals; tested in test/turntable-library-layout.test.mjs).
//
//   libraryLayout()      the prototype's layout formulas (--cs --ct --fh --mh --f1 --f2 --pad --rh)
//   coverPose()          coverflow geometry for a cover at offset o from the focus
//   visibleRange()       which album indices get a DOM node (virtualisation)
//   dragFocus / flingTarget / easeStep / wheelStep / keyStep   motion maths
//   albumsToCoverflow()  src/albums.js shelf items -> the album objects the component takes
//   builtinTestPressing()  the single album shown when the library is empty
//   formatDuration / totalDuration / clipText   display helpers
// ─────────────────────────────────────────────────────────────────────────────
import { classifyAlbum, stripDiscLabel, KIND_CD, KIND_VINYL } from '../albums.js';
import { hashSeed } from './covers.js';

// ── tunables ─────────────────────────────────────────────────────────────────
export const LIB_KNOBS = Object.freeze({
  stepRatio: 0.62,       // centre -> first neighbour distance, as a fraction of the cover size (also the drag scale)
  farRatio: 0.30,        // spacing between covers further out
  rotateDeg: 56,         // neighbour rotateY
  scaleDrop: 0.2,        // neighbour scale = 1 - scaleDrop
  shadeMax: 0.5,         // neighbour darkening (the prototype's brightness(.5))
  perspectivePx: 800,
  fadeAt: 3.2,           // |offset| beyond which a cover is invisible (and has no DOM node)
  rowMin: 44,            // minimum track-row height (touch target); the prototype's own is 34..48
  dragSlopPx: 6,         // movement before a press becomes a swipe
  easeRate: 11,          // focus eases to its target at 1 - exp-ish: min(1, dt * easeRate)
  flingGainS: 0.1,       // momentum: target = round(focus + velocity * gain)
  maxFling: 5,           // never fling further than this many albums
  settleEps: 0.003,
  wheelIdleMs: 120,
  maxTrackRows: 500,     // DOM rows rendered per album (a longer album shows the first 500)
  maxText: 200,          // characters of any library string that reach the DOM
  coverWindow: 3,        // N: covers kept within +-N (+ fade margin) of the focus
});

// ── layout (the prototype's layoutLib, as a pure function) ───────────────────
/**
 * libraryLayout({width, height, portrait}) -> the CSS variable values.
 *   cs  cover size            ct  cover top (room above it for the disc to hover; the toolbar sits here)
 *   fh  flow height           mh  meta (title + sub) height
 *   f1  main font px          f2  small font px      pad  track-list side padding
 *   rh  track row height (>= 44: the prototype's 34..48 clamped up to a touch target); rhProto = the prototype's own
 *   step  px per album while dragging / the first neighbour's x offset
 *   tbRows / tbH  toolbar rows (1, or 2 in portrait under 700 px wide) and height;  tight  = width < 400 (compact chips)
 * Portrait: cover = 62% of the width; landscape: 44% of the height.
 */
export function libraryLayout({ width, height, portrait } = {}) {
  const pw = Math.max(1, +width || 1), ph = Math.max(1, +height || 1);
  const port = portrait == null ? pw < ph : !!portrait;
  const cs = Math.round(port ? pw * 0.62 : ph * 0.44);
  const ct = Math.round(cs * 0.64);
  const fh = ct + cs + Math.round(cs * 0.07);
  const f1 = Math.max(11, Math.min(16, pw / (port ? 26 : 70)));
  const rhProto = Math.round(Math.max(34, Math.min(48, f1 * 3.1)));
  const tbRows = port && pw < 700 ? 2 : 1;
  return {
    portrait: port, cs, ct, fh,
    mh: Math.round(f1 * 4.4),
    f1, f2: Number((f1 * 0.88).toFixed(1)),
    pad: Math.round(pw * 0.07),
    rh: Math.max(LIB_KNOBS.rowMin, rhProto), rhProto,
    step: cs * LIB_KNOBS.stepRatio,
    tbRows, tbH: tbRows * 44,
    tight: pw < 400,                         // narrow: short scan label, tighter chips, no 'Sort' caption
  };
}

// ── coverflow geometry ───────────────────────────────────────────────────────
/**
 * Pose of the cover at signed offset `o` (index - focus) for cover size `cs`.
 * Writes into `out` (no allocation): {x, rot, scale, z, shade, opacity}.
 * Ported from the prototype's updateFlow; `shade` replaces its brightness filter
 * (a black overlay at that opacity: the same darkening, cheaper to composite).
 */
export function coverPose(o, cs, out) {
  const K = LIB_KNOBS, ao = Math.abs(o), sg = o < 0 ? -1 : 1, m = Math.min(1, ao);
  out.x = ao < 1 ? o * cs * K.stepRatio : sg * (cs * K.stepRatio + (ao - 1) * cs * K.farRatio);
  out.rot = -sg * m * K.rotateDeg;
  out.scale = 1 - K.scaleDrop * m;
  out.z = 100 - Math.round(ao * 10);
  out.shade = K.shadeMax * m;
  out.opacity = ao > K.fadeAt ? 0 : 1;
  return out;
}

/** Inclusive index range that needs a DOM node for fractional `focus` among n albums. Empty: lo > hi. */
export function visibleRange(focus, n, N = LIB_KNOBS.coverWindow) {
  if (!(n > 0)) return { lo: 0, hi: -1 };
  const reach = Math.min(N + 0.2, LIB_KNOBS.fadeAt) + 0.0001;
  return { lo: Math.max(0, Math.floor(focus - reach)), hi: Math.min(n - 1, Math.ceil(focus + reach)) };
}

/** Pool slots needed so that indices in any visibleRange map to distinct slots (k % P). */
export const POOL_SIZE = 2 * (LIB_KNOBS.coverWindow + 1) + 1;

// ── motion maths ─────────────────────────────────────────────────────────────
export const clampIndex = (i, n) => (n > 0 ? Math.max(0, Math.min(n - 1, i)) : 0);

/** Focus while dragging: pressed at f0, finger moved dx px (right = previous album). */
export function dragFocus(f0, dx, cs, n) {
  return Math.max(0, Math.min(Math.max(0, n - 1), f0 - dx / (cs * LIB_KNOBS.stepRatio)));
}

/** Where a released swipe settles: round(focus + v*gain), at most maxFling albums away. v in albums/s (+ = towards higher index). */
export function flingTarget(focus, v, n) {
  const K = LIB_KNOBS;
  const base = Math.round(focus);
  let t = Math.round(focus + (Number.isFinite(v) ? v : 0) * K.flingGainS);
  t = Math.max(base - K.maxFling, Math.min(base + K.maxFling, t));
  return clampIndex(t, n);
}

/** One easing step of the focus towards its target; returns the new focus (snaps within settleEps). */
export function easeStep(focus, target, dt) {
  const f = focus + (target - focus) * Math.min(1, dt * LIB_KNOBS.easeRate);
  return Math.abs(target - f) < LIB_KNOBS.settleEps ? target : f;
}

/** Wheel / trackpad: horizontal delta (px) -> change of focus target, in albums. */
export const wheelStep = (deltaPx, cs) => deltaPx / (cs * LIB_KNOBS.stepRatio);

/** Keyboard: the new target index for a key, or null when the key is not ours. */
export function keyStep(target, key, n) {
  if (key === 'ArrowLeft' || key === 'ArrowUp') return clampIndex(Math.round(target) - 1, n);
  if (key === 'ArrowRight' || key === 'ArrowDown') return clampIndex(Math.round(target) + 1, n);
  if (key === 'Home') return 0;
  if (key === 'End') return clampIndex(n - 1, n);
  if (key === 'PageUp') return clampIndex(Math.round(target) - 3, n);
  if (key === 'PageDown') return clampIndex(Math.round(target) + 3, n);
  return null;
}

// ── display helpers ──────────────────────────────────────────────────────────
/** Seconds -> "m:ss" / "h:mm:ss"; unknown (null / NaN / negative) -> an em dash. */
export function formatDuration(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
  const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** Sum of all track durations, or null when any is unknown (so a partial total is never shown as the whole). */
export function totalDuration(tracks) {
  if (!tracks || !tracks.length) return null;
  let t = 0;
  for (const x of tracks) { if (x.durationSec == null || !Number.isFinite(x.durationSec)) return null; t += x.durationSec; }
  return t;
}

/** Library strings are untrusted and unbounded: cap what reaches the DOM (CSS ellipsises the rest). */
export function clipText(s, max = LIB_KNOBS.maxText) {
  const t = String(s ?? '');
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export const pad2 = (n) => (n < 10 ? '0' : '') + n;

// ── albums <-> coverflow ─────────────────────────────────────────────────────
export const TEST_PRESSING_ID = 'builtin:test-pressing';

/**
 * The album shown when nothing has been scanned: the app's built-in synthesized
 * test pressing. `tracks` may be passed (the app's own sub-tracks); the default
 * is one track.  -> { id, title, artist, kind:'vinyl', coverSeed, tracks, builtin:true }
 */
export function builtinTestPressing({ tracks, durationSec = null, artist = 'Runout', title = 'Demo record' } = {}) {
  const list = Array.isArray(tracks) && tracks.length
    ? tracks.map((t) => ({ title: String(t?.title ?? title), durationSec: Number.isFinite(t?.durationSec) ? t.durationSec : null }))
    : [{ title, durationSec: Number.isFinite(durationSec) ? durationSec : null }];
  return { id: TEST_PRESSING_ID, title, artist, kind: KIND_VINYL, coverSeed: hashSeed(artist + '\u0000' + title), tracks: list, builtin: true };
}
export const isBuiltinAlbum = (a) => !!a && (a.builtin === true || a.id === TEST_PRESSING_ID);

/** A track title for display: the disc label some taggers append ("Song [CD1]", "Song (Disc 2)") is noise (the CD grouping reads the original). */
export function cleanTrackTitle(title) {
  const t = String(title ?? '');
  const c = stripDiscLabel(t);
  return c || t.trim();
}

const trackTitleOf = (t, i) => {
  const s = typeof t?.title === 'string' && t.title.trim();
  if (s) return cleanTrackTitle(t.title);
  const base = typeof t?.path === 'string' ? t.path.split(/[\\/]+/).pop().replace(/\.[^.]+$/, '') : '';
  return base || `Track ${i + 1}`;
};

/**
 * src/albums.js shelf items -> album objects for the component:
 *   { id, title, artist, kind:'vinyl'|'cd', coverUrl?, coverSeed, tracks:[{title, durationSec|null, id?}], meta? }
 * One entry per shelf item, in the order given (the caller sorts), so a multi-disc
 * CD is one entry per disc, titled as the shelf labels it ("Title · CD 2"), and its
 * tracks are the disc's, in the order albums.js decided. The cover seed is a hash of
 * artist + album title WITHOUT the disc suffix, so the discs of one set share art.
 * Also accepts LibraryManager.albums() items ({id, kind, album:'label', artist, coverUrl, tracks}).
 * Odd data never throws: missing titles / artists get placeholders, ids are made unique.
 */
export function albumsToCoverflow(shelfItems) {
  const out = [], seen = new Set();
  const list = Array.isArray(shelfItems) ? shelfItems : [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it || typeof it !== 'object') continue;
    const grouped = it.album && typeof it.album === 'object';           // albums.js shelf item vs LibraryManager row
    const title = String((grouped ? it.label : (typeof it.album === 'string' ? it.album : it.title)) || (grouped && it.album.title) || '').trim() || 'Untitled';
    const artist = String((grouped ? it.album.artist : it.artist) || '').trim() || 'Unknown Artist';
    const baseTitle = String((grouped && it.album.title) || title);
    const rawTracks = Array.isArray(it.tracks) ? it.tracks : [];
    const kind = it.kind === KIND_CD || it.kind === KIND_VINYL ? it.kind : classifyAlbum({ album: title }).kind;
    let id = String(it.id ?? `album-${i}`);
    if (seen.has(id)) { let n = 2; while (seen.has(`${id}#${n}`)) n++; id = `${id}#${n}`; }
    seen.add(id);
    let coverUrl = typeof it.coverUrl === 'string' && it.coverUrl ? it.coverUrl : null;
    if (!coverUrl) { const t = rawTracks.find((x) => x && typeof x.coverUrl === 'string' && x.coverUrl); coverUrl = t ? t.coverUrl : null; }
    const a = {
      id, title, artist, kind,
      coverSeed: hashSeed(artist + '\u0000' + baseTitle),
      tracks: rawTracks.map((t, k) => ({
        title: trackTitleOf(t, k),
        durationSec: Number.isFinite(t?.durationSec) && t.durationSec > 0 ? t.durationSec : null,
        ...(t && t.id != null ? { id: t.id } : null),
      })),
    };
    if (coverUrl) a.coverUrl = coverUrl;
    out.push(a);
  }
  return out;
}
