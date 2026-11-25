import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prng } from './support/worklet-drive.mjs';
import {
  DIVISIONS, DIV_BEATS, beatInfo, sliceFrames, sliceMs, sliceFraction, stepDivision, beatLabel, clampDivision, FALLBACK_BEAT_SEC, MIN_SLICE_FRAMES,
} from '../src/fx/divisions.js';
import { estimateTempo, onsetEnvelope, tempoFromOnsets } from '../src/fx/tempo.js';
import {
  GESTURE_KNOBS as K, divisionFromDrag, repeatRateFromSpin, ratePercent, formatPercent, padFromPoint, bpFreqFromX, bpQFromY, echoWetFromX,
  echoFeedbackFromY, blendFromRadius, smooth, spinRelative,
} from '../src/fx/gesture.js';
import { MODES, defaultFx, sanitizeFx, setMode, setParam, derive, W_MODE, holdsPlatter, isPadMode } from '../src/fx/modes.js';
import { serializeFx, parseFx, loadFx, saveFx, FX_STORAGE_KEY } from '../src/fx/persist.js';
import { ringStyle, ringSpeed, MODE_HUE } from '../src/fx/ring.js';
import { waveColumns, playheadFrac, sliceSpan } from '../src/fx/waveform.js';
import { makeImpulseResponse, irEnergy } from '../src/fx/dsp.js';

const SR = 44100;

// ── divisions / beat maths ────────────────────────────────────────────────────────────────────────────────────────────
test('divisions are fractions of ONE BEAT', () => {
  assert.deepEqual([...DIVISIONS], ['1/1', '1/2', '1/4', '1/8', '1/16']);
  assert.equal(sliceFrames('1/1', 0.5, SR), 22050);
  assert.equal(sliceFrames('1/2', 0.5, SR), 11025);
  assert.equal(sliceFrames('1/4', 0.5, SR), 5513);      // rounded
  assert.equal(sliceFrames('1/16', 0.5, SR), 1378);
  assert.equal(sliceMs('1/16', 0.5), 31.25);
  assert.equal(sliceFraction('1/8'), 0.125);
  // each step halves the slice
  for (let i = 0; i < DIVISIONS.length - 1; i++) assert.ok(Math.abs(DIV_BEATS[DIVISIONS[i]] / DIV_BEATS[DIVISIONS[i + 1]] - 2) < 1e-12);
});
test('slice length is clamped (never degenerate, never huge) and junk divisions fall back', () => {
  assert.equal(sliceFrames('1/16', 0.001, SR), MIN_SLICE_FRAMES);
  assert.equal(sliceFrames('1/1', 60, SR), 3 * SR);
  assert.equal(sliceFrames('nonsense', 0.5, SR), sliceFrames('1/4', 0.5, SR));
  assert.equal(clampDivision(7), '1/4');
});
test('beatInfo: confident tempo -> real beat; otherwise the FIXED fallback, and it says so', () => {
  const good = beatInfo({ bpm: 120, confidence: 0.9 });
  assert.equal(good.fixed, false); assert.equal(good.beatSec, 0.5); assert.equal(beatLabel(good), '120 BPM');
  for (const t of [null, undefined, {}, { bpm: 120, confidence: 0.05 }, { bpm: NaN, confidence: 1 }, { bpm: 900, confidence: 1 }]) {
    const b = beatInfo(t);
    assert.equal(b.fixed, true); assert.equal(b.beatSec, FALLBACK_BEAT_SEC);
    assert.match(beatLabel(b), /No beat detected: using a steady beat/);
  }
  assert.equal(beatInfo({ bpm: 90, confidence: 1 }, { scale: 2 }).bpm, 180);
  assert.equal(beatInfo({ bpm: 90, confidence: 1 }, { scale: 0.5 }).bpm, 45);
  assert.equal(beatInfo({ bpm: 90, confidence: 1 }, { scale: 7 }).bpm, 90);
});
test('stepDivision clamps at both ends', () => {
  assert.equal(stepDivision('1/1', -1), '1/1'); assert.equal(stepDivision('1/16', 1), '1/16'); assert.equal(stepDivision('1/4', 1), '1/8'); assert.equal(stepDivision('1/4', -1), '1/2');
});

