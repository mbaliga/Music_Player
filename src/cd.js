// ─────────────────────────────────────────────────────────────────────────────
// cd.js — pure geometry for the CD playing view (no DOM; tested in
// test/cd.test.mjs). A CD is deliberately NOT vinyl-like: there is no scrub and
// no pitch bend. You skip. The disc carries two rings you can tap:
//   • the SEGMENT ring (outer): one arc per track, tap = jump to that track;
//   • the PROGRESS ring (inner): the current track unrolled around the disc,
//     tap = seek to that point (a CD "skip", with a tiny mute in main.js).
// Angles run clockwise from 12 o'clock, in radians, 0..TAU.
// ─────────────────────────────────────────────────────────────────────────────

const TAU = Math.PI * 2;

export const CD_KNOBS = Object.freeze({
  segGapRad: 0.045,     // visual/hit gap between track segments
  ringOuter: 0.97,      // ring radii as fractions of the disc radius
  segInner: 0.86,       // segment ring: [segInner, ringOuter]
  progOuter: 0.80,      // progress ring: [progInner, progOuter]
  progInner: 0.68,
  skipMuteMs: 70,       // brief silence on a CD seek (it re-reads; nothing slides)
});

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Split the circle into `weights.length` arcs (weights ~ track durations),
 * separated by `gap` radians. Returns [{index, a0, a1}] clockwise from 0.
 */
export function segmentArcs(weights, gap = CD_KNOBS.segGapRad) {
  const n = weights.length;
  if (n === 0) return [];
  const g = n > 1 ? gap : 0;
  const usable = TAU - n * g;
  let w = weights.map((x) => (x > 0 ? x : 0));
  if (w.reduce((a, b) => a + b, 0) === 0) w = w.map(() => 1);
  const total = w.reduce((a, b) => a + b, 0);
  const out = [];
  let a = g / 2;
  for (let i = 0; i < n; i++) {
    const span = usable * (w[i] / total);
    out.push({ index: i, a0: a, a1: a + span });
    a += span + g;
  }
  return out;
}

/** Clockwise-from-12-o'clock angle of a point about a centre, in [0, TAU). */
export function angleFromTop(x, y, cx, cy) {
  let a = Math.atan2(x - cx, -(y - cy));
  if (a < 0) a += TAU;
  return a;
}

/**
 * Hit-test a tap on the CD. Returns
 *   { ring: 'segments', index }            — tap on a track segment
 *   { ring: 'progress', frac }             — tap on the progress ring (0..1 around)
 *   null                                   — anywhere else
 * Taps in a segment gap snap to the nearest segment.
 */
export function hitTest(x, y, cx, cy, R, arcs, knobs = CD_KNOBS) {
  const d = Math.hypot(x - cx, y - cy) / R;
  const a = angleFromTop(x, y, cx, cy);
  if (d >= knobs.segInner && d <= knobs.ringOuter && arcs.length) {
    let best = 0, bestD = Infinity;
    for (const s of arcs) {
      if (a >= s.a0 && a <= s.a1) return { ring: 'segments', index: s.index };
      const mid = (s.a0 + s.a1) / 2;
      let dd = Math.abs(a - mid);
      if (dd > Math.PI) dd = TAU - dd;
      if (dd < bestD) { bestD = dd; best = s.index; }
    }
    return { ring: 'segments', index: best };
  }
  if (d >= knobs.progInner && d <= knobs.progOuter) return { ring: 'progress', frac: a / TAU };
  return null;
}
