import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuckController, applyEnvelope, dbToGain, DUCK } from '../../src/radio/offline/ducking.js';
import { duckEnvelope, gainAt } from '../../src/radio/core/scheduler.js';
import { fakeParam } from './helpers.mjs';

/**
 * Simulate what Web Audio renders from the recorded automation, sampled every ms. The audio already rendered before a
 * cancel stays as rendered; a cancel removes only events at or after its time (and cancelAndHold freezes the value).
 */
function sample(calls, from, to, initial = 1) {
  const groups = [];
  for (const c of calls) {
    if (c[0] === 'cancel' || c[0] === 'hold') groups.push({ t: c[1], hold: c[0] === 'hold', ops: [] });
    else if (groups.length) groups[groups.length - 1].ops.push(c);
    else groups.push({ t: -Infinity, ops: [c] });
  }
  let ev = []; // timeline of {t, v, ramp}
  const val = (t) => {
    let prev = { t: -Infinity, v: initial };
    for (const e of [...ev].sort((a, b) => a.t - b.t)) {
      if (e.t <= t) { prev = e; continue; }
      if (e.ramp && prev.t > -Infinity) return prev.v + (e.v - prev.v) * ((t - prev.t) / (e.t - prev.t));
      return prev.v;
    }
    return prev.v;
  };
  const out = [];
  let gi = 0;
  for (let t = from; t <= to + 1e-9; t += 0.001) {
    while (gi < groups.length && groups[gi].t <= t) {
      const g = groups[gi++];
      const held = val(g.t);
      const inFlight = ev.some((e) => e.ramp && e.t > g.t);
      ev = ev.filter((e) => e.t < g.t);
      if (g.hold && inFlight) ev.push({ t: g.t, v: held, ramp: false }); // Chromium: hold only freezes a ramp in progress
      for (const o of g.ops) ev.push({ t: o[2], v: o[1], ramp: o[0] === 'ramp' });
    }
    out.push([t, val(t)]);
  }
  return out;
}

let clock = 0;
const mk = (o = {}) => { const param = fakeParam(1); clock = 0; const c = createDuckController({ param, now: () => clock, ...o }); return { c, param }; };
const maxStep = (s) => s.reduce((m, x, i) => (i ? Math.max(m, Math.abs(x[1] - s[i - 1][1])) : 0), 0);

test('duck then restore: smooth monotone ramps, correct depth, ends at unity', () => {
  const { c, param } = mk();
  clock = 1.0; c.hold('s1');
  clock = 4.0; c.release('s1');
  const s = sample(param.calls, 0, 6);
  const down = s.filter(([t]) => t >= 1 && t <= 1.3), up = s.filter(([t]) => t >= 4 && t <= 4.6);
  for (let i = 1; i < down.length; i++) assert.ok(down[i][1] <= down[i - 1][1] + 1e-9, 'attack never rises');
  for (let i = 1; i < up.length; i++) assert.ok(up[i][1] >= up[i - 1][1] - 1e-9, 'release never falls');
  assert.ok(Math.abs(s.find(([t]) => t >= 3)[1] - dbToGain(DUCK.depthDb)) < 1e-6);
  assert.equal(s[s.length - 1][1], 1);
  assert.ok(maxStep(s) < 0.005, `a ${maxStep(s)} step in one millisecond would click`);
  assert.equal(c.ducked, false);
});

test('overlapping holds: music stays down until the last one ends', () => {
  const { c, param } = mk();
  clock = 0; c.hold('a'); clock = 1; c.hold('b'); clock = 2; c.release('a');
  assert.equal(c.ducked, true); assert.equal(c.holdCount, 1);
  const calls = param.calls.length;
  clock = 3; c.release('b');
  assert.ok(param.calls.length > calls);
  assert.equal(c.ducked, false);
  assert.ok(Math.abs(c.gainAt(10) - 1) < 1e-9);
  // releasing an unknown owner is harmless
  c.release('nobody'); c.release('a');
});

test('interrupting a ramp starts from the current value: no jump in either direction', () => {
  const { c, param } = mk();
  clock = 0; c.hold('x');          // ramps 1 -> ~0.2 over 0.22 s
  clock = 0.11; c.release('x');    // halfway down, now go back up
  clock = 0.2; c.hold('y');        // and down again mid-release
  clock = 2; c.releaseAll();
  const s = sample(param.calls, 0, 4);
  assert.ok(maxStep(s) < 0.005, `step ${maxStep(s)}`);
  assert.ok(s.every(([, v]) => v >= dbToGain(DUCK.depthDb) - 1e-9 && v <= 1 + 1e-9), 'never overshoots');
  assert.equal(s[s.length - 1][1], 1);
});