// ── tempo estimator on synthetic tracks ───────────────────────────────────────────────────────────────────────────────
function clicks(bpm, sec, { noise = 0, tone = 0, seed = 3 } = {}) {
  const n = SR * sec, x = new Float32Array(n), r = prng(seed), per = (60 / bpm) * SR;
  for (let b = 0; b * per < n; b++) {
    const p = Math.round(b * per), acc = b % 4 === 0 ? 1 : 0.6;
    for (let i = 0; i < 700 && p + i < n; i++) x[p + i] += acc * Math.exp(-i / 120) * Math.sin(i * 0.15) * 0.8;
  }
  for (let i = 0; i < n; i++) x[i] += noise * (r() * 2 - 1) + tone * 0.3 * Math.sin(i * 0.02);
  return x;
}
test('tempo: click tracks from 70 to 170 BPM are found within 1 %', () => {
  for (const bpm of [70, 90, 100, 120, 128, 140, 150, 170]) {
    const x = clicks(bpm, 30), t = estimateTempo([x], x.length, SR);
    assert.ok(t, `bpm ${bpm}`);
    assert.ok(Math.abs(t.bpm - bpm) / bpm < 0.01, `${bpm} -> ${t.bpm}`);
    assert.ok(t.confidence > 0.8, `confidence ${t.confidence}`);
  }
});
test('tempo: stereo, a noisy bed and a track with a long lead-in still work', () => {
  const x = clicks(120, 40, { noise: 0.05, tone: 1 });
  const t = estimateTempo([x, x], x.length, SR);
  assert.ok(Math.abs(t.bpm - 120) < 1.5 && t.confidence >= 0.3);
  const y = new Float32Array(SR * 50); y.set(clicks(96, 30), SR * 20);   // 20 s of silence first; the analysis window starts at 5 % = 2.5 s
  const u = estimateTempo([y], y.length, SR);
  assert.ok(u && Math.abs(u.bpm - 96) < 1.2, `${u && u.bpm}`);
});
test('tempo: no beat (white noise, a held tone, silence, irregular hits, junk) never gives a confident answer', () => {
  const r = prng(5);
  const white = new Float32Array(SR * 30).map(() => r() * 2 - 1);
  const tone = new Float32Array(SR * 30).map((_, i) => 0.5 * Math.sin(i * 0.05));
  const irr = new Float32Array(SR * 30); let p = 0; const q = prng(9);
  while (p < irr.length - 800) { for (let i = 0; i < 700; i++) irr[p + i] += Math.exp(-i / 120) * Math.sin(i * 0.15); p += Math.round((0.2 + q() * 0.7) * SR); }
  for (const x of [white, tone, new Float32Array(SR * 30), irr]) {
    const t = estimateTempo([x], x.length, SR);
    assert.ok(t === null || t.confidence < 0.3, JSON.stringify(t));
    assert.equal(beatInfo(t).fixed, true);
  }
  for (const bad of [[null, 0, 44100], [[], 100, 44100], [[new Float32Array(10)], 10, 44100], [[new Float32Array(100)], 100, 0], [[new Float32Array(100)], NaN, 44100]]) {
    assert.equal(estimateTempo(...bad), null);
  }
  assert.equal(tempoFromOnsets(new Float32Array(10), 0.0058), null);
});
test('tempo: deterministic', () => {
  const x = clicks(111, 20);
  assert.deepEqual(estimateTempo([x], x.length, SR), estimateTempo([x], x.length, SR));
  const a = onsetEnvelope([x], x.length, SR);
  assert.ok(a.env.length > 1000 && a.hopSec > 0);
});

