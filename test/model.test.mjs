// ─────────────────────────────────────────────────────────────────────────────
// model.test.mjs — correctness gate for the pure model layer (spec §8).
//
// The model is the one layer that must survive the web → native Android port
// intact, so it's also the one layer worth pinning with automated tests: if a
// refactor breaks radius↔time inversion or the platter physics, this fails
// before anyone has to feel it on the device.
//
// Dependency-free: uses only node:test + node:assert, so `npm test` needs no
// install and runs as a fast pre-build gate in CI.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TAU,
  radiusAtTime, timeAtRadius,
  omegaNominal, secondsPerRev,
  DEFAULT_PARAMS, createPlatter, stepPlatter, rateFromOmega,
  computeEnvelope, clamp, angleDelta,
} from '../src/model.js';

// Geometry fixture roughly matching makeGeometry() proportions.
const T = 24;            // track seconds
const rOut = 276;        // 600 * 0.46
const rIn = 96;          // 600 * 0.16

// ── Spiral geometry: radius is a linear readout of progress ──────────────────

test('radiusAtTime walks from rOut at t=0 to rIn at t=T', () => {
  assert.equal(radiusAtTime(0, T, rOut, rIn), rOut);
  assert.equal(radiusAtTime(T, T, rOut, rIn), rIn);
  // Halfway through the track, the needle sits halfway down the groove span.
  assert.ok(Math.abs(radiusAtTime(T / 2, T, rOut, rIn) - (rOut + rIn) / 2) < 1e-9);
});

test('radiusAtTime clamps outside [0, T] (no needle past the lip or spindle)', () => {
  assert.equal(radiusAtTime(-5, T, rOut, rIn), rOut);
  assert.equal(radiusAtTime(T + 5, T, rOut, rIn), rIn);
});

test('timeAtRadius is the exact inverse of radiusAtTime', () => {
  // The seek must land on the same audio time the needle was displaying —
  // round-tripping t → r → t has to be exact, or scrub-to-seek drifts.
  for (let i = 0; i <= 20; i++) {
    const t = (i / 20) * T;
    const r = radiusAtTime(t, T, rOut, rIn);
    const back = timeAtRadius(r, T, rOut, rIn);
    assert.ok(Math.abs(back - t) < 1e-9, `t=${t} round-tripped to ${back}`);
  }
});

test('timeAtRadius clamps to [0, T] for radii beyond the groove span', () => {
  assert.equal(timeAtRadius(rOut + 50, T, rOut, rIn), 0);
  assert.equal(timeAtRadius(rIn - 50, T, rOut, rIn), T);
});

test('geometry degenerate cases do not divide by zero', () => {
  assert.equal(radiusAtTime(5, 0, rOut, rIn), rOut); // T=0 → progress 0
  assert.equal(timeAtRadius(rOut, T, rOut, rOut), 0); // zero span → time 0
});

// ── Angular velocity ↔ RPM ↔ playback rate ───────────────────────────────────

test('omegaNominal and secondsPerRev agree on revolution timing', () => {
  // 33⅓ RPM → 1.8 s per revolution.
  assert.ok(Math.abs(secondsPerRev(33 + 1 / 3) - 1.8) < 1e-9);
  // One revolution (TAU rad) at ω_nominal must take secondsPerRev seconds.
  const rpm = 45;
  assert.ok(Math.abs(TAU / omegaNominal(rpm) - secondsPerRev(rpm)) < 1e-9);
});

test('rate = 1× when the platter spins at the reference RPM', () => {
  const REF = 33 + 1 / 3;
  assert.ok(Math.abs(rateFromOmega(omegaNominal(REF), REF) - 1) < 1e-9);
});

test('dialing 45 against a 33⅓ master plays faster (coupled pitch+tempo)', () => {
  const REF = 33 + 1 / 3;
  // Platter physically spinning at 45, but the track is mastered for 33⅓:
  // rate is normalized to the master, so it plays at 45/33⅓ = 1.35×.
  const rate = rateFromOmega(omegaNominal(45), REF);
  assert.ok(Math.abs(rate - 45 / (33 + 1 / 3)) < 1e-9);
  assert.ok(Math.abs(rate - 1.35) < 1e-9);
});

test('rate is signed: a reverse-spun platter yields true negative rate', () => {
  const REF = 33 + 1 / 3;
  assert.ok(rateFromOmega(-omegaNominal(REF), REF) < 0);
  assert.ok(Math.abs(rateFromOmega(-omegaNominal(REF), REF) + 1) < 1e-9);
});

test('rateFromOmega guards against a zero-RPM divide', () => {
  assert.equal(rateFromOmega(5, 0), 0);
});

// ── Platter physics: spin-up, coast, brake, scrub override ───────────────────

const REF_RPM = 33 + 1 / 3;
const target = omegaNominal(REF_RPM);

// Integrate the platter forward for `seconds` under a fixed input.
function settle(state, input, seconds, dt = 1 / 120) {
  let s = state;
  for (let i = 0; i < Math.round(seconds / dt); i++) s = stepPlatter(s, input, dt);
  return s;
}

