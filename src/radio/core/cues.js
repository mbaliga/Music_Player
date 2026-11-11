// ─────────────────────────────────────────────────────────────────────────────
// cues.js — per-track cue extraction (architecture 4.5): introEnd, outroStart, trims, loudness.
//
// Pure, dependency-free, never throws (junk in -> a result with null cues, confidence 'low' and a
// `warnings[]` entry). Deterministic: same input -> identical output, no clock, no randomness.
//
// TWO ENTRY POINTS
//   extractCuesFromEnvelope(env, {durationSec, ...})  cheap: O(bins) over an RMS envelope you already have
//   extractCuesFromPcm(pcm, opts)                     one pass over raw PCM (optionally BS.1770 loudness)
//   (`extractCues(input, opts)` dispatches on the shape of its first argument.)
//
// ENVELOPE CONVENTION. `model.js computeEnvelope` returns bins normalised to [0,1] after `pow(x/peak, 0.6)`.
// This file cannot import model.js (core purity), so it re-states the convention: pass `{curve: 0.6}`
// (the default) for such an envelope and the curve is inverted before analysis. For an envelope of
// ABSOLUTE linear RMS (what the PCM path builds internally) pass `{absolute: true}`; only then can an
// approximate loudness be reported. A normalised envelope carries no absolute level, so loudness is null.
//
// UNITS. All times are seconds from the start of the decoded file (so they are comparable with
// `durationSec`, same as the hand-set `cues.introEndSec/outroStartSec` the scheduler already consumes).
//
// HONESTY NOTES
//  * Loudness from PCM is a real ITU-R BS.1770-4 integrated loudness: K-weighting + 400 ms blocks at 75 %
//    overlap + -70 LUFS absolute and -10 LU relative gates, mono treated as dual-mono. It is verified only
//    against analytic sine references (see test/radio-core/cues.test.mjs), NOT against the official EBU
//    Tech 3341/3342 test wavs, and the 100 ms sub-block is rounded to whole samples. Call it
//    "BS.1770-style LUFS", not "certified EBU R128". True-peak is NOT measured (sample peak only).
//  * Loudness from an absolute envelope is an unweighted-RMS approximation (no K-filter): expect a few LU of
//    error on real music. Its `loudness.method` says which one you got.
//  * introEnd is "first sustained rise to a stable level", i.e. when the main section starts. It is NOT a
//    vocal detector: a song whose vocals enter after a long full-band intro reports the band entry, and a
//    song with a gentle crescendo or a slow build gets a low confidence or null. It has only been tested on
//    synthetic signals. Treat confidence as a prior, not a measurement.
// ─────────────────────────────────────────────────────────────────────────────

export const CUES_VERSION = 1;

export const CUE_DEFAULTS = Object.freeze({
  targetLufs: -16,        // streaming-ish playback target; loudnessGainDb = target - measured, clamped
  maxGainDb: 12,
  envHopSec: 0.1,         // PCM path: RMS envelope resolution
  smoothSec: 0.5,         // moving-average window applied before level comparisons
  trimDbBelowRef: -40,    // "silence" = below ref level by this much (and below the absolute floor)
  absFloor: 3.2e-4,       // about -70 dBFS RMS, treated as digital silence
  riseFrac: 0.7,          // intro ends when the smoothed level first reaches this fraction of body level...
  holdFrac: 0.6,          // ...and stays above this for sustainSec
  sustainSec: 4,
  minIntroSec: 1.5,       // a rise earlier than this (after the active start) is "no intro"
  maxIntroFrac: 0.4,      // intro longer than this fraction of the track is not believed
  outroHoldFrac: 0.8,    // last point still at >= this fraction of body level (so a fade is caught early)
  outroSustainSec: 2,
  minTailSec: 1.5,        // shorter decay than this is an abrupt end (no outro cue)
  minAnalysisSec: 3,      // shorter clips: only trims and loudness
});

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const round = (x, d = 3) => { const k = 10 ** d; return Math.round(x * k) / k; };
const label = (c) => (c >= 0.75 ? 'high' : c >= 0.4 ? 'med' : 'low');
const dB = (x) => 20 * Math.log10(x);

