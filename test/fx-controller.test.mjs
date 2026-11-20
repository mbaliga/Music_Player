import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FxController } from '../src/fx/controller.js';
import { FX_STORAGE_KEY } from '../src/fx/persist.js';
import { DIVISIONS, sliceFrames } from '../src/fx/divisions.js';

const SR = 44100, OMEGA = 2 * Math.PI * (100 / 3) / 60;
function mk({ blocked = null, track = null, storage = null } = {}) {
  const calls = { fx: [], bus: [] };
  const host = { getTrack: () => track, nominalRate: () => 1, omegaNominal: () => OMEGA, blocked: () => host._blocked, sampleRate: () => SR, defer: (f) => f(), positionSec: () => 12 };
  host._blocked = blocked;
  const c = new FxController({ engine: { setFx: (p) => calls.fx.push({ ...p }) }, bus: { apply: (m) => calls.bus.push({ ...m }), dispose() { calls.disposed = true; } }, host, storage });
  return { c, calls, host };
}
const S = { cx: 200, cy: 200, rIn: 40, rOut: 180 };
const last = (a) => a[a.length - 1];

test('starts in Scratch with FX fully off and the finger not routed here', () => {
  const { c } = mk();
  assert.equal(c.mode, 'scratch'); assert.equal(c.wantsPlatter(), false); assert.equal(c.engaged, false);
  assert.equal(c.rateFor(0.7), 0.7);
});

test('beat repeat: touch engages, the slice length follows the division, release disengages', () => {
  const { c, calls } = mk();
  c.setMode('repeat');
  c.pointerDown({ x: 200, y: 200 - 110 }, S, 0);
  assert.equal(last(calls.fx).mode, 2); assert.equal(last(calls.fx).engage, 1);
  assert.equal(last(calls.fx).len, sliceFrames('1/4', 0.5, SR), 'fixed 500 ms beat when no tempo is known');
  assert.equal(c.rateFor(0.1), 1, 'while holding, the song runs at its normal rate (the platter is the controller, not the transport)');
  const r = c.pointerUp();
  assert.equal(last(calls.fx).engage, 0); assert.equal(r.resetPlatter, true); assert.equal(c.rateFor(0.1), 0.1);
});

test('dragging inward / outward steps the division and persists it', () => {
  const store = new Map(); const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const { c, calls } = mk({ storage });
  c.setMode('repeat');
  c.pointerDown({ x: 200, y: 200 - 110 }, S, 0);
  let prev = c.hold.div, seen = [prev];
  for (let y = 90; y <= 160; y += 2) { c.pointerMove({ x: 200, y: 200 - (180 - y) - 0 * y }, 16 + y); }
  // sweep inward along the vertical axis
  for (let r = 110; r >= 45; r -= 3) { c.pointerMove({ x: 200, y: 200 - r }, 100 + (110 - r)); if (c.hold.div !== prev) { prev = c.hold.div; seen.push(prev); } }
  assert.ok(DIVISIONS.indexOf(last(seen)) > DIVISIONS.indexOf(seen[0]), `moved toward 1/16: ${seen}`);
  assert.equal(last(calls.fx).len, sliceFrames(c.hold.div, 0.5, SR));
  assert.match(store.get(FX_STORAGE_KEY), new RegExp(`"div":"${c.hold.div.replace('/', '\\/')}"`));
});

test('spinning while holding sets the repeat rate; resting reads zero; the readout shows +n%', () => {
  const { c, calls } = mk();
  c.setMode('repeat');
  c.pointerDown({ x: 200 + 100, y: 200 }, S, 0);
  let t = 0, a = 0;
  for (let i = 0; i < 60; i++) { t += 16; a += 0.28; c.pointerMove({ x: 200 + 100 * Math.cos(a), y: 200 + 100 * Math.sin(a) }, t); c.tick(0.016, t); }
  assert.ok(c.hold.spin > 3, `spin ${c.hold.spin}`);
  assert.ok(last(calls.fx).rate > 2.5);
  assert.match(c.out.readout.text, /^1\/4 \+\d+%$/);
  for (let i = 0; i < 40; i++) { t += 16; c.tick(0.016, t); }         // finger rests
  assert.ok(Math.abs(c.hold.spin) < 0.05); assert.equal(last(calls.fx).rate, 1);
});

test('band pass / echo are XY pads: the platter is not grabbed, the song keeps its rate', () => {
  const { c, calls } = mk();
  c.setMode('bandpass');
  assert.equal(c.grabsPlatter(), false);
  c.pointerDown({ x: 200 + 180, y: 200 - 180 }, S, 0);
  const b = last(calls.bus); assert.equal(b.kind, 'bandpass'); assert.equal(b.engaged, true); assert.ok(b.freq > 7000 && b.q > 12);
  assert.equal(c.rateFor(0), 1); assert.equal(last(calls.fx).mode, 0, 'the worklet is not involved');
  c.pointerUp(); assert.equal(last(calls.bus).engaged, false);
  c.setMode('echo'); c.pointerDown({ x: 200 - 180, y: 200 + 180 }, S, 0);
  assert.equal(last(calls.bus).kind, 'echo'); assert.ok(last(calls.bus).wet < 0.01);
});