test('motor winds ω up to target and holds it (spin-up → steady state)', () => {
  let s = createPlatter();
  assert.equal(s.omega, 0);
  s = settle(s, { touching: false, braking: false, omegaTarget: target }, 5);
  // Within 1% of nominal after a few seconds of motor pull.
  assert.ok(Math.abs(s.omega - target) / target < 0.01, `ω=${s.omega} target=${target}`);
});

test('palm brake decays ω to a true stop (motor cooperates, does not fight)', () => {
  // Start at speed, then hold the brake. This is the bug that bit earlier:
  // if the motor kept pulling toward target while braking, ω stalled at ~0.38
  // instead of stopping. Assert it actually reaches a near-dead stop.
  let s = settle(createPlatter(), { touching: false, braking: false, omegaTarget: target }, 5);
  s = settle(s, { touching: false, braking: true, omegaTarget: target }, 3);
  assert.ok(Math.abs(s.omega) < 1e-3, `braked ω=${s.omega}, expected ~0`);
});

test('releasing the brake winds ω back up to speed', () => {
  let s = settle(createPlatter(), { touching: false, braking: true, omegaTarget: target }, 3);
  assert.ok(Math.abs(s.omega) < 1e-3);
  s = settle(s, { touching: false, braking: false, omegaTarget: target }, 5);
  assert.ok(Math.abs(s.omega - target) / target < 0.01, `recovered ω=${s.omega}`);
});

test('a free nudge coasts down via friction when the motor is off', () => {
  // omegaTarget 0 = no motor pull; only friction acts. ω must bleed toward 0
  // but not overshoot into reverse.
  let s = { omega: target, theta: 0 };
  s = settle(s, { touching: false, braking: false, omegaTarget: 0 }, 4);
  assert.ok(s.omega > 0 && s.omega < target, `coasting ω=${s.omega}`);
});

test('finger touch is a kinematic override: ω equals fingerOmega exactly', () => {
  const s = stepPlatter(createPlatter(), {
    touching: true, fingerOmega: -7.5, braking: false, omegaTarget: target,
  }, 1 / 120);
  assert.equal(s.omega, -7.5); // scrub sets ω directly, ignoring motor/friction
});

test('stepPlatter is pure — it never mutates the input state', () => {
  const s0 = createPlatter();
  const s1 = stepPlatter(s0, { touching: false, braking: false, omegaTarget: target }, 1 / 120);
  assert.equal(s0.omega, 0);
  assert.equal(s0.theta, 0);
  assert.notEqual(s1, s0);
});

test('theta accumulates with the sign of ω (drives render rotation)', () => {
  const fwd = stepPlatter({ omega: 0, theta: 0 }, { touching: true, fingerOmega: 4 }, 0.5);
  const rev = stepPlatter({ omega: 0, theta: 0 }, { touching: true, fingerOmega: -4 }, 0.5);
  assert.ok(fwd.theta > 0);
  assert.ok(rev.theta < 0);
});

test('default knobs are frozen so callers copy rather than mutate the shared defaults', () => {
  assert.ok(Object.isFrozen(DEFAULT_PARAMS));
  for (const k of ['J', 'k', 'c', 'brakeDamp']) {
    assert.equal(typeof DEFAULT_PARAMS[k], 'number');
  }
});

// ── Envelope DSP ─────────────────────────────────────────────────────────────

test('computeEnvelope normalizes its loudest bin to 1 and stays within [0,1]', () => {
  const frames = 8000;
  // A ramp from silence to full scale: loudness rises monotonically across bins.
  const getSample = (i) => i / frames;
  const env = computeEnvelope(getSample, frames, 64);
  assert.equal(env.length, 64);
  let max = 0;
  for (const v of env) {
    assert.ok(v >= 0 && v <= 1, `bin out of range: ${v}`);
    if (v > max) max = v;
  }
  assert.ok(Math.abs(max - 1) < 1e-6, `peak bin should be 1, got ${max}`);
  // Loud end brighter than the quiet end.
  assert.ok(env[63] > env[0]);
});

test('computeEnvelope handles silence and empty input without NaNs', () => {
  const silent = computeEnvelope(() => 0, 4000, 32);
  for (const v of silent) assert.ok(Number.isFinite(v) && v === 0, `silent bin=${v}`);
  const empty = computeEnvelope(() => 0, 0, 16);
  assert.equal(empty.length, 16);
  for (const v of empty) assert.equal(v, 0);
});

// ── helpers ──────────────────────────────────────────────────────────────────

test('clamp bounds a value to [lo, hi]', () => {
  assert.equal(clamp(-1, 0, 1), 0);
  assert.equal(clamp(2, 0, 1), 1);
  assert.equal(clamp(0.5, 0, 1), 0.5);
});

test('angleDelta returns the shortest signed path across the ±π wrap', () => {
  // Just under a full turn forward is really a tiny step backward.
  assert.ok(Math.abs(angleDelta(0, TAU - 0.1) - -0.1) < 1e-9);
  // Just over half a turn wraps to the negative side.
  assert.ok(angleDelta(0, Math.PI + 0.1) < 0);
  assert.ok(Math.abs(angleDelta(0, 0.3) - 0.3) < 1e-9);
  // Result always within (-π, π].
  for (let a = -10; a < 10; a += 0.37) {
    const d = angleDelta(0, a);
    assert.ok(d > -Math.PI - 1e-9 && d <= Math.PI + 1e-9, `delta=${d}`);
  }
});
