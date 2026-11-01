// SPIKE P1 -- THROWAWAY. Offline gap finder for the background-audio test: record the phone's speaker
// with a SECOND device (laptop/phone mic held next to it), save as 16-bit PCM WAV, then run
//   node spike/radio-p1/scripts/find-gaps.mjs recording.wav
// The program is a steady tone, so any stretch where the tone envelope drops is a gap/dropout.
// Pure functions here; WAV parsing is minimal (PCM16 only) and also pure.

export function parseWavPcm16(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (String.fromCharCode(...buf.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...buf.subarray(8, 12)) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let p = 12, fmt = null, data = null;
  while (p + 8 <= buf.length) {
    const id = String.fromCharCode(...buf.subarray(p, p + 4)), size = dv.getUint32(p + 4, true), body = p + 8;
    if (id === 'fmt ') fmt = { format: dv.getUint16(body, true), channels: dv.getUint16(body + 2, true), sampleRate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    if (id === 'data') data = { start: body, size: Math.min(size, buf.length - body) };
    p = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('missing fmt/data chunk');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`only PCM16 supported (got format ${fmt.format}, ${fmt.bits} bit)`);
  const n = Math.floor(data.size / (2 * fmt.channels)), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(data.start + i * 2 * fmt.channels, true) / 32768; // channel 0
  return { samples: out, sampleRate: fmt.sampleRate };
}

/**
 * Finds stretches where the short-term envelope falls more than `dropDb` below the median
 * envelope of the whole recording, lasting at least `minGapMs`.
 * @returns {{gaps:Array<{startMs:number,durMs:number}>, medianDb:number}}
 */
export function findGaps(samples, sampleRate, { windowMs = 10, dropDb = 20, minGapMs = 100 } = {}) {
  const w = Math.max(1, Math.round((sampleRate * windowMs) / 1000)), env = [];
  for (let i = 0; i + w <= samples.length; i += w) {
    let e = 0; for (let j = 0; j < w; j++) e += samples[i + j] ** 2;
    env.push(10 * Math.log10(Math.max(e / w, 1e-18)));
  }
  const sorted = [...env].sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)] ?? -180;
  const gaps = []; let run = -1;
  const close = (endIdx) => {
    const dur = (endIdx - run) * windowMs;
    if (dur >= minGapMs) gaps.push({ startMs: run * windowMs, durMs: dur });
    run = -1;
  };
  env.forEach((d, i) => { if (d < median - dropDb) { if (run < 0) run = i; } else if (run >= 0) close(i); });
  if (run >= 0) close(env.length);
  return { gaps, medianDb: median };
}