test('blend keeps the platter in hand (scratch) while the worklet blends in the song underneath', () => {
  const { c, calls } = mk();
  c.setMode('blend'); assert.equal(c.grabsPlatter(), true);
  c.pointerDown({ x: 300, y: 200 }, S, 0);
  assert.equal(last(calls.fx).mode, 1); assert.equal(c.rateFor(-2.5), -2.5);
});

test('an engine owned by a station or mixtape switches FX off with a plain reason, and nothing can engage', () => {
  const { c, calls, host } = mk();
  c.setMode('repeat'); c.pointerDown({ x: 300, y: 200 }, S, 0); assert.equal(c.engaged, true);
  host._blocked = 'A mixtape is playing.';
  c.tick(0.016, 100);
  assert.equal(c.engaged, false); assert.equal(c.blockedReason, 'A mixtape is playing.');
  assert.equal(last(calls.fx).mode, 0); assert.equal(last(calls.fx).engage, 0); assert.equal(last(calls.bus).kind, null);
  assert.equal(c.pointerDown({ x: 300, y: 200 }, S, 200), false); assert.equal(c.wantsPlatter(), false); assert.equal(c.rateFor(0.4), 0.4);
  host._blocked = null; c.tick(0.016, 300); assert.equal(c.blockedReason, null); assert.equal(c.wantsPlatter(), true);
});

test('latch mode: tap to engage, tap to release', () => {
  const { c } = mk();
  c.setMode('stutter'); c.setParam('root', 'latch', true);
  c.pointerDown({ x: 300, y: 200 }, S, 0); c.pointerUp(); assert.equal(c.engaged, true);
  c.pointerDown({ x: 300, y: 200 }, S, 50); c.pointerUp(); assert.equal(c.engaged, false);
});

test('changing mode or loading a track releases everything; dispose leaves nothing behind', () => {
  const { c, calls } = mk();
  c.setMode('repeat'); c.pointerDown({ x: 300, y: 200 }, S, 0);
  c.setMode('stutter'); assert.equal(c.engaged, false); assert.equal(last(calls.fx).engage, 0);
  c.pointerDown({ x: 300, y: 200 }, S, 0); c.onTrack(); assert.equal(c.engaged, false); assert.equal(last(calls.fx).mode, 0);
  c.dispose(); assert.equal(calls.disposed, true); assert.equal(last(calls.fx).mode, 0);
  assert.doesNotThrow(() => { c.tick(0.016, 1); c.dispose(); });
});

test('tempo: a click track is analysed once per track and sets the beat; a beatless one says fixed', () => {
  const x = new Float32Array(SR * 30), per = 0.5 * SR;
  for (let b = 0; b * per < x.length; b++) for (let i = 0; i < 700; i++) x[Math.round(b * per) + i] += Math.exp(-i / 120) * Math.sin(i * 0.15);
  const track = { channels: [x], frames: x.length };
  const { c, calls } = mk({ track });
  c.setMode('repeat'); assert.equal(c.tempoState, 'done');
  assert.ok(Math.abs(c.beat.bpm - 120) < 1.5 && !c.beat.fixed);
  c.pointerDown({ x: 300, y: 200 }, S, 0);
  assert.ok(Math.abs(last(calls.fx).len - sliceFrames('1/4', 0.5, SR)) < 40);
  const silent = mk({ track: { channels: [new Float32Array(SR * 20)], frames: SR * 20 } });
  silent.c.setMode('repeat'); assert.equal(silent.c.beat.fixed, true);
});

test('persistence: the mode and its parameters come back on the next open', () => {
  const store = new Map(); const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const a = mk({ storage }); a.c.setMode('stutter'); a.c.setParam('stutter', 'gate', 0.7); a.c.setDivision('1/2');
  const b = mk({ storage });
  assert.equal(b.c.mode, 'stutter'); assert.equal(b.c.state.stutter.gate, 0.7); assert.equal(b.c.state.stutter.div, '1/2');
});

test('keyboard: hold with Space-like keyDown, arrows nudge the division', () => {
  const { c } = mk();
  c.setMode('repeat'); c.keyDown(S, 0); assert.equal(c.engaged, true);
  const d0 = c.hold.div; c.nudge(-1, 0, 10); assert.ok(DIVISIONS.indexOf(c.hold.div) > DIVISIONS.indexOf(d0) || d0 === '1/16');
  c.keyUp(); assert.equal(c.engaged, false);
});
