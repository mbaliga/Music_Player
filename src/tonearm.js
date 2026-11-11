// ─────────────────────────────────────────────────────────────────────────────
// tonearm.js — pure track-boundary geometry + flick gesture for the vinyl view.
//
// No DOM, no browser globals (portable like model.js; tested in
// test/tonearm.test.mjs). main.js feeds it radii/points and acts on the result.
//
// THE ALBUM SPIRAL. A vinyl album is one record: the groove annulus [rIn, rOut]
// is divided into one BAND per track (width proportional to its duration),
// separated by thin smooth GAPS (the bare vinyl between tracks). Setting the
// needle:
//   • inside a band  -> seek to that point of that track (same linear mapping
//                       as model.js:timeAtRadius, applied per band);
//   • in a gap       -> jump to the START of the track just inside the gap
//                       ("drop the needle between the grooves");
//   • within `startSnapFrac` of a band's outer edge -> snaps to t = 0.
// With ONE track the layout has no gaps and reduces exactly to model.js.
//
// All the numbers a human should tune on the device live in TONEARM_KNOBS.
// ─────────────────────────────────────────────────────────────────────────────

export const TONEARM_KNOBS = Object.freeze({
  // Layout (fractions of the groove span rOut - rIn)
  gapFrac: 0.02,        // drawn width of the bare gap between tracks
  startSnapFrac: 0.012, // landing this close to a band's outer edge = start of track
  // Hit-testing (same units as the radii you pass in: CSS px in main.js)
  gapGrabPx: 14,        // the gap is hit over at least this total width (fingers are fat)
  // Flick (next / previous track): a quick tangential swipe made with the
  // tonearm grabbed (started on/outside the outer edge). Slow or radial drags
  // are still plain silent seeks.
  flickMinArcPx: 70,    // minimum tangential travel
  flickMaxMs: 280,      // the whole swipe must be at least this quick
  flickMinSpeed: 0.45,  // px/ms average tangential speed
  flickMaxRadialPx: 22, // radial drift allowed (more = you were placing the needle)
  // Feel of the lift / set-down (used by main.js + needle-fx.js)
  dropDelayMs: 55,      // music resumes this long after the set-down thump
  liftAnimMs: 280,      // arm lift transition (CSS #arm transition)
  dropAnimMs: 340,      // ghost-ring contraction / arm settle
  prevRestartSec: 3,    // "previous" restarts the track if it is further in than this
});

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/**
 * Estimate per-track durations when only some are known. Unknown entries get
 * the mean of the known ones (or 1 if none are), so the layout is stable and
 * degrades to equal-width bands. `known` entries may be null/undefined/<=0.
 */
export function estimateDurations(known) {
  const ok = known.filter((d) => Number.isFinite(d) && d > 0);
  const mean = ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : 1;
  return known.map((d) => (Number.isFinite(d) && d > 0 ? d : mean));
}

/**
 * Build the album layout. `durations` are positive seconds (see
 * estimateDurations). Returns
 *   { rOut, rIn, bands: [{index, dur, rA, rB, uA, uB}], gaps: [{after, r, rA, rB, uA, uB}] }
 * rA is the OUTER radius of a band, rB the inner. u* are the same positions
 * normalised to 0 (outer edge) .. 1 (inner edge) for the sprite baker.
 */
export function buildLayout(durations, rOut, rIn, knobs = TONEARM_KNOBS) {
  const n = durations.length;
  const span = rOut - rIn;
  const gapW = n > 1 ? knobs.gapFrac * span : 0;
  const usable = span - (n - 1) * gapW;
  const total = durations.reduce((a, b) => a + b, 0) || 1;
  const bands = [];
  const gaps = [];
  let r = rOut;
  for (let i = 0; i < n; i++) {
    const w = usable * (durations[i] / total);
    bands.push({ index: i, dur: durations[i], rA: r, rB: r - w, uA: (rOut - r) / span, uB: (rOut - (r - w)) / span });
    r -= w;
    if (i < n - 1) {
      gaps.push({ after: i, r: r - gapW / 2, rA: r, rB: r - gapW, uA: (rOut - r) / span, uB: (rOut - (r - gapW)) / span });
      r -= gapW;
    }
  }
  return { rOut, rIn, bands, gaps };
}

/**
 * Where is radius `r`? -> { zone: 'track'|'gap', index, frac, gap? }
 *   track: index = band, frac in 0..1 (0 = outer/start edge)
 *   gap:   index = the track just INSIDE the gap (where a drop lands), gap = gap
 * Radii outside the annulus clamp to the first/last track.
 */
