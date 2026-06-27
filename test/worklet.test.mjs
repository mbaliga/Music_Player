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
