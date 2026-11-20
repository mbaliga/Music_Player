// spiral.js — the waveform spiral drawn on the disc. Pure typed-array maths (the canvas drawing is in disc-draw.js).
//
// M = 14000 points along the spiral u in [0,1] (u = 0 outer groove ... 1 inner). Point i sits at radius rU[i] = rOf(u) and
// angle thU[i] = thG(u) on the DISC; the disc is rotated by phi(s) = thS(s) - thG(s) so the groove point under the stylus is always
// the one at the stylus (playhead stays put, even while scratching). Each point carries a peak pair envHi/envLo (-1..1); the drawn
// ribbon is r + envHi*amp .. r + envLo*amp, amp = b + (G - b) * exp(-((u - s)/w)^2) * wv   (b .9, G 25, w .17/TURNS):
// the part near the playhead is magnified, the rest tiny.
//
// PEAKS (docs/TURNTABLE.md "Peaks vs the app envelope"): computePeaks needs min/max per bin of the REAL decoded samples. The app's
// computeEnvelope (src/model.js) is a one-sided windowed RMS used for the groove banding and the mixtape level meter; it is not the
// same thing (no sign, different shape), so it is kept for those and this module makes its own single pass over the same decoded
// PCM at load time (O(frames), no allocation beyond the shared env arrays).
import { C, R_START, TURNS, rOf, thG } from './geometry.js';

export const M = 14000;
export { TURNS };
export const AMP = Object.freeze({ base: 0.9, peak: 25, width: 0.17 / TURNS, widthHi: 2.6 });
export const BUMP_STEP = 48;
export const MAX_PER_BIN = 512;       // highlight ribbon chunk (points)

export function makeTables(n = M) {
  const rU = new Float32Array(n), thU = new Float32Array(n), cU = new Float32Array(n), sU = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    rU[i] = rOf(u); thU[i] = thG(u);
    cU[i] = Math.cos(thU[i]); sU[i] = Math.sin(thU[i]);
  }
  return { n, rU, thU, cU, sU };
}

/** envelope buffers (allocated once) */
export function makeEnv(n = M) { return { n, hi: new Float32Array(n), lo: new Float32Array(n) }; }

/**
 * Fill env bins [i0, i1] (inclusive) with the min/max of `frames` mono samples (getSample(i)); normalised by the loudest peak of
 * the range and shaped with pow .8 (the prototype). Returns the normalisation peak. No allocation.
 */
export function computePeaks(env, getSample, frames, i0 = 0, i1 = env.n - 1) {
  const bins = i1 - i0 + 1;
  let pk = 1e-6;
  for (let k = 0; k < bins; k++) {
    const a = Math.floor(k * frames / bins), b = Math.max(a + 1, Math.floor((k + 1) * frames / bins));
    let hi = 0, lo = 0;
    const step = Math.max(1, Math.floor((b - a) / MAX_PER_BIN));   // long files: look at <= MAX_PER_BIN samples per bin (peaks barely change)
    for (let j = a; j < b && j < frames; j += step) { const v = getSample(j); if (v > hi) hi = v; if (v < lo) lo = v; }
    env.hi[i0 + k] = hi; env.lo[i0 + k] = lo;
    if (hi > pk) pk = hi; if (-lo > pk) pk = -lo;
  }
  for (let k = i0; k <= i1; k++) {
    env.hi[k] = Math.pow(env.hi[k] / pk, 0.8);
    env.lo[k] = -Math.pow(-env.lo[k] / pk, 0.8);
  }
  return pk;
}

/** Placeholder groove for an album track that is not decoded yet: a quiet, deterministic texture; gaps are bare vinyl. */
export function fillPlaceholder(env, i0, i1, seed = 1, level = 0.2) {
  let x = (seed * 2654435761) >>> 0;
  for (let i = i0; i <= i1; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const v = level * (0.55 + 0.45 * (x / 4294967296));
    env.hi[i] = v; env.lo[i] = -v;
  }
}
export function fillSilence(env, i0, i1) { for (let i = i0; i <= i1; i++) { env.hi[i] = 0; env.lo[i] = 0; } }

/** bin range of a band in u-space */
export function binRange(uA, uB, n = M) { return [Math.max(0, Math.round(uA * (n - 1))), Math.min(n - 1, Math.round(uB * (n - 1)))]; }

/**
 * Hot loop: write the ribbon outline into pts[4i..4i+3] = (outer x, outer y, inner x, inner y). th0 = disc rotation phi(s).
 * cos/sin of (thU + th0) come from the precomputed cU/sU (angle-addition), so there is no trig and no allocation per point.
 */
export function fillRibbon(pts, T, env, s, wv, th0) {
  const { n, rU, cU, sU } = T;
  const c0 = Math.cos(th0), s0 = Math.sin(th0);
  const { base, peak, width } = AMP;
  const gm = peak - base;
  for (let i = 0; i < n; i++) {
    const d = (i / (n - 1) - s) / width;
    const amp = base + gm * Math.exp(-d * d) * wv;
    const c = cU[i] * c0 - sU[i] * s0, sn = sU[i] * c0 + cU[i] * s0, r = rU[i];
    const ro = r + env.hi[i] * amp + 0.4, ri = r + env.lo[i] * amp - 0.4;
    const k = 4 * i;
    pts[k] = C.x + ro * c; pts[k + 1] = C.y + ro * sn;
    pts[k + 2] = C.x + ri * c; pts[k + 3] = C.y + ri * sn;
  }
}
/** playhead index and the highlight window */
export function playIndex(s, n = M) { return Math.max(0, Math.min(n - 1, Math.round(s * (n - 1)))); }
export function highlightRange(iS, n = M) {
  const wi = Math.round(AMP.width * AMP.widthHi * (n - 1));
  return [Math.max(0, iS - wi), Math.min(n - 1, iS + wi)];
}
export const highlightAlpha = (uc, s, wv) => { const dd = (uc - s) / AMP.width; return Math.exp(-dd * dd) * 0.55 * wv; };
export { R_START };
