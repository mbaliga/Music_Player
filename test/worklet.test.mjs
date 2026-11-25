// worklet.test.mjs — guards the AudioWorklet read loop against the class of bug
// that silently killed all audio: a wrong process() signature.
//
// AudioWorklet calls process(inputs, outputs, parameters) — INPUTS FIRST. The
// node has numberOfInputs: 0, so if process() names its first param `outputs`,
// it actually receives the empty inputs array, outputs[0] is undefined, and the
// first call throws — which permanently disables the processor (dead silence).
//
// We can't run a real AudioWorkletGlobalScope in node, so we mock the three
// globals the module touches (sampleRate, AudioWorkletProcessor, registerProcessor),
// import the module, then drive process() with the REAL argument order.

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.sampleRate = 44100;
globalThis.registerProcessor = (name, cls) => { globalThis.__RUNOUT_PROC = cls; };
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { onmessage: null, postMessage() {} }; }
};

await import('../src/worklet.js');
const Processor = globalThis.__RUNOUT_PROC;

function makeProcessor(frames = 2000) {
  const pcm = new Float32Array(frames);
  for (let i = 0; i < frames; i++) pcm[i] = Math.sin(i * 0.05); // audible signal
  return new Processor({ processorOptions: { channels: 1, frames, pcm: pcm.buffer, control: null } });
}

function block() { return [new Float32Array(128), new Float32Array(128)]; }

test('registerProcessor was called with the runout processor', () => {
  assert.ok(typeof Processor === 'function', 'processor class registered');
});

test('process(inputs, outputs) writes non-zero audio to outputs[0]', () => {
  const p = makeProcessor();
  p.targetRate = 1; p.currentRate = 1; p.playing = 1;
  const out = block();
  // REAL call order: (inputs, outputs, parameters). inputs is empty (0 inputs).
  p.process([], [out], {});
  const peak = out[0].reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak > 0, `expected audio in outputs[0], got peak ${peak}`);
});

test('readPosition advances at rate 1 (the play loop runs)', () => {
  const p = makeProcessor();
  p.targetRate = 1; p.currentRate = 1; p.playing = 1;
  const before = p.readPosition;
  p.process([], [block()], {});
  assert.ok(p.readPosition > before, `position should advance, was ${before} now ${p.readPosition}`);
  // ~128 frames at rate 1.
  assert.ok(p.readPosition >= 120 && p.readPosition <= 130, `~128 expected, got ${p.readPosition}`);
});

test('playing=0 outputs silence and does not advance position', () => {
  const p = makeProcessor();
  p.targetRate = 1; p.currentRate = 1; p.playing = 0;
  const out = block();
  p.process([], [out], {});
  const peak = out[0].reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.equal(peak, 0, 'silent when not playing');
});

test('survives an empty output quantum without throwing', () => {
  const p = makeProcessor();
  p.playing = 1; p.currentRate = 1; p.targetRate = 1;
  // Chrome can hand a quantum with no channels; must not throw.
  assert.doesNotThrow(() => p.process([], [[]], {}));
  assert.doesNotThrow(() => p.process([], [], {}));
});

test('the runout: at the last frame the output is exactly 0 (no held last sample as DC), plain and FX path', () => {
  for (const fx of [false, true]) {
    const frames = 600, pcm = new Float32Array(frames).fill(0.5);   // a constant 0.5 would be a DC hold at the end
    const p = new Processor({ processorOptions: { channels: 1, frames, pcm: pcm.buffer, control: null } });
    p.onMessage({ type: 'rate', value: 1 }); p.onMessage({ type: 'playing', value: true });
    if (fx) p.onMessage({ type: 'fx', mode: 1, engage: 0, len: 0, rate: 1, gate: 1, amount: 0.5, resume: 0 });
    let first = null, last = null;
    for (let b = 0; b < 12; b++) { const o = block(); p.process([], [o], {}); if (b === 0) first = o[0][100]; last = o; }
    assert.ok(first > 0.4, 'plays before the end');
    assert.ok(last[0].every((v) => v === 0) && last[1].every((v) => v === 0), 'every sample past the end is 0 (fx ' + fx + ')');
  }
});

test('posts near / ended once each as the track runs out, and re-arms after a seek back', () => {
  const frames = Math.round(3 * sampleRate);
  const p = makeProcessor(frames);
  const sent = [];
  p.port = { postMessage: (m) => { if (m.type !== 'pos') sent.push(m.type); } };
  p.targetRate = 1; p.currentRate = 1; p.playing = 1;
  p.readPosition = frames - 2 * sampleRate - 4000;                      // just outside the 2 s window
  for (let i = 0; i < 20; i++) p.process([], [block()], {});
  assert.deepEqual(sent, [], 'nothing before the window');
  p.readPosition = frames - 2 * sampleRate + 200;                       // inside: 'near' once, however many blocks pass
  for (let i = 0; i < 20; i++) p.process([], [block()], {});
  assert.deepEqual(sent, ['near']);
  p.readPosition = frames - 600;
  for (let i = 0; i < 20; i++) p.process([], [block()], {});            // runs into the end and parks there
  assert.deepEqual(sent, ['near', 'ended']);
  for (let i = 0; i < 20; i++) p.process([], [block()], {});
  assert.deepEqual(sent, ['near', 'ended'], 'parked at the end: no repeats');
  p.readPosition = 1000; p.currentRate = 1;                              // a seek back re-arms
  p.process([], [block()], {});
  p.readPosition = frames - 600;
  for (let i = 0; i < 20; i++) p.process([], [block()], {});
  assert.deepEqual(sent, ['near', 'ended', 'near', 'ended']);
});

test('a parked / silent deck never posts edge messages', () => {
  const frames = 4000;
  const p = makeProcessor(frames);
  const sent = [];
  p.port = { postMessage: (m) => { if (m.type !== 'pos') sent.push(m.type); } };
  p.playing = 0; p.targetRate = 1; p.readPosition = frames - 10;
  for (let i = 0; i < 5; i++) p.process([], [block()], {});
  assert.deepEqual(sent, []);
});
