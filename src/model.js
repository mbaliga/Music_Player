// ─────────────────────────────────────────────────────────────────────────────
// model.js — the portable model layer (spiral groove + platter physics)
//
// This is the highest-leverage layer in the system (spec §8). It is written as
// pure, framework-free functions and plain state objects so it survives the
// web → native Android port intact. NOTHING in here may touch the DOM, the Web
// Audio API, canvas, or any browser global. If it does, it can't be ported.
//
// The single source of truth for playback is audio time `t ∈ [0, T]`, owned by
// the audio worklet. Everything here either DERIVES a display value from `t`
// (the needle radius) or DRIVES `rate` (the platter physics). See spec §2.
// ─────────────────────────────────────────────────────────────────────────────

export const TAU = Math.PI * 2;

// ── Spiral geometry ──────────────────────────────────────────────────────────
// Vinyl is constant-angular-velocity: one revolution is always the same amount
// of audio time, everywhere on the disc. So the needle radius is a pure linear
// readout of progress, and placing the needle inverts that readout into a seek.

/** Needle radius as a DISPLAY of progress. r(t) walks inward as t advances. */
export function radiusAtTime(t, T, rOut, rIn) {
  const u = T > 0 ? clamp(t / T, 0, 1) : 0;
  return rOut - (rOut - rIn) * u;
}

/** Placing the needle at radius r INVERTS the readout into a seek time. */
export function timeAtRadius(r, T, rOut, rIn) {
  const span = rOut - rIn;
  const u = span !== 0 ? clamp((rOut - r) / span, 0, 1) : 0;
  return u * T;
}

/** Nominal angular velocity (rad/s) for a given RPM setting. */
export function omegaNominal(rpm) {
  return (TAU * rpm) / 60;
}

/** Seconds of audio per platter revolution (1.8 s at 33⅓ RPM). */
export function secondsPerRev(rpm) {
  return 60 / rpm;
}

// ── Platter physics — a small 1-DOF rotational sim (spec §4) ─────────────────
// This is where the *feel* lives, so every constant is an exposed tunable knob.
// State is angular velocity ω and accumulated angle θ (for render only).

/** Default tuning knobs. v0's main job is dialing these by hand. */
export const DEFAULT_PARAMS = Object.freeze({
  J: 0.45,        // inertia — platter weight / flick momentum (higher = heavier)
  k: 9.0,         // motor gain — how fast ω recovers to target after release
  c: 0.6,         // friction — how long a free nudge coasts before decaying
  brakeDamp: 14.0 // palm-brake damping — power-down strength toward ω = 0
});

/** Create a fresh platter state. */
export function createPlatter() {
  return { omega: 0, theta: 0 };
}

/**
 * Advance the platter one frame. Pure: returns a NEW state, never mutates.
 *
 *   input = {
 *     touching:    bool   — finger on the platter (kinematic override)
 *     fingerOmega: number — finger angular velocity (rad/s), used when touching
 *     braking:     bool   — palm hold engaged
 *     omegaTarget: number — motor target (= omegaNominal(rpm) when playing, else 0)
 *   }
 *
 * While touching, ω is set directly from the finger (the scrub). Otherwise the
 * motor pulls ω toward target, friction bleeds it, and the brake (if held) adds
 * strong damping toward zero — the audible spin-up / coast / power-down.
 */
export function stepPlatter(state, input, dt, params = DEFAULT_PARAMS) {
  let { omega, theta } = state;

  if (input.touching) {
    // Finger overrides the motor — ω is kinematic, derived from drag angle.
    omega = input.fingerOmega;
  } else {
    // While braking the platter is pinned under the palm: the motor stalls
    // against it (target → 0) rather than fighting the brake, so ω decays to a
    // true stop and then winds back up on release.
    const motorTarget = input.braking ? 0 : input.omegaTarget;
    // Direct-drive servo: a proportional pull toward target PLUS feed-forward
    // compensation for the bearing friction it must hold against. Without the
    // feed-forward term, steady state settles where motor pull equals friction
    // drag — ω_ss = target·k/(k+c), i.e. ~6% slow at the default knobs, so the
    // record plays flat and the `k` knob would detune pitch as a side effect.
    // The +c·motorTarget term cancels friction at ω = target, locking nominal
    // speed (and reducing to pure damping when motorTarget → 0 under the brake).
    const motor = params.k * (motorTarget - omega) + params.c * motorTarget;
    const friction = -params.c * omega;
    const brake = input.braking ? -params.brakeDamp * omega : 0;
    const torque = motor + friction + brake;
    omega += (torque / params.J) * dt;
  }

  theta += omega * dt;
  return { omega, theta };
}

/** Playback rate is platter angular velocity normalized to nominal RPM. */
export function rateFromOmega(omega, rpm) {
  const wn = omegaNominal(rpm);
  return wn !== 0 ? omega / wn : 0;
}

// ── Multi-resolution envelope (spec §9) ──────────────────────────────────────
// The groove IS the waveform: windowed RMS drives the brightness/thickness
// banding so the disc shows its own dynamics. Computed once per track. Pure DSP
// over a Float32 channel — no platform deps, so the precompute ports cleanly.

/**
 * Windowed RMS envelope over an interleaved-or-planar mono mixdown.
 * `getSample(i)` returns the mono sample at frame i; `frames` is the length.
 * Returns Float32Array of `bins` RMS values normalized to [0, 1].
 */
export function computeEnvelope(getSample, frames, bins) {
  const env = new Float32Array(bins);
  if (frames <= 0) return env;
  const win = Math.max(1, Math.floor(frames / bins));
  let peak = 1e-9;
  for (let b = 0; b < bins; b++) {
    const start = Math.floor((b / bins) * frames);
    let sum = 0;
    let n = 0;
    for (let i = start; i < start + win && i < frames; i++) {
      const s = getSample(i);
      sum += s * s;
      n++;
    }
    const rms = n > 0 ? Math.sqrt(sum / n) : 0;
    env[b] = rms;
    if (rms > peak) peak = rms;
  }
  // Normalize and apply a mild curve so quiet detail stays visible.
  for (let b = 0; b < bins; b++) {
    env[b] = Math.pow(env[b] / peak, 0.6);
  }
  return env;
}

// ── helpers ──────────────────────────────────────────────────────────────────
export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Shortest signed angular difference a→b, in (-π, π]. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
