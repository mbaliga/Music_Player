// ─────────────────────────────────────────────────────────────────────────────
// gesture.js — finger -> FX parameter mappings (pure). Every threshold is a tunable constant in GESTURE_KNOBS.
//
// Coordinates: a "surface" is the circular touch area (the platter or the FX pad). `u` is the normalised radial position,
// 0 at the spindle ... 1 at the outer edge. `s` is the signed finger spin relative to nominal platter speed
// (1 = one nominal revolution speed, clockwise positive; at 33 1/3 rpm that is 3.49 rad/s).
// ─────────────────────────────────────────────────────────────────────────────

import { DIVISIONS } from './divisions.js';

export const GESTURE_KNOBS = Object.freeze({
  // beat repeat / stutter: a radial drag steps the division (inward = shorter slice, outward = longer)
  divInner: 0.10,        // u at which the innermost zone (1/16) starts
  divOuter: 0.96,        // u at which the outermost zone (1/1) ends
  divHyst: 0.18,         // hysteresis, in zones (0.18 of a zone width) before the division changes
  // beat repeat rate from finger spin
  spinDead: 0.40,        // |s| below this leaves the repeat at 100% (a resting finger = unchanged rate)
  spinUpGain: 0.85,      // forward spin: rate = 1 + (s - dead) * gain
  spinDownGain: 0.35,    // backward spin: rate = 1 - (|s| - dead) * gain
  rateMinPct: -50,       // CLAMP: -50 % (half speed) ...
  rateMaxPct: 900,       // ... to +900 % (10x)
  spinSmoothTau: 0.06,   // seconds, one-pole smoothing of the measured spin
  // band pass: x axis -> centre frequency (log), y axis -> Q (log)
  bpFreqMin: 150, bpFreqMax: 8000, bpQMin: 0.7, bpQMax: 14,
  // blend scratch
  blendMin: 0, blendMax: 1,
});

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const num = (x, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);

/**
 * Division from a radial DRAG. The division in force when the finger lands is `div0`; moving the finger inward (toward the spindle)
 * steps toward 1/16, outward toward 1/1, one step per `zoneWidth` of radial travel (u units; 5 zones span divInner..divOuter).
 * `prev` = the division currently in force while holding (hysteresis: the finger must pass a zone boundary by divHyst of a zone).
 */
export function divisionFromDrag(div0, u0, u, prev = null, K = GESTURE_KNOBS) {
  const n = DIVISIONS.length;
  const i0 = Math.max(0, DIVISIONS.indexOf(div0));
  const zone = (K.divOuter - K.divInner) / n;
  const f = i0 + (num(u0) - num(u)) / zone;                 // fractional index: inward = larger
  const pi = prev ? DIVISIONS.indexOf(prev) : -1;
  let k = Math.round(f);
  if (pi >= 0 && Math.abs(f - pi) <= 0.5 + K.divHyst) k = pi;
  return DIVISIONS[clamp(k, 0, n - 1)];
}

/** Signed spin relative to nominal: rad/s finger angular velocity over rad/s nominal. */
export const spinRelative = (omega, omegaNominal) => (omegaNominal > 0 ? num(omega) / omegaNominal : 0);

/** Repeat playback-rate multiplier from signed spin `s`. Clamped to [1 + rateMinPct/100, 1 + rateMaxPct/100]. */
export function repeatRateFromSpin(s, K = GESTURE_KNOBS) {
  s = num(s);
  const a = Math.abs(s);
  let m = 1;
  if (a > K.spinDead) m = s > 0 ? 1 + (a - K.spinDead) * K.spinUpGain : 1 - (a - K.spinDead) * K.spinDownGain;
  return clamp(m, 1 + K.rateMinPct / 100, 1 + K.rateMaxPct / 100);
}

/** The "+n%" readout: integer percent of the clamped rate. */
export const ratePercent = (m, K = GESTURE_KNOBS) => clamp(Math.round((num(m, 1) - 1) * 100), K.rateMinPct, K.rateMaxPct);
export const formatPercent = (p) => (p > 0 ? '+' : p < 0 ? '−' : '±') + Math.abs(p) + '%';

/** One-pole smoothing step: returns the new smoothed value. */
export function smooth(prev, target, dt, tau) {
  if (!(tau > 0)) return target;
  const a = 1 - Math.exp(-Math.max(0, dt) / tau);
  return prev + (target - prev) * a;
}

// ── XY pad (band pass, reverb/delay): x,y in [-1,1], +x right, +y UP ─────────────────────────────────────────────────
export function padFromPoint(px, py, cx, cy, R) {
  const x = clamp((px - cx) / (R || 1), -1, 1);
  const y = clamp(-(py - cy) / (R || 1), -1, 1);
  return { x, y };
}
const logMap = (t, lo, hi) => lo * Math.pow(hi / lo, clamp(t, 0, 1));
/** Band-pass centre frequency (Hz) from x: left = low, right = high, logarithmic. */
export const bpFreqFromX = (x, K = GESTURE_KNOBS) => logMap((x + 1) / 2, K.bpFreqMin, K.bpFreqMax);
/** Band-pass Q from y: bottom = wide (low Q), top = narrow/resonant, logarithmic. */
export const bpQFromY = (y, K = GESTURE_KNOBS) => logMap((y + 1) / 2, K.bpQMin, K.bpQMax);

/** Reverb/delay wet send from x (left = dry ... right = 1), feedback/depth from y (0.1 .. 0.85). */
export const echoWetFromX = (x) => clamp((x + 1) / 2, 0, 1);
export const echoFeedbackFromY = (y) => 0.1 + 0.75 * clamp((y + 1) / 2, 0, 1);

/** Blend amount from touch radius (outer = more of the underlying song) when "by radius" is on. */
export function blendFromRadius(u, K = GESTURE_KNOBS) {
  return clamp(0.15 + 0.85 * clamp(num(u), 0, 1), K.blendMin, K.blendMax);
}
