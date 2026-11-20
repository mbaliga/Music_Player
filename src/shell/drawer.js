// drawer.js — the drawer's pure physics and decisions. No DOM, no timers: every function takes and returns plain numbers,
// so the whole feel is unit-tested (test/shell-drawer.test.mjs) and tunable from one table.
//
// Position model: `x` is how far the card has been pulled to the right, in CSS px, 0 (closed) .. openOffset(width) (open).
// The card is drawn with transform: translate3d(x, 0, 0) scale(cardScale(x, open)) and nothing else, so a frame costs one
// compositor update.

export const DRAWER = Object.freeze({
  EDGE_STRIP_PX: 24,        // width of the invisible grab strip on the card's left edge (only these px start a drag)
  OPEN_FRACTION: 0.56,      // how far the card travels, as a share of the shell width (the reference shows ~53%)
  OPEN_MAX_PX: 320,         // ... capped so a wide frame does not push the card miles away
  SCALE_OPEN: 0.86,         // card scale when fully open (origin: left centre)
  SLOP_PX: 6,               // movement before a press becomes a drag (or is rejected as a vertical scroll attempt)
  FLING_VELOCITY: 520,      // px/s: a release faster than this goes the way it was flung, wherever it is
  PROJECT_S: 0.12,          // otherwise the release position is projected this many seconds ahead before the 50% test
  SETTLE_AT: 0.5,           // share of the travel at which a slow release settles open
  RUBBER: 0.3,              // how much of the finger travel past either end still moves the card (rubber band)
  SPRING_K: 520,            // stiffness (1/s^2)
  SPRING_ZETA: 0.82,        // damping ratio: slightly under 1, so it settles with a hint of overshoot and no wobble
  REST_PX: 0.25,            // settled when closer than this to the target ...
  REST_V: 8,                // ... and slower than this (px/s)
  VELOCITY_WINDOW_MS: 90,   // recent pointer samples used to estimate the release velocity
  MAX_DT: 1 / 30,           // a long frame is stepped as if it were this long
});

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Travel of the card for a shell of `width` px. */
export function openOffset(width, cfg = DRAWER) {
  return Math.max(0, Math.min(width * cfg.OPEN_FRACTION, cfg.OPEN_MAX_PX));
}

/** 0..1 share of the travel. */
export function progress(x, open) { return open > 0 ? clamp(x / open, 0, 1) : 0; }

/** Card scale for position x: 1 closed, SCALE_OPEN open. */
export function cardScale(x, open, cfg = DRAWER) { return 1 - (1 - cfg.SCALE_OPEN) * progress(x, open); }

/** The finger asked for `raw` px of travel; past either end only RUBBER of the excess counts. */
export function rubberBand(raw, open, cfg = DRAWER) {
  if (raw < 0) return raw * cfg.RUBBER;
  if (raw > open) return open + (raw - open) * cfg.RUBBER;
  return raw;
}

/** Release velocity (px/s) from [{x, t(ms)}] samples: only samples inside the last window count. */
export function velocityFromSamples(samples, cfg = DRAWER) {
  if (!samples || samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > cfg.VELOCITY_WINDOW_MS) break;
    first = samples[i];
  }
  const dt = (last.t - first.t) / 1000;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

/** Where a released drag should settle: `open` or 0. A fling decides by direction, otherwise by projected position. */
export function settleTarget(x, v, open, cfg = DRAWER) {
  if (Math.abs(v) >= cfg.FLING_VELOCITY) return v > 0 ? open : 0;
  return x + v * cfg.PROJECT_S >= open * cfg.SETTLE_AT ? open : 0;
}

/** Classify the first movement of a press: 'wait' (inside the slop), 'drag' (horizontal) or 'reject' (vertical: a scroll attempt, not ours). */
export function classifyMove(dx, dy, cfg = DRAWER) {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (Math.max(ax, ay) < cfg.SLOP_PX) return 'wait';
  return ax >= ay ? 'drag' : 'reject';
}

/** One spring step toward `target`. s = { x, v }. Semi-implicit Euler in fixed sub-steps, so it is stable at any frame time. */
export function springStep(s, target, dt, cfg = DRAWER) {
  let { x, v } = s;
  const k = cfg.SPRING_K, c = 2 * cfg.SPRING_ZETA * Math.sqrt(k);
  let left = clamp(dt, 0, cfg.MAX_DT);
  while (left > 1e-9) {
    const h = Math.min(left, 1 / 240);
    v += (-k * (x - target) - c * v) * h;
    x += v * h;
    left -= h;
  }
  return { x, v };
}

export function isSettled(s, target, cfg = DRAWER) {
  return Math.abs(s.x - target) < cfg.REST_PX && Math.abs(s.v) < cfg.REST_V;
}

/** Final state of a spring run to rest from (x, v), by simulating at 60 Hz. Returns { frames, overshoot } (tests and docs use it). */
export function simulateSettle(x, v, target, cfg = DRAWER) {
  let s = { x, v }, frames = 0, over = 0;
  while (!isSettled(s, target, cfg) && frames < 600) {
    s = springStep(s, target, 1 / 60, cfg);
    over = Math.max(over, target >= x ? s.x - target : target - s.x);
    frames++;
  }
  return { frames, overshoot: over };
}