function emptyResult(method, durationSec, warnings) {
  const nul = (reason) => ({ sec: null, confidence: 0, reason });
  return {
    schema: 'runout/cues/1', method, durationSec: isNum(durationSec) ? round(durationSec) : 0,
    cues: { introEndSec: null, outroStartSec: null, startTrimSec: 0, endTrimSec: 0, confidence: 'low' },
    detail: {
      introEnd: nul('no_signal'), outroStart: nul('no_signal'),
      startTrim: { sec: 0, confidence: 0, reason: 'no_signal' }, endTrim: { sec: 0, confidence: 0, reason: 'no_signal' },
      loudness: { lufs: null, method: 'none', gated: false, confidence: 0, gainDb: null, samplePeak: null },
    },
    warnings,
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1) + 0.5)));
  return sorted[i];
}

// ── envelope analysis ────────────────────────────────────────────────────────

/**
 * env: ArrayLike<number>. opts: {durationSec (required), curve=0.6 | null, absolute=false, ...CUE_DEFAULTS overrides,
 * loudness: precomputed {lufs, method, gated, confidence, samplePeak} (PCM path)}.
 * -> { schema, method, durationSec, cues, detail, warnings }
 */
export function extractCuesFromEnvelope(env, opts = {}) {
  try { return analyseEnvelope(env, opts); } catch (e) {
    return emptyResult('envelope', opts && opts.durationSec, ['internal_error']);
  }
}

