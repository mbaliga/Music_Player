// queue.test.mjs — pure gapless scheduler: bounded memory, preload, join, fallbacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, reduce, nextPlayable, estimateBytes, DEFAULTS } from '../src/queue.js';

// Drive a queue with a simulated clock; collect actions. The "host" answers
// preload/join immediately (or as the test chooses).
function run(q, steps) {
  const log = [];
  let s = q;
  for (const ev of steps) {
    const r = reduce(s, ev);
    s = r.state;
    for (const a of r.actions) log.push(a);
  }
  return { s, log };
}
const tick = (t, T, rate = 1) => ({ type: 'tick', t, T, rate });
const REC = 4 * 60;

test('idle until the lead window; then exactly one preload of the next playable slot', () => {
  let q = createQueue({ playable: [true, false, true], durations: [REC, REC, REC] });
  q = reduce(q, { type: 'start', index: 0 }).state;
  const early = run(q, [tick(10, REC), tick(100, REC)]);
  assert.deepEqual(early.log, []);
  const r = run(early.s, [tick(REC - 39, REC), tick(REC - 30, REC), tick(REC - 20, REC)]);
  assert.deepEqual(r.log, [{ type: 'preload', index: 2 }]); // slot 1 unplayable -> skipped, once
  assert.equal(r.s.phase, 'preloading');
});

test('join fires at the end once ready, then state advances; next preload happens later', () => {
  let q = createQueue({ playable: [true, true, true], durations: [REC, REC, REC] });
  q = reduce(q, { type: 'start', index: 0 }).state;
  let r = run(q, [tick(REC - 30, REC), { type: 'preloaded', index: 1, bytes: 85e6 }]);
  assert.equal(r.s.phase, 'ready');
  r = run(r.s, [tick(REC - 5, REC)]);
  assert.deepEqual(r.log, []); // not yet
  r = run(r.s, [tick(REC - 0.04, REC), tick(REC - 0.03, REC)]);
  assert.deepEqual(r.log, [{ type: 'join', index: 1, fadeSec: DEFAULTS.fadeSec }]); // once
  r = run(r.s, [{ type: 'joined' }]);
  assert.equal(r.s.cur, 1); assert.equal(r.s.phase, 'idle'); assert.equal(r.s.curBytes, 85e6);
  r = run(r.s, [tick(1, REC), tick(100, REC)]);
  assert.deepEqual(r.log, []);
  r = run(r.s, [tick(REC - 20, REC)]);
  assert.deepEqual(r.log, [{ type: 'preload', index: 2 }]);
});

test('memory is bounded: never more than the budget; over-budget skips preload and goes cold', () => {
  const big = 40 * 60; // a 40-minute mix: ~850 MB
  let q = createQueue({ playable: [true, true], durations: [REC, big] });
  assert.ok(estimateBytes(q, 1) > DEFAULTS.maxResidentBytes);
  q = reduce(q, { type: 'start', index: 0 }).state;
  let r = run(q, [tick(REC - 30, REC)]);
  assert.deepEqual(r.log, []); assert.equal(r.s.phase, 'skipped');
  r = run(r.s, [tick(REC - 0.03, REC), tick(REC - 0.02, REC)]);
  assert.deepEqual(r.log, [{ type: 'cold', index: 1 }]); // once
  // two normal tracks fit the default budget
  const ok = createQueue({ playable: [true, true], durations: [REC, REC] });
  assert.ok(estimateBytes(ok, 0) + estimateBytes(ok, 1) <= DEFAULTS.maxResidentBytes);
  // unknown durations assume 300 s each: 2 x 106 MB fits, and a tighter budget refuses
  const tight = createQueue({ playable: [true, true], opts: { maxResidentBytes: 100e6 } });
  const s1 = reduce(tight, { type: 'start', index: 0 }).state;
  assert.equal(run(s1, [tick(290, 300)]).s.phase, 'skipped');
});

