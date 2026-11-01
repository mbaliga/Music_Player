// SPIKE P1 -- THROWAWAY. Synthetic "speech-like" signals. NOT speech, NOT TTS: a harmonic
// source (f0 with vibrato) through formant-ish resonators with a ~4 Hz syllable envelope and
// fricative-like noise bursts. Broadband and non-stationary enough to exercise an echo canceller
// and an energy VAD better than a pure tone would; it says nothing about real-voice behaviour.
import { mulberry32, gauss } from './rng.mjs';

export function speechLike(sampleRate, ms, { seed = 1, f0 = 125, level = 0.3 } = {}) {
  const n = Math.round((sampleRate * ms) / 1000);
  const out = new Float32Array(n);
  const rng = mulberry32(seed);
  // Two-pole resonators for F1/F2/F3 at typical vowel-ish centers.
  const formants = [[700, 110], [1200, 130], [2600, 180]].map(([fc, bw]) => {
    const r = Math.exp((-Math.PI * bw) / sampleRate), th = (2 * Math.PI * fc) / sampleRate;
    return { a1: 2 * r * Math.cos(th), a2: -r * r, y1: 0, y2: 0 };
  });
  let phase = 0;
  const syl = 3.5 + rng() * 1.5; // syllables per second
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const f = f0 * (1 + 0.04 * Math.sin(2 * Math.PI * 5 * t) + 0.06 * Math.sin(2 * Math.PI * 0.7 * t));
    phase += (2 * Math.PI * f) / sampleRate;
    // glottal-ish pulse train: sawtooth-derived impulses
    const saw = (phase / (2 * Math.PI)) % 1;
    const src = (saw < 0.1 ? 1 - saw * 10 : -0.1) + 0.02 * gauss(rng);
    const env = Math.max(0, Math.sin(Math.PI * ((t * syl) % 1))) ** 1.5;
    let y = 0;
    for (const fm of formants) { const v = src + fm.a1 * fm.y1 + fm.a2 * fm.y2; fm.y2 = fm.y1; fm.y1 = v; y += v * 0.02; }
    const fric = (Math.floor(t * syl * 2) % 5 === 0 ? 0.25 : 0) * gauss(rng) * 0.3;
    out[i] = (y * env + fric * env) * level;
  }
  // normalize peak to `level`
  let pk = 1e-9; for (const v of out) pk = Math.max(pk, Math.abs(v));
  for (let i = 0; i < n; i++) out[i] *= level / pk;
  return out;
}

/** Fill with seeded white noise at the given dBFS (RMS). */
export function noise(sampleRate, ms, db = -60, seed = 7) {
  const n = Math.round((sampleRate * ms) / 1000), a = 10 ** (db / 20), rng = mulberry32(seed);
  const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = a * gauss(rng); return out;
}

/**
 * Build an utterance: [lead silence][speech][trail silence] plus background noise.
 * Truth: speechEndMs is the exact end of the speech segment (what the budget's t0 means).
 */
export function utterance(sampleRate, { leadMs = 500, speechMs = 1200, trailMs = 1500, noiseDb = -60, level = 0.3, seed = 3 } = {}) {
  const total = leadMs + speechMs + trailMs;
  const out = noise(sampleRate, total, noiseDb, seed + 100);
  const sp = speechLike(sampleRate, speechMs, { seed, level });
  const start = Math.round((sampleRate * leadMs) / 1000);
  // 5 ms fade in/out so the edge is not an artificial click
  const fade = Math.round(sampleRate * 0.005);
  for (let i = 0; i < sp.length; i++) {
    const g = Math.min(1, i / fade, (sp.length - 1 - i) / fade);
    out[start + i] += sp[i] * g;
  }
  return { samples: out, sampleRate, truth: { speechStartMs: leadMs, speechEndMs: leadMs + speechMs, totalMs: total } };
}