function analyseEnvelope(env, opts) {
  const o = { ...CUE_DEFAULTS, ...(opts && typeof opts === 'object' ? opts : {}) };
  const warnings = [];
  const n = env && typeof env.length === 'number' ? env.length : 0;
  let durationSec = o.durationSec;
  if (!isNum(durationSec) || durationSec <= 0) { return emptyResult('envelope', 0, ['bad_duration']); }
  if (n < 2) return emptyResult('envelope', durationSec, ['empty_envelope']);
  const binSec = durationSec / n;
  const absolute = !!o.absolute;
  const curve = absolute ? null : (o.curve === null ? null : isNum(o.curve) && o.curve > 0 ? o.curve : 0.6);

  const lin = new Float64Array(n);
  let bad = 0, peak = 0;
  for (let i = 0; i < n; i++) {
    let v = env[i];
    if (!isNum(v) || v < 0) { v = 0; bad++; }
    if (curve) v = Math.pow(Math.min(v, 1e6), 1 / curve);
    lin[i] = v;
    if (v > peak) peak = v;
  }
  if (bad) warnings.push(`sanitized_${bad}_bins`);
  const res = emptyResult(absolute ? 'envelope-absolute' : 'envelope-normalised', durationSec, warnings);
  res.cues.confidence = 'low';
  const floor = absolute ? o.absFloor : 1e-3;
  if (!(peak > floor)) { warnings.push('silent'); attachLoudness(res, o, lin, binSec, absolute); return res; }

  const sorted = Array.from(lin).sort((a, b) => a - b);
  const ref = percentile(sorted, 0.95);
  const thr = Math.max(ref * 10 ** (o.trimDbBelowRef / 20), absolute ? o.absFloor : 0);

  // active region [a, b] (two consecutive bins above thr, so a click does not count)
  let a = -1, b = -1;
  for (let i = 0; i < n; i++) if (lin[i] >= thr && (i === n - 1 || lin[i + 1] >= thr)) { a = i; break; }
  for (let i = n - 1; i >= 0; i--) if (lin[i] >= thr && (i === 0 || lin[i - 1] >= thr)) { b = i; break; }
  if (a < 0 || b < a) { warnings.push('silent'); attachLoudness(res, o, lin, binSec, absolute); return res; }
  const startTrim = a * binSec;
  const endTrim = Math.max(0, durationSec - (b + 1) * binSec);
  const longEnough = durationSec >= o.minAnalysisSec;
  res.detail.startTrim = { sec: round(startTrim), confidence: longEnough ? 0.9 : 0.5, reason: startTrim > 0 ? 'leading_silence' : 'none' };
  res.detail.endTrim = { sec: round(endTrim), confidence: longEnough ? 0.9 : 0.5, reason: endTrim > 0 ? 'trailing_silence' : 'none' };
  res.cues.startTrimSec = round(startTrim);
  res.cues.endTrimSec = round(endTrim);

  attachLoudness(res, o, lin, binSec, absolute);

  if (!longEnough) {
    warnings.push('too_short_for_structure');
    const why = 'too_short';
    res.detail.introEnd = { sec: null, confidence: 0, reason: why };
    res.detail.outroStart = { sec: null, confidence: 0, reason: why };
    finish(res);
    return res;
  }

  // smoothed level (centered moving average via prefix sums)
  const w = Math.max(1, Math.round(o.smoothSec / binSec));
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + lin[i];
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - (w >> 1)), hi = Math.min(n, lo + w);
    s[i] = (pre[hi] - pre[lo]) / (hi - lo);
  }
  const act = [];
  for (let i = a; i <= b; i++) act.push(s[i]);
  act.sort((x, y) => x - y);
  const B = percentile(act, 0.75);
  if (!(B > 0)) { warnings.push('no_body_level'); finish(res); return res; }
  const sustainBins = Math.max(1, Math.round(o.sustainSec / binSec));

  // introEnd
  let rise = -1;
  for (let i = a; i <= b; i++) {
    if (s[i] < o.riseFrac * B) continue;
    let ok = true;
    const end = Math.min(b, i + sustainBins);
    for (let k = i; k <= end; k++) if (s[k] < o.holdFrac * B) { ok = false; break; }
    if (ok) { rise = i; break; }
  }
  const aSec = a * binSec;
  if (rise < 0) {
    res.detail.introEnd = { sec: null, confidence: 0, reason: 'no_stable_level' };
  } else {
    const riseSec = (rise + 0.5) * binSec;
    if (riseSec - aSec < o.minIntroSec) {
      res.detail.introEnd = { sec: null, confidence: 0.8, reason: 'no_intro' };
    } else if (riseSec > o.maxIntroFrac * durationSec) {
      res.detail.introEnd = { sec: null, confidence: 0, reason: 'intro_too_long' };
    } else {
      // contrast: level before the rise vs body; sharpness: time to climb from 0.3 B to the rise level
      const p0 = a, p1 = Math.max(a + 1, rise - Math.round(0.5 / binSec));
      let sum = 0;
      for (let i = p0; i < p1; i++) sum += lin[i];
      const ratio = sum / (p1 - p0) / B;
      let j = rise;
      while (j > a && s[j - 1] > 0.3 * B) j--;
      const climbSec = (rise - j) * binSec;
      let c = 0.35;
      if (ratio < 0.5 && climbSec <= 3) c = 0.9;
      else if (ratio < 0.7) c = 0.6;
      res.detail.introEnd = { sec: round(riseSec), confidence: c, reason: ratio < 0.5 ? 'step_rise' : 'gradual_rise' };
    }
  }

  // outroStart
  const holdBins = Math.max(1, Math.round(o.outroSustainSec / binSec));
  let last = -1;
  for (let j = b; j >= a; j--) {
    if (s[j] < o.outroHoldFrac * B) continue;
    let ok = true;
    for (let k = Math.max(a, j - holdBins); k <= j; k++) if (s[k] < 0.7 * B) { ok = false; break; }
    if (ok) { last = j; break; }
  }
  if (last < 0) {
    res.detail.outroStart = { sec: null, confidence: 0, reason: 'no_sustained_level' };
  } else {
    const outSec = (last + 0.5) * binSec;
    const tail = (b + 1) * binSec - outSec;
    const introSec = res.detail.introEnd.sec;
    if (tail < o.minTailSec) res.detail.outroStart = { sec: null, confidence: 0.7, reason: 'abrupt_end' };
    else if (introSec !== null && outSec <= introSec) res.detail.outroStart = { sec: null, confidence: 0, reason: 'before_intro_end' };
    else {
      const mid = Math.min(b, last + Math.round(tail / 2 / binSec));
      const decays = s[mid] < s[last];
      res.detail.outroStart = { sec: round(outSec), confidence: tail >= 3 && decays ? 0.85 : 0.55, reason: tail >= 3 ? 'fade_tail' : 'short_tail' };
    }
  }
  finish(res);
  return res;
}

function finish(res) {
  const d = res.detail;
  res.cues.introEndSec = d.introEnd.sec;
  res.cues.outroStartSec = d.outroStart.sec;
  if (d.loudness.gainDb !== null) res.cues.loudnessGainDb = d.loudness.gainDb;
  // The scheduler gates talk-over-intro on this single label, so it is the intro cue's when there is one;
  // otherwise the weakest of the cues that were found; otherwise low.
  let c;
  if (d.introEnd.sec !== null) c = d.introEnd.confidence;
  else {
    const found = [d.outroStart, d.loudness].filter((x) => (x.sec ?? x.lufs) !== null && (x.sec ?? x.lufs) !== undefined).map((x) => x.confidence);
    c = found.length ? Math.min(...found) : 0;
  }
  res.cues.confidence = label(c);
}

