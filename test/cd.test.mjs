// cd.test.mjs — CD view geometry (pure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTime, segmentArcs, angleFromTop, hitTest, CD_KNOBS as K } from '../src/cd.js';

const TAU = Math.PI * 2;

test('formatTime', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(65.9), '1:05');
  assert.equal(formatTime(3600), '60:00');
  assert.equal(formatTime(-3), '0:00');
  assert.equal(formatTime(NaN), '0:00');
});

test('segmentArcs: tile the circle in order, proportional, with gaps', () => {
  const a = segmentArcs([1, 2, 1]);
  assert.equal(a.length, 3);
  for (let i = 1; i < a.length; i++) assert.ok(a[i].a0 > a[i - 1].a1);
  assert.ok(a[2].a1 < TAU);
  assert.ok(Math.abs((a[1].a1 - a[1].a0) - 2 * (a[0].a1 - a[0].a0)) < 1e-9);
  assert.deepEqual(segmentArcs([]), []);
  const eq = segmentArcs([0, 0]);                       // unknown durations -> equal
  assert.ok(Math.abs((eq[0].a1 - eq[0].a0) - (eq[1].a1 - eq[1].a0)) < 1e-9);
  assert.equal(segmentArcs([5]).length, 1);
});

test('angleFromTop: clockwise from 12 o\'clock', () => {
  assert.ok(Math.abs(angleFromTop(0, -1, 0, 0)) < 1e-12);
  assert.ok(Math.abs(angleFromTop(1, 0, 0, 0) - Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(angleFromTop(0, 1, 0, 0) - Math.PI) < 1e-12);
  assert.ok(Math.abs(angleFromTop(-1, 0, 0, 0) - 3 * Math.PI / 2) < 1e-12);
});

test('hitTest: segment ring, progress ring, gap snap, miss', () => {
  const arcs = segmentArcs([1, 1, 1, 1]);
  const R = 100;
  const at = (frac, rr) => [R * rr * Math.sin(frac * TAU), -R * rr * Math.cos(frac * TAU)];
  const seg = (f) => hitTest(...at(f, 0.92), 0, 0, R, arcs);
  assert.deepEqual(seg(0.125), { ring: 'segments', index: 0 });
  assert.deepEqual(seg(0.375), { ring: 'segments', index: 1 });
  assert.deepEqual(seg(0.875), { ring: 'segments', index: 3 });
  // exactly in the gap between 0 and 1 (a = 0.25 TAU) snaps to a neighbour
  assert.ok([0, 1].includes(seg(0.25).index));
  const p = hitTest(...at(0.5, 0.74), 0, 0, R, arcs);
  assert.equal(p.ring, 'progress');
  assert.ok(Math.abs(p.frac - 0.5) < 1e-9);
  assert.equal(hitTest(0, 0, 0, 0, R, arcs), null);                 // hub
  assert.equal(hitTest(...at(0.1, 1.2), 0, 0, R, arcs), null);       // outside
  assert.ok(K.progInner < K.progOuter && K.progOuter < K.segInner);
});
