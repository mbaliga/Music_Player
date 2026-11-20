import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAWER, openOffset, progress, cardScale, rubberBand, velocityFromSamples, settleTarget, classifyMove,
  springStep, isSettled, simulateSettle,
} from '../src/shell/drawer.js';

test('openOffset follows the width and is capped', () => {
  assert.equal(openOffset(360), 360 * DRAWER.OPEN_FRACTION);
  assert.equal(openOffset(2000), DRAWER.OPEN_MAX_PX);
  assert.equal(openOffset(0), 0);
});

test('progress and scale', () => {
  assert.equal(progress(0, 200), 0);
  assert.equal(progress(100, 200), 0.5);
  assert.equal(progress(500, 200), 1);
  assert.equal(progress(-5, 200), 0);
  assert.equal(cardScale(0, 200), 1);
  assert.ok(Math.abs(cardScale(200, 200) - DRAWER.SCALE_OPEN) < 1e-12);
  assert.equal(progress(10, 0), 0);
});

test('rubber band: identity inside, damped outside, continuous at the ends', () => {
  assert.equal(rubberBand(50, 200), 50);
  assert.equal(rubberBand(0, 200), 0);
  assert.equal(rubberBand(200, 200), 200);
  assert.ok(rubberBand(300, 200) > 200 && rubberBand(300, 200) < 300);
  assert.equal(rubberBand(300, 200), 200 + 100 * DRAWER.RUBBER);
  assert.equal(rubberBand(-100, 200), -100 * DRAWER.RUBBER);
});

test('velocity: recent window only, signed, zero for a single sample or no time', () => {
  assert.equal(velocityFromSamples([]), 0);
  assert.equal(velocityFromSamples([{ x: 0, t: 0 }]), 0);
  assert.equal(velocityFromSamples([{ x: 0, t: 5 }, { x: 10, t: 5 }]), 0);
  // 100 px in 50 ms = 2000 px/s
  assert.equal(velocityFromSamples([{ x: 0, t: 0 }, { x: 100, t: 50 }]), 2000);
  // an old slow start outside the window does not drag the estimate down
  const s = [{ x: 0, t: 0 }, { x: 5, t: 400 }, { x: 40, t: 440 }, { x: 80, t: 480 }];
  assert.ok(velocityFromSamples(s) > 900);
  assert.ok(velocityFromSamples([{ x: 100, t: 0 }, { x: 60, t: 40 }]) < 0);
});

test('settle: slow release decides by projected position, fast by direction', () => {
  const open = 200;
  assert.equal(settleTarget(120, 0, open), open);
  assert.equal(settleTarget(80, 0, open), 0);
  assert.equal(settleTarget(100, 0, open), open, 'exactly half goes open');
  // a fling wins over position
  assert.equal(settleTarget(20, DRAWER.FLING_VELOCITY + 1, open), open);
  assert.equal(settleTarget(180, -(DRAWER.FLING_VELOCITY + 1), open), 0);
  // just under the fling: projection nudges the decision
  assert.equal(settleTarget(90, DRAWER.FLING_VELOCITY - 1, open), open);
  assert.equal(settleTarget(110, -(DRAWER.FLING_VELOCITY - 1), open), 0);
});

test('classifyMove: wait inside slop, horizontal drags, vertical is rejected', () => {
  assert.equal(classifyMove(3, 2), 'wait');
  assert.equal(classifyMove(10, 2), 'drag');
  assert.equal(classifyMove(-10, 9), 'drag');
  assert.equal(classifyMove(4, 12), 'reject');
});

test('spring converges to the target from rest and from a fling, with bounded overshoot', () => {
  for (const [x, v, t] of [[0, 0, 200], [200, 0, 0], [30, 1500, 200], [150, -2000, 0]]) {
    let s = { x, v };
    let max = x;
    for (let i = 0; i < 90 && !isSettled(s, t); i++) { s = springStep(s, t, 1 / 60); max = Math.max(max, s.x); }
    assert.ok(isSettled(s, t), `settled from ${x},${v} -> ${t}`);
  }
  const r = simulateSettle(0, 0, 200);
  assert.ok(r.frames > 8 && r.frames <= 24, `settles in ~150-400 ms (${r.frames} frames)`);
  assert.ok(r.overshoot < 200 * 0.08, 'overshoot under 8%');
});

test('spring is stable for any frame time (long frames are clamped)', () => {
  const a = springStep({ x: 0, v: 0 }, 200, 5);
  assert.ok(Number.isFinite(a.x) && a.x > 0 && a.x < 400);
  const b = springStep({ x: 0, v: 0 }, 200, 0);
  assert.deepEqual(b, { x: 0, v: 0 });
  const c = springStep({ x: 0, v: 0 }, 200, -1);
  assert.deepEqual(c, { x: 0, v: 0 });
});

test('a spring started at the target at rest stays settled', () => {
  assert.ok(isSettled(springStep({ x: 200, v: 0 }, 200, 1 / 60), 200));
});