test('every exit path restores the music: releaseAll, restoreNow, many holds, repeated calls', () => {
  for (const exit of ['releaseAll', 'restoreNow']) {
    const { c, param } = mk();
    clock = 0; c.hold('a'); c.hold('b'); c.hold('c');
    clock = 1; c[exit]();
    assert.equal(c.ducked, false, exit);
    const s = sample(param.calls, 0, 3);
    assert.equal(s[s.length - 1][1], 1, exit);
    assert.ok(maxStep(s) < 0.06 || exit === 'restoreNow', exit);
    const n = param.calls.length;
    c[exit](); // idempotent
    assert.equal(param.calls.length, n);
  }
  const { c } = mk();
  clock = 0; c.release('never'); c.releaseAll(); c.restoreNow();
  assert.equal(c.gainNow(), 1);
});

test('restoreNow is a short click-safe ramp, not a jump', () => {
  const { c, param } = mk();
  clock = 0; c.hold('s'); clock = 2; c.restoreNow();
  const s = sample(param.calls, 1.9, 2.1);
  assert.ok(maxStep(s) < 0.06, `${maxStep(s)}`);
  assert.ok(s[s.length - 1][1] > 0.99);
});

test('a dead audio context cannot break the show', () => {
  const param = { cancelScheduledValues() { throw new Error('closed'); }, setValueAtTime() { throw new Error('closed'); }, linearRampToValueAtTime() { throw new Error('closed'); } };
  const c = createDuckController({ param, now: () => { throw new Error('closed'); } });
  assert.doesNotThrow(() => { c.hold('a'); c.release('a'); c.releaseAll(); c.restoreNow(); c.gainNow(); });
});

test('core duckEnvelope converts to the same kind of automation (the cloud-bus envelope on a gain param)', () => {
  const env = duckEnvelope([{ startSec: 10, endSec: 14 }, { startSec: 30, endSec: 33 }]);
  const param = fakeParam(1);
  const n = applyEnvelope(param, env, 100);
  assert.equal(n, env.length);
  assert.equal(param.calls[0][0], 'set'); assert.equal(param.calls[0][2], 100 + env[0].t);
  for (let i = 1; i < param.calls.length; i++) assert.ok(param.calls[i][2] >= param.calls[i - 1][2]);
  const s = sample(param.calls, 100, 140);
  for (const [t, v] of s.filter((_, i) => i % 250 === 0)) assert.ok(Math.abs(v - gainAt(env, t - 100)) < 0.01, `t=${t}`);
  assert.ok(maxStep(s) < 0.005);
  assert.equal(applyEnvelope(param, [], 0), 0);
});

test('with cancelAndHoldAtTime (Chromium) an interrupted ramp is frozen, not restarted from a stale value', () => {
  const param = fakeParam(1);
  param.cancelAndHoldAtTime = (t) => param.calls.push(['hold', t]);
  clock = 0;
  const c = createDuckController({ param, now: () => clock });
  c.hold('a'); clock = 0.11; c.release('a'); clock = 0.2; c.hold('b'); clock = 1.5; c.releaseAll();
  assert.equal(param.calls.some((x) => x[0] === 'cancel'), false);
  const s = sample(param.calls, 0, 3);
  assert.ok(maxStep(s) < 0.005, `step ${maxStep(s)}`);
  assert.equal(s[s.length - 1][1], 1);
});

test('release after a COMPLETED duck does not jump (a ramp interpolates from the previous event, however old)', () => {
  for (const withHold of [false, true]) {
    const param = fakeParam(1);
    if (withHold) param.cancelAndHoldAtTime = (t) => param.calls.push(['hold', t]);
    clock = 0;
    const c = createDuckController({ param, now: () => clock });
    c.hold('a');          // 1 -> 0.2 over 0.22 s, completes long before the release
    clock = 10; c.release('a');
    const s = sample(param.calls, 9.9, 11);
    assert.ok(maxStep(s) < 0.005, `withHold=${withHold}: a ${maxStep(s)} step (the bug was 0.2 -> 0.95)`);
    assert.ok(Math.abs(s.find(([t]) => t >= 10)[1] - dbToGain(DUCK.depthDb)) < 0.01);
    assert.equal(s[s.length - 1][1], 1);
  }
});
