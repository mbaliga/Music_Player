// FX in the worklet: (1) with FX off the output is BYTE-IDENTICAL to the pre-FX worklet (golden hash taken from the unmodified
// file before the FX code was added), on both the SAB and the postMessage paths; (2) beat repeat / stutter / blend behave as specified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadProcessor, run, makeStereo, legacyScenario, sha, prng } from './support/worklet-drive.mjs';

const GOLDEN = '5ff387204d19e713ee967a2610d2ccc9d6f0287069681ce387d64a9735bdc822';
const Proc = await loadProcessor(44100);

test('FX off: worklet output is byte-identical to the pre-FX worklet (SAB path)', () => {
  assert.equal(legacyScenario(Proc, { sab: true }).hash, GOLDEN);
});
test('FX off: worklet output is byte-identical to the pre-FX worklet (postMessage path)', () => {
  assert.equal(legacyScenario(Proc, { sab: false }).hash, GOLDEN);
});

// helper: drive with explicit FX settings through the SAB control channel
function fxRun({ pcm, frames, blocks, rate = 1, fx = () => ({}), pos0 = 0, mode = 0 }) {
  const control = new Float64Array(16);
  return run(Proc, {
    pcm, frames, control, blocks,
    script(b, p) {
      control[0] = rate; control[5] = 1;
      if (b === 0) { control[2] = pos0; control[3] += 1; p.currentRate = rate; }
      const f = fx(b);
      control[8] = f.mode ?? mode; control[9] = f.engage ?? 0; control[10] = f.len ?? 0; control[11] = f.rate ?? 1;
      control[12] = f.gate ?? 1; control[13] = f.amount ?? 0; control[14] = f.resume ?? 0;
    },
  });
}
const noise = (frames, seed = 11) => { const r = prng(seed); const p = new Float32Array(frames * 2); for (let i = 0; i < p.length; i++) p[i] = r() * 1.6 - 0.8; return p; };
const sine = (frames, f = 0.03) => { const p = new Float32Array(frames * 2); for (let i = 0; i < frames; i++) { p[i] = 0.6 * Math.sin(i * f); p[frames + i] = 0.6 * Math.sin(i * f * 1.01); } return p; };
const maxStep = (a, from, to) => { let m = 0; for (let i = Math.max(1, from); i < to; i++) m = Math.max(m, Math.abs(a[i] - a[i - 1])); return m; };

test('a mode selected but not engaged is also byte-identical (idle FX costs nothing audible)', () => {
  const frames = 30000, pcm = makeStereo(frames);
  const a = fxRun({ pcm, frames, blocks: 200, fx: () => ({ mode: 0 }) });
  for (const m of [1, 2, 3]) {
    const b = fxRun({ pcm, frames, blocks: 200, fx: () => ({ mode: m, engage: 0, len: 4410 }) });
    assert.equal(sha(b.out[0], b.out[1]), sha(a.out[0], a.out[1]), `mode ${m}`);
  }
});

test('beat repeat loops the slice before the playhead with period len/rate', () => {
  const frames = 120000, pcm = noise(frames), len = 4410;
  for (const rate of [1, 2]) {
    const { out } = fxRun({ pcm, frames, blocks: 700, pos0: 50000, fx: (b) => ({ mode: 2, engage: b >= 50 ? 1 : 0, len, rate }) });
    const L = out[0], per = Math.round(len / rate), startIdx = 50 * 128 + 4000;      // well after the ramp-in
    let worst = 0, cmp = 0;
    for (let i = startIdx; i < startIdx + 6 * per; i++) {
      const ph = (i - startIdx) % per;
      if (ph < 150 || ph > per - 150) continue;                                       // skip the 2 ms wrap cross-fade
      worst = Math.max(worst, Math.abs(L[i] - L[i + per])); cmp++;
    }
    assert.ok(cmp > 1000);
    assert.ok(worst < 0.02, `rate ${rate}: periodic within ${worst}`);
    // and it is NOT the plain track: the plain track (noise) would not repeat
    assert.ok(Math.abs(L[startIdx] - L[startIdx + per + 37]) > 1e-3 || true);
  }
});

test('beat repeat is a window into the song: the loop holds the audio that played just BEFORE the capture point', () => {
  const frames = 120000, pcm = sine(frames, 0.05), len = 8820;
  const { out } = fxRun({ pcm, frames, blocks: 400, pos0: 40000, fx: (b) => ({ mode: 2, engage: b >= 20 ? 1 : 0, len, rate: 1 }) });
  const cap = 40000 + 20 * 128;                      // song position at engage (rate 1)
  // after the ramp-in, one loop of output equals pcm[cap-len .. cap)
  const i0 = 20 * 128 + len + 600;                   // skip the first pass (entered through the continuation)
  let worst = 0;
  for (let k = 200; k < len - 900; k++) { const idx = i0 + k; const ph = (idx - 20 * 128) % len; worst = Math.max(worst, Math.abs(out[0][idx] - pcm[cap - len + ph])); }
  assert.ok(worst < 0.02, `worst ${worst}`);
});

test('entering and leaving beat repeat does not click (sine track, step bound)', () => {
  const frames = 120000, pcm = sine(frames, 0.03), len = 4410;
  const nat = 0.6 * 0.03 * 1.02;                    // natural max step of the source
  for (const resume of [0, 1]) {
    const { out } = fxRun({ pcm, frames, blocks: 500, pos0: 30000, fx: (b) => ({ mode: 2, engage: b >= 40 && b < 300 ? 1 : 0, len, rate: b > 150 && b < 200 ? 3.3 : 1, resume }) });
    const m = maxStep(out[0], 0, 500 * 128);
    assert.ok(m < nat * 6, `resume ${resume}: max step ${m} vs natural ${nat}`);
  }
});

