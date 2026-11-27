import test from 'node:test';
import assert from 'node:assert/strict';
import { makeOrder, validOrder, stepSlot, nextRepeat } from '../src/playorder.js';
import { createQueue, nextPlayable, reduce } from '../src/queue.js';

const seeded = (seed = 1) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

test('makeOrder: identity without shuffle, a permutation with the current track first when shuffled', () => {
  assert.deepEqual(makeOrder(4, 2, false), [0, 1, 2, 3]);
  for (let s = 1; s < 30; s++) {
    const o = makeOrder(8, 5, true, seeded(s));
    assert.equal(o[0], 5); assert.equal(validOrder(o, 8), true);
  }
  assert.deepEqual(makeOrder(1, 0, true), [0]);
  assert.deepEqual(makeOrder(0, 0, true), []);
  assert.notDeepEqual(makeOrder(10, 0, true, seeded(3)), makeOrder(10, 0, false));
});

test('validOrder rejects duplicates, wrong length, junk', () => {
  assert.equal(validOrder([0, 1, 1], 3), false); assert.equal(validOrder([0, 1], 3), false); assert.equal(validOrder(null, 0), false);
  assert.equal(validOrder([2, 0, 1], 3), true);
});

test('stepSlot: plain order is what the app always did (repeat off, no order)', () => {
  const ok = { n: 4, repeat: 'off' };
  assert.equal(stepSlot({ ...ok, from: 0, dir: 1 }), 1);
  assert.equal(stepSlot({ ...ok, from: 3, dir: 1 }), -1);
  assert.equal(stepSlot({ ...ok, from: 0, dir: -1 }), -1);
  assert.equal(stepSlot({ ...ok, from: 1, dir: 1, playable: (i) => i !== 2 }), 3);   // bad / missing files are skipped
  assert.equal(stepSlot({ ...ok, from: 1, dir: -1, playable: (i) => i !== 0 }), -1);
});

test('stepSlot follows a shuffled order both ways', () => {
  const order = [2, 0, 3, 1];
  const a = { n: 4, order };
  assert.equal(stepSlot({ ...a, from: 2, dir: 1 }), 0);
  assert.equal(stepSlot({ ...a, from: 0, dir: 1 }), 3);
  assert.equal(stepSlot({ ...a, from: 1, dir: 1 }), -1);
  assert.equal(stepSlot({ ...a, from: 3, dir: -1 }), 0);
  assert.equal(stepSlot({ ...a, from: 2, dir: -1 }), -1);
  assert.equal(stepSlot({ ...a, from: 0, dir: 1, playable: (i) => i !== 3 }), 1);   // bad file skipped inside the shuffled order
});

test('stepSlot repeat all wraps, even on Prev, and a lone playable track repeats itself', () => {
  const order = [2, 0, 3, 1];
  assert.equal(stepSlot({ n: 4, order, from: 1, dir: 1, repeat: 'all' }), 2);
  assert.equal(stepSlot({ n: 4, order, from: 2, dir: -1, repeat: 'all' }), 1);
  assert.equal(stepSlot({ n: 3, from: 1, dir: 1, repeat: 'all', playable: (i) => i === 1 }), 1);
  assert.equal(stepSlot({ n: 3, from: 1, dir: 1, repeat: 'all', playable: () => false }), -1);   // nothing playable: terminates
});

test('stepSlot repeat one: the natural end replays, a pressed Next still advances (and wraps)', () => {
  assert.equal(stepSlot({ n: 3, from: 1, dir: 1, repeat: 'one', natural: true }), 1);
  assert.equal(stepSlot({ n: 3, from: 1, dir: 1, repeat: 'one', natural: false }), 2);
  assert.equal(stepSlot({ n: 3, from: 2, dir: 1, repeat: 'one', natural: false }), 0);
  assert.equal(stepSlot({ n: 3, from: 1, dir: 1, repeat: 'one', natural: true, playable: (i) => i !== 1 }), 2);   // the repeating track went bad: move on
});

test('stepSlot with a stale index falls back to plain order', () => {
  assert.equal(stepSlot({ n: 3, order: [0, 1], from: 0, dir: 1 }), 1);
  assert.equal(stepSlot({ n: 3, order: [2, 1, 0], from: 3, dir: -1 }), 2);
});

test('nextRepeat cycles off -> all -> one -> off', () => {
  assert.deepEqual(['off', 'all', 'one'].map(nextRepeat), ['all', 'one', 'off']);
  assert.equal(nextRepeat('bogus'), 'off');
});

test('every shuffled pass visits each playable slot exactly once (no repeats, none missed)', () => {
  const n = 9, bad = new Set([4]);
  for (let s = 1; s < 20; s++) {
    const order = makeOrder(n, 3, true, seeded(s)); const seen = [3]; let cur = 3;
    for (let k = 0; k < n; k++) { const nx = stepSlot({ n, order, from: cur, dir: 1, playable: (i) => !bad.has(i) }); if (nx < 0) break; seen.push(nx); cur = nx; }
    assert.equal(new Set(seen).size, seen.length);
    assert.deepEqual([...seen].sort((a, b) => a - b), [0, 1, 2, 3, 5, 6, 7, 8]);
  }
});

// ── the gapless queue follows the same order ──
test('queue.js: preload / join target is the next slot of the shuffled order, not slot + 1', () => {
  let q = createQueue({ playable: [true, true, true, true], durations: [100, 100, 100, 100] });
  q = { ...q, order: [2, 0, 3, 1], repeat: 'off' };
  q = reduce(q, { type: 'start', index: 2 }).state;
  assert.equal(nextPlayable(q, 2), 0);
  const r = reduce(q, { type: 'tick', t: 70, T: 100, rate: 1 });
  assert.deepEqual(r.actions, [{ type: 'preload', index: 0 }]);
  const r2 = reduce(reduce(r.state, { type: 'preloaded', index: 0, bytes: 1 }).state, { type: 'tick', t: 99.97, T: 100, rate: 1 });
  assert.deepEqual(r2.actions, [{ type: 'join', index: 0, fadeSec: 0.05 }]);
});

test('queue.js: repeat all preloads the first slot of the order at the last track; repeat one never preloads', () => {
  let q = { ...createQueue({ playable: [true, true, true], durations: [100, 100, 100] }), order: [1, 2, 0], repeat: 'all' };
  q = reduce(q, { type: 'start', index: 0 }).state;
  assert.equal(nextPlayable(q, 0), 1);
  assert.deepEqual(reduce(q, { type: 'tick', t: 70, T: 100, rate: 1 }).actions, [{ type: 'preload', index: 1 }]);
  const one = { ...q, repeat: 'one' };
  assert.equal(nextPlayable(one, 0), -1);
  assert.deepEqual(reduce(one, { type: 'tick', t: 70, T: 100, rate: 1 }).actions, []);
});

test('queue.js: a failed preload is skipped within the shuffled order', () => {
  let q = { ...createQueue({ playable: [true, true, true, true] }), order: [3, 1, 0, 2], repeat: 'off' };
  q = reduce(q, { type: 'start', index: 3 }).state;
  q = { ...q, failed: [1] };
  assert.equal(nextPlayable(q, 3), 0);
});
