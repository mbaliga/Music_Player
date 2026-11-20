// ─────────────────────────────────────────────────────────────────────────────
// tempo.js — a small tempo estimator (pure, deterministic, never throws).
//
//   onsetEnvelope(channels, frames, sampleRate, {startFrame, maxSeconds})  -> { env: Float32Array, hopSec }
//   tempoFromOnsets(env, hopSec, opts)                                     -> { bpm, confidence, ... } | null
//   estimateTempo(channels, frames, sampleRate, opts)                      both steps
//
// Method (classic and deliberately simple, so it is honest about its limits):
//   1. onset strength = half-wave-rectified rise of the log energy of the first-difference (high-passed) signal, per hop;
//   2. autocorrelation of that onset curve over lags covering 60..180 BPM, with the pulse-train multiples (2x, 4x lag)
//      added so a steady beat beats its own sub-harmonics, and a gentle log-normal prior around 110 BPM;
//   3. parabolic interpolation of the best lag; confidence = how far the winner stands above the lag-score median.
// NOT a beat tracker: it yields ONE global tempo (no phase, no tempo changes), analyses at most `maxSeconds` of the track and can be
// an octave off on ambiguous material (the UI offers a half/double fix). Music without clear transients returns low confidence.
// ─────────────────────────────────────────────────────────────────────────────

export const TEMPO_KNOBS = Object.freeze({
  hopSec: 0.0058,       // onset-curve resolution
  minBpm: 60, maxBpm: 180,
  maxSeconds: 60,       // analysis window
  minOnset: 0.5,        // largest log-energy rise that counts as a transient at all
  priorBpm: 110, priorOctaves: 1.1,   // log-normal prior centre / width (in octaves)
});

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export function onsetEnvelope(channels, frames, sampleRate, opts = {}) {
  const K = { ...TEMPO_KNOBS, ...opts };
  const none = { env: new Float32Array(0), hopSec: K.hopSec };
  if (!channels || !channels[0] || !(frames > 0) || !(sampleRate > 0)) return none;
  const L = channels[0], R = channels[1] || null;
  const hop = Math.max(16, Math.round(K.hopSec * sampleRate));
  const span = Math.min(frames, Math.round(K.maxSeconds * sampleRate));
  // skip the first 5 % (silence / fade-ins) when the track is longer than the window
  const start = opts.startFrame != null ? Math.max(0, Math.min(frames - span, opts.startFrame | 0)) : Math.max(0, Math.min(frames - span, Math.round(frames * 0.05)));
  const nHops = Math.floor(span / hop);
  if (nHops < 8) return none;
  const e = new Float32Array(nHops);
  let prev = (L[start] + (R ? R[start] : L[start])) * 0.5;
  for (let h = 0; h < nHops; h++) {
    let sum = 0;
    const base = start + h * hop;
    for (let i = 0; i < hop; i++) {
      const x = (L[base + i] + (R ? R[base + i] : L[base + i])) * 0.5;
      const d = x - prev; prev = x; sum += d * d;
    }
    e[h] = Math.log(1e-9 + sum / hop);
  }
  const env = new Float32Array(nHops);
  for (let h = 1; h < nHops; h++) { const r = e[h] - e[h - 1]; env[h] = r > 0 ? r : 0; }
  // remove the local mean so the autocorrelation sees pulses, not a pedestal
  const w = Math.max(4, Math.round(0.4 / (hop / sampleRate)));
  const out = new Float32Array(nHops);
  let acc = 0;
  for (let h = 0; h < nHops; h++) {
    acc += env[h]; if (h >= w) acc -= env[h - w];
    const m = acc / Math.min(h + 1, w);
    out[h] = Math.max(0, env[h] - m * 1.0);
  }
  return { env: out, hopSec: hop / sampleRate };
}

export function tempoFromOnsets(env, hopSec, opts = {}) {
  const K = { ...TEMPO_KNOBS, ...opts };
  if (!env || env.length < 64 || !(hopSec > 0)) return null;
  const n = env.length;
  let e0 = 0;
  for (let i = 0; i < n; i++) e0 += env[i] * env[i];
  if (!(e0 > 1e-6)) return null;
  let pk = 0;
  for (let i = 0; i < n; i++) if (env[i] > pk) pk = env[i];
  if (pk < K.minOnset) return null;   // no real transients (a held tone's energy ripple is not a beat)
  const lagMin = Math.max(2, Math.floor(60 / K.maxBpm / hopSec) - 1);
  const lagMax = Math.min(Math.floor(n / 3), Math.ceil(60 / K.minBpm / hopSec) + 1);
  if (lagMax <= lagMin + 2) return null;
  const maxLag = Math.min(n - 2, lagMax * 4 + 2);
  const ac = new Float64Array(maxLag + 1);
  for (let lag = lagMin - 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
    ac[lag] = s / (n - lag);                       // unbiased
  }
  const norm = e0 / n;
  const at = (l) => (l <= maxLag ? ac[l] : 0);
  const score = new Float64Array(lagMax + 2);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let sc = at(lag) + 0.5 * at(lag * 2) + 0.25 * at(lag * 4);
    const bpm = 60 / (lag * hopSec);
    const oct = Math.log2(bpm / K.priorBpm) / K.priorOctaves;
    sc *= Math.exp(-0.5 * oct * oct);
    score[lag] = sc / norm;
  }
  let best = lagMin, bv = -1;
  for (let lag = lagMin; lag <= lagMax; lag++) if (score[lag] > bv) { bv = score[lag]; best = lag; }
  if (!(bv > 0)) return null;
  // parabolic refinement on the raw autocorrelation around the winner
  let lagF = best;
  if (best > lagMin && best < lagMax) {
    const a = ac[best - 1], b = ac[best], c = ac[best + 1];
    const den = a - 2 * b + c;
    if (den < 0) lagF = best + Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den));
  }
  const sorted = Array.from(score.subarray(lagMin, lagMax + 1)).sort((x, y) => x - y);
  const med = sorted[sorted.length >> 1];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  // confidence: peak height over the typical lag score, squashed to 0..1; plus periodicity strength itself (ac peak / ac(0))
  const prom = (bv - med) / (bv + 1e-12);
  const per = Math.max(0, Math.min(1, at(best) / norm));
  const confidence = Math.max(0, Math.min(1, prom * Math.min(1, per * 2.2)));
  const bpm = 60 / (lagF * hopSec);
  return { bpm: Math.round(bpm * 100) / 100, confidence: Math.round(confidence * 1000) / 1000, lagSec: lagF * hopSec, periodicity: Math.round(per * 1000) / 1000, q3Ratio: q3 > 0 ? bv / q3 : 0 };
}

/** Both steps. Returns null on junk input, otherwise { bpm, confidence, ... }. */
export function estimateTempo(channels, frames, sampleRate, opts = {}) {
  try {
    if (!isNum(frames) || !isNum(sampleRate)) return null;
    const { env, hopSec } = onsetEnvelope(channels, frames, sampleRate, opts);
    return tempoFromOnsets(env, hopSec, opts);
  } catch { return null; }
}