// ── gesture mappings ──────────────────────────────────────────────────────────────────────────────────────────────────
test('division from a radial drag: inward steps toward 1/16, outward toward 1/1, one step per zone, clamped', () => {
  const zone = (K.divOuter - K.divInner) / DIVISIONS.length;
  assert.equal(divisionFromDrag('1/4', 0.5, 0.5), '1/4');
  assert.equal(divisionFromDrag('1/4', 0.5, 0.5 - zone), '1/8');
  assert.equal(divisionFromDrag('1/4', 0.5, 0.5 - 2 * zone), '1/16');
  assert.equal(divisionFromDrag('1/4', 0.5, 0.5 + zone), '1/2');
  assert.equal(divisionFromDrag('1/4', 0.5, 0.5 + 2 * zone), '1/1');
  assert.equal(divisionFromDrag('1/4', 0.5, -9), '1/16'); assert.equal(divisionFromDrag('1/4', 0.5, 9), '1/1'); assert.equal(divisionFromDrag('zzz', NaN, NaN), '1/1');
  // sweeping across the whole platter visits every division, in order
  const seen = []; let prev = null;
  for (let u = 1; u >= 0; u -= 0.005) { const d = divisionFromDrag('1/1', 1, u, prev); prev = d; if (!seen.includes(d)) seen.push(d); }
  assert.deepEqual(seen, [...DIVISIONS]);
});
test('division stepping has hysteresis: wobbling across a boundary does not flip-flop', () => {
  const zone = (K.divOuter - K.divInner) / DIVISIONS.length;
  const boundary = 0.5 - zone * 0.5;                 // exactly between 1/4 and 1/8 for a drag that started at 0.5
  let d = '1/4', flips = 0;
  for (let i = 0; i < 200; i++) { const u = boundary + (i % 2 ? -1 : 1) * 0.3 * zone * K.divHyst; const n = divisionFromDrag('1/4', 0.5, u, d); if (n !== d) flips++; d = n; }
  assert.equal(flips, 0);
});
test('repeat rate from spin: dead zone, +% forward, -% backward, clamped to -50..+900', () => {
  assert.equal(repeatRateFromSpin(0), 1); assert.equal(repeatRateFromSpin(K.spinDead), 1); assert.equal(repeatRateFromSpin(-K.spinDead), 1);
  assert.ok(repeatRateFromSpin(2) > 1 && repeatRateFromSpin(2) < 3);
  assert.ok(repeatRateFromSpin(-1) < 1 && repeatRateFromSpin(-1) > 0.5);
  assert.equal(repeatRateFromSpin(1000), 10); assert.equal(repeatRateFromSpin(-1000), 0.5);
  assert.equal(repeatRateFromSpin(NaN), 1);
  // monotone in s
  let prev = -Infinity; for (let s = -12; s <= 12; s += 0.25) { const m = repeatRateFromSpin(s); assert.ok(m >= prev); prev = m; }
  assert.equal(ratePercent(10), 900); assert.equal(ratePercent(0.5), -50); assert.equal(ratePercent(1), 0); assert.equal(ratePercent(1.09), 9); assert.equal(ratePercent(99), 900);
  assert.equal(formatPercent(888), '+888%'); assert.equal(formatPercent(-50), '−50%'); assert.equal(formatPercent(0), '±0%');
  assert.equal(spinRelative(3.49, 3.49), 1); assert.equal(spinRelative(5, 0), 0);
});
test('smoothing is a stable one-pole (no overshoot, tau 0 passes through)', () => {
  let v = 0; for (let i = 0; i < 200; i++) { v = smooth(v, 1, 0.016, 0.06); assert.ok(v <= 1); }
  assert.ok(v > 0.999); assert.equal(smooth(0.2, 0.9, 0.016, 0), 0.9);
});
test('pad maths: x/y -> band-pass frequency and Q (log), echo wet and feedback; all clamped', () => {
  const p = padFromPoint(150, 50, 100, 100, 100); assert.deepEqual(p, { x: 0.5, y: 0.5 });
  assert.deepEqual(padFromPoint(900, -900, 100, 100, 100), { x: 1, y: 1 });
  assert.ok(Math.abs(bpFreqFromX(-1) - K.bpFreqMin) < 1e-9 && Math.abs(bpFreqFromX(1) - K.bpFreqMax) < 1e-6);
  assert.ok(Math.abs(bpFreqFromX(0) - Math.sqrt(K.bpFreqMin * K.bpFreqMax)) < 1e-6, 'log centre');
  assert.ok(Math.abs(bpQFromY(-1) - K.bpQMin) < 1e-9 && Math.abs(bpQFromY(1) - K.bpQMax) < 1e-6);
  assert.equal(bpFreqFromX(-5), K.bpFreqMin); assert.equal(echoWetFromX(-1), 0); assert.equal(echoWetFromX(1), 1);
  assert.ok(echoFeedbackFromY(1) <= 0.85 + 1e-12 && echoFeedbackFromY(-1) >= 0.1 - 1e-12, 'feedback < 1: the delay can never run away');
  assert.ok(blendFromRadius(0) >= 0.15 && blendFromRadius(1) === 1 && blendFromRadius(NaN) >= 0.15);
});