export function locate(layout, r, knobs = TONEARM_KNOBS) {
  const { bands, gaps, rOut, rIn } = layout;
  r = clamp(r, rIn, rOut);
  // Gaps first, over a widened hit-zone so a finger can actually land in them.
  for (const g of gaps) {
    const half = Math.max(g.rA - g.rB, knobs.gapGrabPx) / 2;
    if (Math.abs(r - g.r) <= half) return { zone: 'gap', index: g.after + 1, frac: 0, gap: g };
  }
  for (const b of bands) {
    if (r <= b.rA && r >= b.rB) return { zone: 'track', index: b.index, frac: bandFrac(b, r) };
  }
  // Fell between a band edge and a narrowed gap zone: nearest band.
  let best = bands[0];
  for (const b of bands) {
    if (Math.min(Math.abs(r - b.rA), Math.abs(r - b.rB)) < Math.min(Math.abs(r - best.rA), Math.abs(r - best.rB))) best = b;
  }
  return { zone: 'track', index: best.index, frac: bandFrac(best, clamp(r, best.rB, best.rA)) };
}

function bandFrac(b, r) {
  const w = b.rA - b.rB;
  return w > 0 ? clamp((b.rA - r) / w, 0, 1) : 0;
}

/**
 * What a set-down at radius `r` means: { index, time, zone } (time in seconds
 * within track `index`). Gap -> start of the next track; near a band's outer
 * edge -> start of that track.
 */
export function seekTarget(layout, r, knobs = TONEARM_KNOBS) {
  const loc = locate(layout, r, knobs);
  const band = layout.bands[loc.index];
  const span = layout.rOut - layout.rIn;
  if (loc.zone === 'gap') return { index: loc.index, time: 0, zone: 'gap' };
  const nearStart = (band.rA - clamp(r, layout.rIn, layout.rOut)) <= knobs.startSnapFrac * span;
  return { index: loc.index, time: nearStart ? 0 : loc.frac * band.dur, zone: nearStart ? 'start' : 'track' };
}

/** Needle radius for time `t` seconds into track `index` (inverse of seekTarget). */
export function radiusFor(layout, index, t) {
  const b = layout.bands[clamp(index, 0, layout.bands.length - 1)];
  const u = b.dur > 0 ? clamp(t / b.dur, 0, 1) : 0;
  return b.rA - (b.rA - b.rB) * u;
}

/** Index after stepping `dir` (+1/-1) from `index`, clamped; null if no move. */
export function stepIndex(index, dir, count) {
  const j = index + dir;
  return j < 0 || j >= count ? null : j;
}

/**
 * "Previous" behaves like a CD/tape deck: far into a track it restarts it,
 * near the start it goes to the previous track. Returns { index, time } or null.
 */
export function previousTarget(index, t, count, knobs = TONEARM_KNOBS) {
  if (t > knobs.prevRestartSec) return { index, time: 0 };
  const j = stepIndex(index, -1, count);
  return j == null ? { index, time: 0 } : { index: j, time: 0 };
}

// ── flick gesture ────────────────────────────────────────────────────────────

/**
 * Classify a pointer trail as a next/previous flick.
 *   points = [{x, y, t}] (t in ms), centre = {x, y} of the disc.
 * Positive angular travel (clockwise on screen) = 'next', counter = 'prev'.
 * Returns { dir: 'next'|'prev'|null, arc, ms, speed, radial } (metrics always
 * filled so the thresholds can be tuned by watching them).
 */
export function classifyFlick(points, centre, knobs = TONEARM_KNOBS) {
  const none = { dir: null, arc: 0, ms: 0, speed: 0, radial: 0 };
  if (!points || points.length < 2) return none;
  const ang = (p) => Math.atan2(p.y - centre.y, p.x - centre.x);
  const rad = (p) => Math.hypot(p.x - centre.x, p.y - centre.y);
  // Use only the trailing window of the trail that fits flickMaxMs.
  const last = points[points.length - 1];
  let i0 = points.length - 1;
  while (i0 > 0 && last.t - points[i0 - 1].t <= knobs.flickMaxMs) i0--;
  let sweep = 0;
  let rMax = -Infinity, rMin = Infinity;
  for (let i = i0; i < points.length; i++) {
    const r = rad(points[i]);
    if (r > rMax) rMax = r;
    if (r < rMin) rMin = r;
    if (i > i0) {
      let d = ang(points[i]) - ang(points[i - 1]);
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      sweep += d;
    }
  }
  const ms = last.t - points[i0].t;
  const rAvg = (rMax + rMin) / 2;
  const arc = Math.abs(sweep) * rAvg;
  const radial = rMax - rMin;
  const speed = ms > 0 ? arc / ms : 0;
  const ok = ms > 0 && ms <= knobs.flickMaxMs && arc >= knobs.flickMinArcPx
    && speed >= knobs.flickMinSpeed && radial <= knobs.flickMaxRadialPx;
  return { dir: ok ? (sweep > 0 ? 'next' : 'prev') : null, arc, ms, speed, radial };
}
