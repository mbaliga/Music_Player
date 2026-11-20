// ─────────────────────────────────────────────────────────────────────────────
// dsp.js — pure helpers for the effects bus: a generated reverb impulse response (no audio files) and ramp constants.
// ─────────────────────────────────────────────────────────────────────────────

export const BUS_KNOBS = Object.freeze({
  rampTau: 0.02,         // s: setTargetAtTime time constant for every audible parameter (no zipper noise)
  engageTau: 0.012,      // s: dry <-> filtered crossfade
  irSeconds: 1.6,        // reverb length
  irDecay: 5.5,          // exponential decay constant: amplitude ~ exp(-decay * t / seconds)
  tailSeconds: 5,        // how long the echo/reverb chain stays up after release (the tail rings out), then it is torn down
  damping: 3800,         // Hz: low-pass inside the delay feedback loop
  maxDelay: 2,           // s
});

function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/**
 * A small algorithmic reverb impulse response: decaying noise, a short pre-delay, a gentle high-frequency roll-off that deepens over time,
 * decorrelated left/right. Deterministic for a seed. -> [Float32Array L, Float32Array R] (peak-normalised to 0.5, then energy-trimmed).
 */
export function makeImpulseResponse(sampleRate, seconds = BUS_KNOBS.irSeconds, decay = BUS_KNOBS.irDecay, seed = 1) {
  const n = Math.max(64, Math.round(sampleRate * seconds));
  const pre = Math.round(sampleRate * 0.012);
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let ch = 0; ch < 2; ch++) {
    const r = mulberry32(seed * 7919 + ch * 104729 + 13);
    const d = out[ch];
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / (n - pre);
      const a = 0.18 + 0.82 * Math.min(1, (i - pre) / (sampleRate * 0.04)); // soft onset
      const coef = 0.55 + 0.4 * t;                                            // more high cut as it decays
      lp += (1 - coef) * ((r() * 2 - 1) - lp);
      d[i] = lp * Math.exp(-decay * t) * a;
    }
    // fade the last 5 % to exactly zero so the convolver never ends on a step
    const f = Math.floor(n * 0.05);
    for (let i = 0; i < f; i++) d[n - 1 - i] *= i / f;
  }
  let pk = 0;
  for (const d of out) for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
  const g = pk > 0 ? 0.5 / pk : 1;
  for (const d of out) for (let i = 0; i < d.length; i++) d[i] *= g;
  return out;
}

/** RMS energy fraction of the IR that lies in [t0, t1] seconds (test helper and sanity metric). */
export function irEnergy(ir, sampleRate, t0, t1) {
  const d = ir[0]; let tot = 0, part = 0;
  for (let i = 0; i < d.length; i++) { const e = d[i] * d[i]; tot += e; const t = i / sampleRate; if (t >= t0 && t < t1) part += e; }
  return tot > 0 ? part / tot : 0;
}