// ── mode state machine / derive ───────────────────────────────────────────────────────────────────────────────────────
const beat120 = beatInfo({ bpm: 120, confidence: 1 });
const rt = (o = {}) => ({ engaged: true, blocked: false, u: 0.5, x: 0, y: 0, spin: 0, div: null, beat: beat120, sampleRate: SR, nominalRate: 1, ...o });

test('the six modes, in menu order, Scratch first (the default)', () => {
  assert.deepEqual(MODES.map((m) => m.id), ['scratch', 'blend', 'repeat', 'stutter', 'bandpass', 'echo']);
  assert.equal(defaultFx().mode, 'scratch');
  for (const m of MODES) assert.ok(m.label && m.desc.length > 10 && m.desc.length < 140);
  assert.ok(holdsPlatter('repeat') && holdsPlatter('stutter') && !holdsPlatter('blend') && isPadMode('bandpass') && isPadMode('echo') && !isPadMode('repeat'));
});
test('Scratch derives nothing: the worklet stays off and no bus node is requested', () => {
  const d = derive(defaultFx(), rt());
  assert.equal(d.worklet.mode, 0); assert.equal(d.worklet.engage, 0); assert.equal(d.bus.kind, null);
});
test('beat repeat derive: slice length from the division, rate from spin, readout text', () => {
  const st = setMode(defaultFx(), 'repeat');
  const d = derive(st, rt({ div: '1/16', spin: 10.4 }));
  assert.equal(d.worklet.mode, W_MODE.repeat); assert.equal(d.worklet.engage, 1);
  assert.equal(d.worklet.len, sliceFrames('1/16', 0.5, SR));
  assert.ok(d.readout.percent > 800 && d.readout.percent <= 900);
  assert.match(d.readout.text, /^1\/16 \+\d+%$/);
  assert.equal(derive(st, rt({ div: '1/1', spin: 0 })).readout.text, '1/1 ±0%');
  assert.equal(derive(st, rt({ div: '1/1', spin: 0 })).worklet.len, 22050);
  assert.ok(derive(st, rt({ div: '1/1', spin: 0 })).readout.sliceFrac === 1 && derive(st, rt({ div: '1/16' })).readout.sliceFrac === 0.0625, 'red slice bar proportion');
  assert.equal(derive(setParam(st, 'repeat', 'resume', 'capture'), rt()).worklet.resume, 1);
  assert.equal(derive(st, rt({ engaged: false })).worklet.engage, 0);
});
test('fixed-beat fallback is reported on the readout', () => {
  const d = derive(setMode(defaultFx(), 'repeat'), rt({ beat: beatInfo(null), div: '1/2' }));
  assert.equal(d.readout.fixedBeat, true); assert.match(d.readout.beat, /steady beat/); assert.equal(d.worklet.len, 11025);
});
test('stutter derive: period = division, gate from the knob (clamped), rate 1', () => {
  let st = setParam(setMode(defaultFx(), 'stutter'), 'stutter', 'gate', 0.3);
  const d = derive(st, rt({ div: '1/8' }));
  assert.equal(d.worklet.mode, W_MODE.stutter); assert.equal(d.worklet.gate, 0.3); assert.equal(d.worklet.len, sliceFrames('1/8', 0.5, SR)); assert.equal(d.worklet.rate, 1);
  assert.equal(setParam(st, 'stutter', 'gate', 5).stutter.gate, 1); assert.equal(setParam(st, 'stutter', 'gate', -5).stutter.gate, 0.1);
});
test('blend derive: amount from the slider, or from touch radius when "by radius" is on', () => {
  let st = setParam(setMode(defaultFx(), 'blend'), 'blend', 'amount', 0.7);
  assert.equal(derive(st, rt()).worklet.amount, 0.7); assert.equal(derive(st, rt()).worklet.mode, W_MODE.blend);
  st = setParam(st, 'blend', 'byRadius', true);
  assert.equal(derive(st, rt({ u: 1 })).worklet.amount, 1); assert.ok(derive(st, rt({ u: 0 })).worklet.amount < 0.2);
  assert.equal(derive(st, rt({ nominalRate: 1.35 })).worklet.rate, 1.35, 'the song underneath runs at the speed-dial rate');
});
test('band pass / echo derive requests a bus effect and leaves the worklet alone', () => {
  const bp = derive(setMode(defaultFx(), 'bandpass'), rt({ x: 1, y: 1 }));
  assert.equal(bp.bus.kind, 'bandpass'); assert.equal(bp.worklet.mode, 0); assert.ok(Math.abs(bp.bus.freq - K.bpFreqMax) < 1e-6 && Math.abs(bp.bus.q - K.bpQMax) < 1e-6);
  assert.equal(derive(setMode(defaultFx(), 'bandpass'), rt({ engaged: false })).bus.engaged, false);
  const ec = derive(setParam(setMode(defaultFx(), 'echo'), 'echo', 'delayDiv', '1/2'), rt({ x: 1, y: 1 }));
  assert.equal(ec.bus.kind, 'echo'); assert.ok(Math.abs(ec.bus.delaySec - 0.25) < 1e-9, 'half a beat at 120 BPM'); assert.ok(ec.bus.feedback < 0.9); assert.equal(ec.bus.wet, 1);
  const fixed = derive(setMode(defaultFx(), 'echo'), rt({ beat: beatInfo(null) }));
  assert.ok(fixed.bus.delaySec > 0 && fixed.readout.fixedBeat);
});
test('blocked (a station or mixtape owns the engine): everything is off', () => {
  for (const m of MODES) {
    const d = derive(setMode(defaultFx(), m.id), rt({ blocked: true }));
    assert.equal(d.worklet.mode, 0); assert.equal(d.worklet.engage, 0); assert.equal(d.bus.kind, null); assert.equal(d.readout.text, '');
  }
  assert.equal(derive(defaultFx(), null).worklet.mode, 0);
});
test('the state can never become invalid', () => {
  const s = sanitizeFx({ mode: 'laser', ring: 'yes', latch: 1, bpmScale: 3, blend: { amount: 9, byRadius: 'x' }, repeat: { div: '1/3', resume: 'zzz' }, stutter: { div: 4, gate: NaN }, bandpass: { q: -4 }, echo: { delayDiv: null, balance: 7 }, extra: 1 });
  assert.deepEqual(s, defaultFx() && { ...defaultFx(), blend: { amount: 1, byRadius: false }, bandpass: { q: 0.7 }, echo: { delayDiv: '1/2', balance: 1 } });
  assert.deepEqual(sanitizeFx(null), defaultFx()); assert.deepEqual(sanitizeFx('x'), defaultFx());
  assert.equal(setMode(defaultFx(), 'nope').mode, 'scratch'); assert.equal(setParam(defaultFx(), 'ghost', 'k', 1).mode, 'scratch');
  assert.equal(setParam(defaultFx(), 'root', 'ring', false).ring, false);
});