function attachLoudness(res, o, lin, binSec, absolute) {
  const d = res.detail.loudness;
  if (o.loudness && typeof o.loudness === 'object') {
    Object.assign(d, o.loudness);
  } else if (absolute) {
    // unweighted gated RMS approximation over the envelope; dual-mono convention (x2 energy)
    const blockBins = Math.max(1, Math.round(0.4 / binSec)), hop = Math.max(1, Math.round(0.1 / binSec));
    const energies = [];
    for (let i = 0; i + blockBins <= lin.length; i += hop) {
      let e = 0;
      for (let k = i; k < i + blockBins; k++) e += lin[k] * lin[k];
      energies.push(2 * e / blockBins);
    }
    if (!energies.length) { let e = 0; for (let k = 0; k < lin.length; k++) e += lin[k] * lin[k]; if (lin.length) energies.push(2 * e / lin.length); }
    const g = gatedLufs(energies);
    d.lufs = g.lufs; d.method = 'rms-envelope-approx'; d.gated = g.gated; d.confidence = g.lufs === null ? 0 : 0.4;
  }
  if (d.lufs !== null && isNum(d.lufs)) {
    d.lufs = round(d.lufs, 2);
    d.gainDb = round(Math.max(-o.maxGainDb, Math.min(o.maxGainDb, o.targetLufs - d.lufs)), 1);
  } else { d.lufs = null; d.gainDb = null; }
}

// ── BS.1770 pieces ───────────────────────────────────────────────────────────

/** Energies are mean-square sums over channels (already channel-weighted, all weights 1 here). */
function gatedLufs(energies) {
  const lk = (e) => -0.691 + 10 * Math.log10(e);
  const abs = energies.filter((e) => e > 0 && lk(e) > -70);
  if (!abs.length) return { lufs: null, gated: false };
  const mean1 = abs.reduce((x, y) => x + y, 0) / abs.length;
  const relThr = lk(mean1) - 10;
  const rel = abs.filter((e) => lk(e) > relThr);
  if (!rel.length) return { lufs: lk(mean1), gated: true };
  return { lufs: lk(rel.reduce((x, y) => x + y, 0) / rel.length), gated: true };
}

/** K-weighting biquads (BS.1770-4 stage 1 high shelf + stage 2 RLB high-pass) for any sample rate. */
export function kWeightCoefficients(fs) {
  const f1 = 1681.974450955533, G = 3.999843853973347, Q1 = 0.7071752369554196;
  let K = Math.tan(Math.PI * f1 / fs);
  const Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
  const a0 = 1 + K / Q1 + K * K;
  const s1 = {
    b: [(Vh + Vb * K / Q1 + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q1 + K * K) / a0],
    a: [2 * (K * K - 1) / a0, (1 - K / Q1 + K * K) / a0],
  };
  const f2 = 38.13547087602444, Q2 = 0.5003270373238773;
  K = Math.tan(Math.PI * f2 / fs);
  const d = 1 + K / Q2 + K * K;
  const s2 = { b: [1, -2, 1], a: [2 * (K * K - 1) / d, (1 - K / Q2 + K * K) / d] };
  return [s1, s2];
}

// ── PCM entry ────────────────────────────────────────────────────────────────

function normalisePcm(pcm) {
  // accepts Float32Array (mono), array of Float32Array (channels), or {channels|samples, sampleRate}
  const warnings = [];
  let chans = null, sampleRate = null;
  if (pcm && typeof pcm === 'object' && !ArrayBuffer.isView(pcm) && !Array.isArray(pcm)) {
    sampleRate = pcm.sampleRate;
    chans = pcm.channels ?? (pcm.samples ? [pcm.samples] : null);
  } else chans = pcm;
  if (chans && ArrayBuffer.isView(chans)) chans = [chans];
  if (!Array.isArray(chans) || !chans.length) return { chans: [], len: 0, sampleRate, warnings: ['no_channels'] };
  chans = chans.filter((c) => c && typeof c.length === 'number');
  if (!chans.length) return { chans: [], len: 0, sampleRate, warnings: ['no_channels'] };
  if (chans.length > 2) { warnings.push('more_than_2_channels_using_first_2'); chans = chans.slice(0, 2); }
  let len = Math.min(...chans.map((c) => c.length));
  if (chans.some((c) => c.length !== chans[0].length)) warnings.push('channel_length_mismatch_truncated');
  return { chans, len, sampleRate, warnings };
}