test('end of tape: no successor -> a single end action at the runout; paused rate never ends/joins', () => {
  let q = createQueue({ playable: [true, false] });
  q = reduce(q, { type: 'start', index: 0 }).state;
  let r = run(q, [tick(100, 120, 0), tick(119.99, 120, 0)]);
  assert.deepEqual(r.log, []); // platter stopped at the end: tape waits
  r = run(r.s, [tick(119.97, 120, 1), tick(119.98, 120, 1)]);
  assert.deepEqual(r.log, [{ type: 'end' }]);
});

test('paused platter never joins even when ready at the very end', () => {
  let q = createQueue({ playable: [true, true], durations: [REC, REC] });
  q = reduce(q, { type: 'start', index: 0 }).state;
  let r = run(q, [tick(REC - 30, REC), { type: 'preloaded', index: 1, bytes: 1 }, tick(REC, REC, 0)]);
  assert.deepEqual(r.log.filter((a) => a.type === 'join'), []);
  r = run(r.s, [tick(REC, REC, 1)]);
  assert.equal(r.log.filter((a) => a.type === 'join').length, 1);
});

test('preload failure skips that slot and plans the following one', () => {
  let q = createQueue({ playable: [true, true, true], durations: [REC, REC, REC] });
  q = reduce(q, { type: 'start', index: 0 }).state;
  let r = run(q, [tick(REC - 30, REC), { type: 'preloadFailed', index: 1 }, tick(REC - 29, REC)]);
  assert.deepEqual(r.log, [{ type: 'preload', index: 1 }, { type: 'preload', index: 2 }]);
  assert.deepEqual(nextPlayable(r.s, 0), 2);
});

test('boundary arrives before the preload finished: waits, then joins when ready (no cold double-load)', () => {
  let q = createQueue({ playable: [true, true], durations: [REC, REC] });
  q = reduce(q, { type: 'start', index: 0 }).state;
  let r = run(q, [tick(REC - 30, REC), tick(REC, REC), tick(REC, REC)]);
  assert.deepEqual(r.log, [{ type: 'preload', index: 1 }]);
  r = run(r.s, [{ type: 'preloaded', index: 1, bytes: 1 }, tick(REC, REC)]);
  assert.deepEqual(r.log, [{ type: 'join', index: 1, fadeSec: DEFAULTS.fadeSec }]);
});

test('user jumps: to the queued track joins without re-decode; elsewhere drops the queued deck', () => {
  let q = createQueue({ playable: [true, true, true], durations: [REC, REC, REC] });
  q = reduce(q, { type: 'start', index: 0 }).state;
  q = run(q, [tick(REC - 30, REC), { type: 'preloaded', index: 1, bytes: 1 }]).s;
  const toQueued = reduce(q, { type: 'start', index: 1 });
  assert.deepEqual(toQueued.actions, [{ type: 'join', index: 1, fadeSec: 0.02 }]);
  const elsewhere = reduce(q, { type: 'start', index: 2 });
  assert.deepEqual(elsewhere.actions, [{ type: 'drop-next' }]);
  assert.equal(elsewhere.state.phase, 'idle'); assert.equal(elsewhere.state.cur, 2);
  // stale preload result after a jump is ignored
  assert.equal(reduce(elsewhere.state, { type: 'preloaded', index: 1, bytes: 1 }).state.phase, 'idle');
});

test('stop drops a queued deck; reducer is pure and ignores unknown events', () => {
  let q = createQueue({ playable: [true, true], durations: [REC, REC] });
  q = reduce(q, { type: 'start', index: 0 }).state;
  const frozen = JSON.stringify(q);
  reduce(q, tick(REC - 30, REC));
  assert.equal(JSON.stringify(q), frozen); // input not mutated
  const r = run(q, [tick(REC - 30, REC), { type: 'stop' }]);
  assert.deepEqual(r.log, [{ type: 'preload', index: 1 }, { type: 'drop-next' }]);
  assert.equal(reduce(q, { type: 'bogus' }).state, q);
  assert.deepEqual(reduce(createQueue({}), tick(1, 100)).actions, []);
});