// ── persistence ───────────────────────────────────────────────────────────────────────────────────────────────────────
function fakeStore(init = {}, { throwOn = null } = {}) {
  const m = new Map(Object.entries(init));
  return { getItem(k) { if (throwOn === 'get') throw new Error('blocked'); return m.has(k) ? m.get(k) : null; }, setItem(k, v) { if (throwOn === 'set') throw new Error('quota'); m.set(k, String(v)); }, m };
}
test('persistence: round trip restores mode and parameters exactly', () => {
  let st = setMode(defaultFx(), 'repeat');
  st = setParam(setParam(setParam(st, 'repeat', 'div', '1/16'), 'repeat', 'resume', 'capture'), 'root', 'bpmScale', 2);
  st = setParam(st, 'blend', 'amount', 0.25);
  const store = fakeStore();
  assert.equal(saveFx(st, store), true);
  assert.ok(store.m.has(FX_STORAGE_KEY));
  assert.deepEqual(loadFx(store), st);
  assert.deepEqual(parseFx(serializeFx(st)), st);
});
test('persistence never throws: corrupt, hostile, wrong version, oversize, blocked storage', () => {
  const bad = ['', '{', 'null', '[]', '{"v":99,"mode":"repeat"}', '"x"', 'x'.repeat(10000), '{"v":1,"mode":{"__proto__":1}}', undefined, null, 42];
  for (const b of bad) assert.doesNotThrow(() => parseFx(b));
  assert.deepEqual(parseFx('{"v":99,"mode":"repeat"}'), defaultFx());
  assert.deepEqual(parseFx('{"v":1,"mode":"stutter","stutter":{"gate":0.9,"div":"1/2"},"evil":{"a":1}}').stutter, { div: '1/2', gate: 0.9 });
  assert.deepEqual(loadFx(fakeStore({}, { throwOn: 'get' })), defaultFx());
  assert.equal(saveFx(defaultFx(), fakeStore({}, { throwOn: 'set' })), false);
  assert.deepEqual(loadFx(null), defaultFx());       // no localStorage in node
  assert.equal(saveFx(defaultFx(), null), false);
});