/**
 * pcm: Float32Array | Float32Array[] | {channels|samples, sampleRate}. opts: {sampleRate, loudness:true, ...}.
 * One pass per stage over the samples; no allocation proportional to the track beyond the envelope.
 */
export function extractCuesFromPcm(pcm, opts = {}) {
  try { return analysePcm(pcm, opts || {}); } catch (e) { return emptyResult('pcm', 0, ['internal_error']); }
}

function analysePcm(pcm, opts) {
  const o = { ...CUE_DEFAULTS, ...opts };
  const { chans, len, sampleRate: sr0, warnings } = normalisePcm(pcm);
  const sr = isNum(sr0) ? sr0 : o.sampleRate;
  if (!isNum(sr) || sr < 8000 || sr > 384000) return emptyResult('pcm', 0, [...warnings, 'bad_sample_rate']);
  if (!len) return emptyResult('pcm', 0, [...warnings, 'empty_pcm']);
  const durationSec = len / sr;
  const hop = Math.max(1, Math.round(sr * o.envHopSec));
  const nb = Math.ceil(len / hop);
  const env = new Float64Array(nb);       // mono-mixdown RMS per hop
  const blockE = new Float64Array(nb);    // K-weighted energy sum (all channels) per hop
  const doLoud = o.loudness !== false;
  const kc = doLoud ? kWeightCoefficients(sr) : null;
  const nc = chans.length;
  let bad = 0, clipped = 0, peak = 0;
  const st = chans.map(() => new Float64Array(4)); // z1,z2 for each of 2 stages

  for (let b = 0; b < nb; b++) {
    const i0 = b * hop, i1 = Math.min(len, i0 + hop);
    let mono2 = 0, kE = 0;
    for (let c = 0; c < nc; c++) {
      const x = chans[c], z = st[c];
      let e = 0;
      for (let i = i0; i < i1; i++) {
        let v = x[i];
        if (!(v === v) || v === Infinity || v === -Infinity) { v = 0; bad++; }
        const av = v < 0 ? -v : v;
        if (av > peak) peak = av;
        if (av >= 0.999) clipped++;
        if (doLoud) {
          // direct form II transposed, two cascaded biquads
          let y = kc[0].b[0] * v + z[0];
          z[0] = kc[0].b[1] * v - kc[0].a[0] * y + z[1];
          z[1] = kc[0].b[2] * v - kc[0].a[1] * y;
          const y2 = kc[1].b[0] * y + z[2];
          z[2] = kc[1].b[1] * y - kc[1].a[0] * y2 + z[3];
          z[3] = kc[1].b[2] * y - kc[1].a[1] * y2;
          e += y2 * y2;
        }
      }
      kE += e;
    }
    // mono mixdown RMS (average of channels per sample) needs a second look at the samples
    let m = 0;
    for (let i = i0; i < i1; i++) {
      let s = 0;
      for (let c = 0; c < nc; c++) { const v = chans[c][i]; s += (v === v && v !== Infinity && v !== -Infinity) ? v : 0; }
      s /= nc; m += s * s;
    }
    const n = i1 - i0;
    env[b] = Math.sqrt(m / n);
    // dual-mono: a single channel counts twice (the same convention as playing it from both speakers)
    blockE[b] = (nc === 1 ? 2 : 1) * kE / n;
  }

  let loudness = { lufs: null, method: 'none', gated: false, confidence: 0, gainDb: null, samplePeak: round(peak, 4) };
  if (doLoud) {
    // 400 ms block = 4 consecutive 100 ms sub-blocks, hop 100 ms (75 % overlap)
    const per = Math.max(1, Math.round(0.4 / o.envHopSec));
    const energies = [];
    for (let i = 0; i + per <= nb; i++) {
      // the last sub-block may be short; only full sub-blocks form gated blocks
      if (i + per === nb && len % hop !== 0) break;
      let e = 0;
      for (let k = i; k < i + per; k++) e += blockE[k];
      energies.push(e / per);
    }
    if (!energies.length) { // under 0.4 s: ungated, low confidence
      let e = 0; for (let k = 0; k < nb; k++) e += blockE[k];
      energies.push(e / nb);
    }
    const g = gatedLufs(energies);
    loudness = { lufs: g.lufs, method: 'bs1770-gated', gated: g.gated, confidence: g.lufs === null ? 0 : (durationSec >= 3 ? 0.8 : 0.4), gainDb: null, samplePeak: round(peak, 4) };
  } else loudness.samplePeak = round(peak, 4);

  const w = [...warnings];
  if (bad) w.push(`sanitized_${bad}_samples`);
  if (clipped / (len * nc) > 0.001) w.push('clipping');
  const res = analyseEnvelope(env, { ...o, durationSec, absolute: true, loudness: doLoud ? loudness : { samplePeak: loudness.samplePeak, lufs: null } });
  res.method = doLoud ? 'pcm-bs1770' : 'pcm-envelope';
  res.warnings = [...w, ...res.warnings];
  res.detail.loudness.samplePeak = loudness.samplePeak;
  return res;
}

