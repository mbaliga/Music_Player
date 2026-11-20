// The FX bus: the graph is EXACTLY the original while FX is off or idle, chains are built lazily and fully removed, ramps are smooth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FxBus } from '../src/fx/bus.js';
import { makeFakeCtx, fakeTimers } from './support/fake-audio.mjs';

const cmd = (o) => ({ kind: null, engaged: false, freq: 1000, q: 4, wet: 0, feedback: 0.4, delaySec: 0.25, balance: 0.5, ...o });

test('FX off: constructing the bus and applying "no effect" creates no nodes and leaves the graph untouched', () => {
  const f = makeFakeCtx(); const before = f.snapshot(), n0 = f.nodes.length;
  const bus = new FxBus(f.engine, fakeTimers());
  bus.apply(null); bus.apply(cmd({})); bus.apply(cmd({ kind: 'bandpass', engaged: false })); bus.apply(cmd({ kind: 'echo', engaged: false }));
  assert.equal(f.nodes.length, n0); assert.equal(f.snapshot(), before); assert.equal(bus.active, false);
  assert.equal(f.snapshot(), `${f.bus.id}>${f.destination.id}`, 'musicBus -> destination only');
  bus.dispose(); assert.equal(f.snapshot(), before);
});

test('band pass: built on first engage, wet crossfade with smooth ramps, torn down after release, graph restored', () => {
  const f = makeFakeCtx(), tm = fakeTimers(), before = f.snapshot();
  const bus = new FxBus(f.engine, tm);
  bus.apply(cmd({ kind: 'bandpass', engaged: true, freq: 800, q: 6, wet: 1 }));
  assert.equal(bus.active, true); assert.equal(bus.kind, 'bandpass');
  assert.ok(!f.edges.has(`${f.bus.id}>${f.destination.id}`), 'direct link replaced by the unity hub');
  const bpf = f.nodes.find((n) => n.kind === 'biquad'); 
  bus.apply(cmd({ kind: 'bandpass', engaged: true, freq: 2400, q: 9, wet: 1 }));
  const calls = bpf.frequency.calls.filter((c) => c[0] === 'target');
  assert.ok(calls.length >= 1 && calls.every((c) => c[3] > 0), 'frequency moves by setTargetAtTime with a time constant (no steps)');
  assert.ok(bpf.Q.calls.some((c) => c[0] === 'target'));
  bus.apply(cmd({ kind: 'bandpass', engaged: false, freq: 2400, q: 9, wet: 1 }));
  assert.equal(bus.active, true, 'still up while the dry/wet crossfade settles');
  tm.advance(200);
  assert.equal(bus.active, false); assert.equal(f.snapshot(), before, 'graph is exactly the original again');
});

test('echo: nothing until first engaged; tail rings out after release, then everything is removed', () => {
  const f = makeFakeCtx(), tm = fakeTimers(), before = f.snapshot();
  const bus = new FxBus(f.engine, tm);
  bus.apply(cmd({ kind: 'echo', engaged: true, wet: 0.8, feedback: 0.7, delaySec: 0.3 }));
  assert.equal(bus.kind, 'echo');
  const conv = f.nodes.find((n) => n.kind === 'convolver'); assert.ok(conv.buffer && conv.buffer.len > 1000, 'generated impulse response installed');
  const delay = f.nodes.find((n) => n.kind === 'delay'); assert.ok(delay.max <= 2, 'bounded delay line');
  const fbs = f.nodes.filter((n) => n.kind === 'gain' && n.gain.calls.some((c) => c[0] === 'target' && Math.abs(c[1] - 0.7) < 1e-9));
  assert.ok(fbs.length >= 1);
  bus.apply(cmd({ kind: 'echo', engaged: false, wet: 0.8, feedback: 0.7, delaySec: 0.3 }));
  tm.advance(2000); assert.equal(bus.active, true, 'tail still ringing after 2 s');
  tm.advance(4000); assert.equal(bus.active, false); assert.equal(f.snapshot(), before);
  assert.equal(tm.pending(), 0, 'no timers left behind');
});

test('feedback can never reach unity, even if asked', () => {
  const f = makeFakeCtx(); const bus = new FxBus(f.engine, fakeTimers());
  bus.apply(cmd({ kind: 'echo', engaged: true, wet: 1, feedback: 5 }));
  for (const n of f.nodes) if (n.kind === 'gain') for (const c of n.gain.calls) assert.ok(c[1] <= 1);
  assert.ok(f.nodes.filter((n) => n.kind === 'gain').every((n) => n.gain.value <= 1));
});

test('switching effect kind fades the old chain, builds the new one, and ends with the right graph', () => {
  const f = makeFakeCtx(), tm = fakeTimers(), before = f.snapshot();
  const bus = new FxBus(f.engine, tm);
  bus.apply(cmd({ kind: 'bandpass', engaged: true }));
  bus.apply(cmd({ kind: 'echo', engaged: true, wet: 1 }));
  assert.equal(bus.kind, 'echo'); tm.advance(200);
  bus.apply(cmd({ kind: null }));                     // leave the mode
  tm.advance(500); assert.equal(bus.active, false); assert.equal(f.snapshot(), before);
});

test('dispose() restores the graph at once, is idempotent and never throws', () => {
  const f = makeFakeCtx(), before = f.snapshot();
  const bus = new FxBus(f.engine, fakeTimers());
  bus.apply(cmd({ kind: 'echo', engaged: true, wet: 1 }));
  bus.dispose(); assert.equal(f.snapshot(), before);
  assert.doesNotThrow(() => { bus.dispose(); bus.apply(null); });
  bus.apply(cmd({ kind: 'bandpass', engaged: true })); bus.dispose(); assert.equal(f.snapshot(), before);
});
