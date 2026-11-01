// SPIKE P1 -- THROWAWAY. Residual-echo analysis for the full-duplex question (architecture doc 8.5).
// Pure (no DOM): given the REFERENCE signal that was played and the CAPTURE from the mic (recorded
// on the same AudioContext clock, with a silent baseline before playback), estimate
//   - acoustic round-trip lag (output + air + input latency)
//   - how much of the reference shows up in the capture (single-tap fit: gain, correlation)
//   - how far the capture during playback sits above the pre-playback noise floor
// Limits (also in the doc): single-tap fit under-reports echo through a reverberant path; this is
// SINGLE-TALK (user silent). Double-talk behaviour of an AEC is NOT measured here.

export const rms = (a, from = 0, to = a.length) => {
  let e = 0; for (let i = from; i < to; i++) e += a[i] * a[i];
  return Math.sqrt(e / Math.max(1, to - from));
};
export const toDb = (x) => 20 * Math.log10(Math.max(x, 1e-9));

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

/** In-place iterative radix-2 FFT on separate re/im Float64Arrays (length power of two). */
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/** c[lag] = sum_n x[n] * y[n+lag] for lag in [0, maxLag]. FFT-based. */
export function crossCorrelate(x, y, maxLag) {
  const N = nextPow2(x.length + y.length);
  const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  ar.set(x); br.set(y);
  fft(ar, ai); fft(br, bi);
  // conj(A) * B
  for (let i = 0; i < N; i++) {
    const r = ar[i] * br[i] + ai[i] * bi[i], im = ar[i] * bi[i] - ai[i] * br[i];
    ar[i] = r; ai[i] = im;
  }
  fft(ar, ai, true);
  const out = new Float64Array(maxLag + 1);
  for (let l = 0; l <= maxLag; l++) out[l] = ar[l];
  return out;
}

/**
 * @param {Float32Array} ref  signal that was played (mono, at `sampleRate`)
 * @param {Float32Array} cap  mic capture (mono, same rate), containing [baseline][playback...]
 * @param {number} sampleRate
 * @param {{playStartSample:number, maxLagMs?:number, settleMs?:number}} o
 *        playStartSample = index in `cap` at which playback was scheduled to start (baseline = cap[0..playStart)).
 */
export function echoMetrics(ref, cap, sampleRate, o) {
  const maxLag = Math.round(((o.maxLagMs ?? 600) * sampleRate) / 1000);
  const settle = Math.round(((o.settleMs ?? 200) * sampleRate) / 1000);
  const base0 = Math.min(settle, Math.max(0, o.playStartSample - 1));
  const noiseFloor = rms(cap, base0, o.playStartSample);
  const win = cap.subarray(o.playStartSample, Math.min(cap.length, o.playStartSample + ref.length + maxLag));
  const c = crossCorrelate(ref, win, Math.min(maxLag, Math.max(0, win.length - 1)));
  const refE = ref.reduce((a, v) => a + v * v, 0);
  // normalise by the energy of the matching capture segment at each lag (prefix sums)
  const pre = new Float64Array(win.length + 1);
  for (let i = 0; i < win.length; i++) pre[i + 1] = pre[i] + win[i] * win[i];
  let best = 0, bestLag = 0, bestCorr = 0;
  for (let l = 0; l < c.length; l++) {
    const end = Math.min(win.length, l + ref.length);
    const segE = pre[end] - pre[l];
    const rho = segE > 0 && refE > 0 ? c[l] / Math.sqrt(refE * segE) : 0;
    if (Math.abs(rho) > Math.abs(best)) { best = rho; bestLag = l; bestCorr = c[l]; }
  }
  const gain = refE > 0 ? bestCorr / refE : 0;             // amplitude coupling at best lag
  const playRms = rms(win, bestLag, Math.min(win.length, bestLag + ref.length));
  return {
    lagMs: (bestLag / sampleRate) * 1000,
    rho: Math.abs(best),
    echoReturnDb: 20 * Math.log10(Math.max(Math.abs(gain), 1e-9)),   // fitted echo level relative to reference (0 dB = full-scale coupling)
    noiseFloorDb: toDb(noiseFloor),
    playbackRmsDb: toDb(playRms),
    excessDb: toDb(playRms) - toDb(noiseFloor),                       // capture during playback vs pre-playback floor
    refRmsDb: toDb(rms(ref)),
  };
}

/**
 * Spike-defined heuristic on excessDb, NOT a validated threshold. Intent: "would a barge-in VAD listening to this
 * capture be fooled by the RJ's own voice?"
 */
export function classifyEcho(m) {
  // rho is detection CONFIDENCE (is there a coupled copy at all), not severity: it depends on the noise
  // floor. Severity is excessDb: how far the mic during playback sits above its own pre-playback floor.
  if (m.excessDb <= 3) return 'clean';
  if (m.excessDb <= 10) return 'marginal';
  return 'leaky';
}

/** Test helper / harness self-check: build a capture = noise + delayed, attenuated copy of ref. */
export function simulateEcho(ref, sampleRate, { baselineMs = 800, delayMs = 80, gainDb = -20, noiseDb = -60, tailMs = 700, noiseFn } = {}) {
  const base = Math.round((baselineMs * sampleRate) / 1000), d = Math.round((delayMs * sampleRate) / 1000);
  const cap = new Float32Array(base + ref.length + Math.round((tailMs * sampleRate) / 1000));
  const g = 10 ** (gainDb / 20);
  for (let i = 0; i < ref.length; i++) cap[base + d + i] += ref[i] * g;
  const nz = noiseFn ? noiseFn(cap.length) : null;
  if (nz) for (let i = 0; i < cap.length; i++) cap[i] += nz[i] * 10 ** (noiseDb / 20);
  return { cap, playStartSample: base };
}