/** Dispatch: an envelope (array-like of numbers) or PCM ({channels|samples}, or array of channels). */
export function extractCues(input, opts = {}) {
  try {
    const isNumArr = (x) => (Array.isArray(x) || ArrayBuffer.isView(x)) && (x.length === 0 || typeof x[0] === 'number');
    if (input && typeof input === 'object' && input.envelope) return extractCuesFromEnvelope(input.envelope, { ...opts, ...input });
    if (input && typeof input === 'object' && (input.channels || input.samples)) return extractCuesFromPcm(input, opts);
    if (Array.isArray(input) && input.length && !isNumArr(input)) return extractCuesFromPcm(input, opts);
    if (isNumArr(input) && isNum(opts && opts.sampleRate)) return extractCuesFromPcm(input, opts);
    return extractCuesFromEnvelope(input, opts);
  } catch (e) { return emptyResult('none', 0, ['internal_error']); }
}

/**
 * The cue object the scheduler consumes (`{introEndSec, outroStartSec, loudnessGainDb?, confidence}` plus the
 * additive `startTrimSec`/`endTrimSec`). `override` is a hand-set cues object whose defined keys win.
 */
export function toLibraryCues(result, override = null) {
  const base = result && result.cues ? { ...result.cues } : { introEndSec: null, outroStartSec: null, confidence: 'low' };
  if (override && typeof override === 'object') for (const k of Object.keys(override)) if (override[k] !== undefined) base[k] = override[k];
  return base;
}

// ── synthetic signal generator (tests, sim, benchmarks; deterministic) ────────

/**
 * Build a piecewise amplitude plan into a Float32 mono signal or a linear RMS envelope.
 * spec: {durationSec, sampleRate?, hopSec?, freq?=220, segments:[{fromSec, toSec, from, to}]} amplitudes are peak
 * (sine) values, linearly interpolated within a segment; anything uncovered is silence.
 */
export function synthAmplitude(spec, t) {
  let a = 0;
  for (const s of spec.segments) {
    if (t >= s.fromSec && t < s.toSec) { const p = (t - s.fromSec) / Math.max(1e-9, s.toSec - s.fromSec); a = s.from + (s.to - s.from) * p; }
  }
  return a;
}

export function synthPcm(spec) {
  const sr = spec.sampleRate || 8000, n = Math.round(spec.durationSec * sr), f = spec.freq || 220;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / sr; x[i] = synthAmplitude(spec, t) * Math.sin(2 * Math.PI * f * t); }
  return x;
}

/** Absolute linear RMS envelope of the same plan (sine rms = peak/sqrt2). */
export function synthEnvelope(spec, bins) {
  const hop = spec.durationSec / bins, env = new Float32Array(bins);
  for (let i = 0; i < bins; i++) env[i] = synthAmplitude(spec, (i + 0.5) * hop) / Math.SQRT2;
  return env;
}

/** A pop-song-shaped plan: lead silence, quiet pad until introEnd, body, fade from outroStart, tail silence. */
export function songPlan({ durationSec, leadSilenceSec = 0, introEndSec, outroStartSec, fadeEndSec, bodyAmp = 0.4, introAmp = 0.08, riseSec = 0.6 }) {
  const fe = fadeEndSec ?? durationSec;
  return {
    durationSec,
    segments: [
      { fromSec: leadSilenceSec, toSec: introEndSec - riseSec, from: introAmp, to: introAmp },
      { fromSec: introEndSec - riseSec, toSec: introEndSec, from: introAmp, to: bodyAmp },
      { fromSec: introEndSec, toSec: outroStartSec, from: bodyAmp, to: bodyAmp },
      { fromSec: outroStartSec, toSec: fe, from: bodyAmp, to: 0.002 },
    ],
  };
}