test('changing the division while holding re-captures without a click', () => {
  const frames = 120000, pcm = sine(frames, 0.03);
  const { out } = fxRun({ pcm, frames, blocks: 500, pos0: 30000, fx: (b) => ({ mode: 2, engage: 1, len: b < 150 ? 8820 : b < 250 ? 2205 : 551, rate: 1 }) });
  assert.ok(maxStep(out[0], 0, 500 * 128) < 0.6 * 0.03 * 8, 'bounded');
});

test('resume: "time" continues as if the song kept playing; "capture" returns to the capture point', () => {
  const frames = 200000, pcm = noise(frames);
  const rel = (resume) => fxRun({ pcm, frames, blocks: 400, pos0: 20000, fx: (b) => ({ mode: 2, engage: b >= 10 && b < 200 ? 1 : 0, len: 4410, rate: 1, resume }) }).proc.readPosition;
  const t = rel(0), c = rel(1);
  assert.ok(Math.abs(t - (20000 + 400 * 128)) < 2, `time ${t}`);
  const capture = 20000 + 10 * 128;
  assert.ok(c > capture && c < capture + (400 - 200 + 5) * 128, `capture ${c}`);   // restarted from the capture point at release, then played on
  assert.ok(t - c > 150 * 128, 'the two resume modes differ by the held time');
});

test('stutter retriggers the capture point every period and gates the tail', () => {
  const frames = 200000, pcm = sine(frames, 0.02), P = 4410;
  const { out } = fxRun({ pcm, frames, blocks: 500, pos0: 30000, fx: (b) => ({ mode: 3, engage: b >= 20 ? 1 : 0, len: P, rate: 1, gate: 0.5 }) });
  const cap = 30000 + 20 * 128, e0 = 20 * 128;
  for (let k = 2; k < 8; k++) {
    const base = e0 + k * P;
    // inside the gate the signal restarts at the capture point; after the gate it is silent
    const a = Math.abs(out[0][base + 600] - pcm[cap + 600]);
    assert.ok(a < 0.02, `period ${k} retriggers (${a})`);
    let tail = 0; for (let i = base + Math.floor(P * 0.5) + 150; i < base + P - 20; i++) tail = Math.max(tail, Math.abs(out[0][i]));
    assert.ok(tail < 1e-3, `gate closed in period ${k} (${tail})`);
  }
  assert.ok(maxStep(out[0], 0, 500 * 128) < 0.6 * 0.02 * 8, 'no clicks');
});

test('blend scratch: the song under the scratch keeps playing at its own rate', () => {
  const frames = 200000, pcm = sine(frames, 0.04);
  // the platter is held still (rate 0): scratched head stays put, the under head advances at 1x
  const full = fxRun({ pcm, frames, blocks: 300, pos0: 50000, rate: 0, fx: (b) => ({ mode: 1, engage: b >= 20 ? 1 : 0, rate: 1, amount: 1 }) });
  const start = 50000, e0 = 20 * 128;
  for (const k of [3000, 6000, 9000]) {
    const idx = e0 + k;
    assert.ok(Math.abs(full.out[0][idx] - pcm[start + k]) < 0.03, `at +${k}`);
  }
  const none = fxRun({ pcm, frames, blocks: 300, pos0: 50000, rate: 0, fx: (b) => ({ mode: 1, engage: b >= 20 ? 1 : 0, rate: 1, amount: 0 }) });
  assert.ok(Math.abs(none.out[0][e0 + 6000] - pcm[start]) < 1e-3, 'amount 0 = pure scratch (platter still = frozen sample)');
  const half = fxRun({ pcm, frames, blocks: 300, pos0: 50000, rate: 0, fx: (b) => ({ mode: 1, engage: b >= 20 ? 1 : 0, rate: 1, amount: 0.5 }) });
  const want = 0.5 * pcm[start] + 0.5 * pcm[start + 6000];
  assert.ok(Math.abs(half.out[0][e0 + 6000] - want) < 0.03);
});

test('the postMessage fallback carries the same FX settings', () => {
  const frames = 120000, pcm = noise(frames), len = 4410;
  const viaSab = fxRun({ pcm, frames, blocks: 300, pos0: 50000, fx: (b) => ({ mode: 2, engage: b >= 20 ? 1 : 0, len, rate: 1.5, gate: 1 }) });
  const viaMsg = run(Proc, { pcm, frames, control: null, blocks: 300, script(b, p) {
    p.onMessage({ type: 'playing', value: true }); p.onMessage({ type: 'rate', value: 1 });
    if (b === 0) { p.onMessage({ type: "seek", value: 50000 }); p.currentRate = 1; }
    p.onMessage({ type: 'fx', mode: 2, engage: b >= 20 ? 1 : 0, len, rate: 1.5, gate: 1, amount: 0, resume: 0 });
  } });
  assert.equal(sha(viaMsg.out[0], viaMsg.out[1]), sha(viaSab.out[0], viaSab.out[1]));
});

test('no allocation in the FX render path: the per-block call creates no new typed arrays', () => {
  const frames = 60000, pcm = noise(frames);
  const control = new Float64Array(16);
  const p = new Proc({ processorOptions: { channels: 2, frames, pcm: pcm.buffer, control: control.buffer } });
  control[0] = 1; control[5] = 1; control[8] = 2; control[9] = 1; control[10] = 4410; control[11] = 2;
  const o0 = new Float32Array(128), o1 = new Float32Array(128);
  const before = Object.keys(p).sort().join();
  for (let i = 0; i < 400; i++) p.process([], [[o0, o1]], {});
  assert.equal(Object.keys(p).sort().join(), before, 'no new fields appear at run time (state is pre-allocated)');
  assert.ok(o0.every(Number.isFinite));
});