// ── light ring ────────────────────────────────────────────────────────────────────────────────────────────────────────
test('ring colour and intensity follow mode and hand speed; off when disabled; no spectrum under reduced motion', () => {
  assert.equal(ringStyle({ enabled: false }).on, false);
  const idle = ringStyle({ mode: 'repeat' }), held = ringStyle({ mode: 'repeat', engaged: true, speed: 0.3 }), fast = ringStyle({ mode: 'repeat', engaged: true, speed: 0.95 });
  assert.ok(idle.alpha < held.alpha && held.alpha < fast.alpha);
  assert.equal(idle.hue, MODE_HUE.repeat);
  assert.notEqual(held.hue, idle.hue); assert.notEqual(fast.hue, held.hue);
  assert.equal(fast.rainbow, true); assert.ok(fast.rotate > 0);
  const calm = ringStyle({ mode: 'repeat', engaged: true, speed: 0.95, reduced: true });
  assert.equal(calm.rainbow, false); assert.equal(calm.rotate, 0);
  assert.ok(ringStyle({ mode: 'echo', blocked: true }).alpha < ringStyle({ mode: 'echo' }).alpha);
  for (const m of Object.keys(MODE_HUE)) for (let s = 0; s <= 1; s += 0.1) { const r = ringStyle({ mode: m, engaged: true, speed: s }); assert.ok(r.hue >= 0 && r.hue < 360 && r.alpha >= 0 && r.alpha <= 1 && r.width > 0); }
  assert.equal(ringSpeed(100), 1); assert.equal(ringSpeed(-3), 0.5); assert.equal(ringSpeed(NaN), 0);
});

// ── waveform helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
test('waveform columns keep peaks; playhead and slice span are clamped fractions', () => {
  const env = new Float32Array(1024); env[500] = 1; env[10] = 0.5;
  const c = waveColumns(env, 64);
  assert.equal(c.length, 64); assert.equal(Math.max(...c), 1); assert.equal(c[Math.floor(500 / 16)], 1);
  assert.equal(waveColumns(null, 10).length, 10); assert.equal(waveColumns(env, 0).length, 0);
  assert.equal(playheadFrac(5, 10), 0.5); assert.equal(playheadFrac(50, 10), 1); assert.equal(playheadFrac(1, 0), 0);
  assert.deepEqual(sliceSpan(5, 1, 10, 'repeat'), [0.4, 0.5]); assert.deepEqual(sliceSpan(5, 1, 10, 'stutter'), [0.5, 0.6]);
  assert.equal(sliceSpan(NaN, 1, 10, 'repeat'), null);
});

// ── generated impulse response ────────────────────────────────────────────────────────────────────────────────────────
test('impulse response: deterministic, decaying, bounded, decorrelated channels, no audio files', () => {
  const a = makeImpulseResponse(SR, 1.6, 5.5, 1), b = makeImpulseResponse(SR, 1.6, 5.5, 1), c = makeImpulseResponse(SR, 1.6, 5.5, 2);
  assert.equal(a[0].length, Math.round(SR * 1.6));
  assert.deepEqual(a[0], b[0]); assert.notDeepEqual(a[0], c[0]); assert.notDeepEqual(a[0], a[1]);
  let pk = 0; for (const ch of a) for (const v of ch) { assert.ok(Number.isFinite(v)); pk = Math.max(pk, Math.abs(v)); }
  assert.ok(Math.abs(pk - 0.5) < 1e-6);
  assert.ok(irEnergy(a, SR, 0, 0.4) > 0.6, 'most energy early');
  assert.ok(irEnergy(a, SR, 1.2, 1.6) < 0.02, 'decays');
  assert.equal(Math.abs(a[0][a[0].length - 1]), 0);
});
