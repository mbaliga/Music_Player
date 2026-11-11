// tonearm.test.mjs — track-boundary geometry + flick classifier (pure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TONEARM_KNOBS as K, estimateDurations, buildLayout, locate, seekTarget,
  radiusFor, stepIndex, previousTarget, classifyFlick,
} from '../src/tonearm.js';
import { timeAtRadius, radiusAtTime } from '../src/model.js';

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);

test('estimateDurations fills unknowns with the mean of the known', () => {
  assert.deepEqual(estimateDurations([100, null, 300]), [100, 200, 300]);
  assert.deepEqual(estimateDurations([null, undefined]), [1, 1]);
});

test('one track: no gaps, reduces exactly to model.js', () => {
  const L = buildLayout([240], 200, 64);
  assert.equal(L.gaps.length, 0);
  for (const r of [200, 180, 120, 64]) {
    near(seekTarget(L, r).time, timeAtRadius(r, 240, 200, 64), 1e-6 + (r === 200 ? 1 : 0));
  }
  near(radiusFor(L, 0, 60), radiusAtTime(60, 240, 200, 64));
});

test('bands tile the annulus, widths ~ duration, separated by gaps', () => {
  const L = buildLayout([100, 200, 100], 200, 60);
  assert.equal(L.bands.length, 3);
  assert.equal(L.gaps.length, 2);
  near(L.bands[0].rA, 200);
  near(L.bands[2].rB, 60);
  const w = L.bands.map((b) => b.rA - b.rB);
  near(w[1], 2 * w[0], 1e-9);
  near(L.bands[0].rB, L.gaps[0].rA);                       // gap abuts the band
  near(L.gaps[0].rB, L.bands[1].rA);
  near(L.gaps[0].rA - L.gaps[0].rB, K.gapFrac * 140);
});

test('locate: inside a band -> track + fraction', () => {
  const L = buildLayout([100, 100], 200, 60);
  const b = L.bands[1];
  const mid = (b.rA + b.rB) / 2;
  const loc = locate(L, mid);
  assert.equal(loc.zone, 'track');
  assert.equal(loc.index, 1);
  near(loc.frac, 0.5, 1e-9);
});

test('gap: any radius in the (widened) gap zone drops at the START of the next track', () => {
  const L = buildLayout([100, 100, 100], 200, 60);
  const g = L.gaps[0];
  for (const dr of [0, 3, -3, K.gapGrabPx / 2 - 0.01, -(K.gapGrabPx / 2 - 0.01)]) {
    const s = seekTarget(L, g.r + dr);
    assert.equal(s.zone, 'gap');
    assert.equal(s.index, 1);
    assert.equal(s.time, 0);
  }
  assert.equal(seekTarget(L, L.gaps[1].r).index, 2);
  // clearly inside track 0, outside the grab zone
  assert.equal(seekTarget(L, g.r + K.gapGrabPx).zone === 'gap', false);
});

test('start snap: just inside a band edge lands at t=0', () => {
  const L = buildLayout([100, 100], 200, 60);
  const b = L.bands[1];
  const s = seekTarget(L, b.rA - 0.001 * 140, { ...K, gapGrabPx: 0, gapFrac: 0 });
  assert.equal(s.time, 0);
});

test('seek then radiusFor round-trips inside a band', () => {
  const L = buildLayout([180, 240, 120], 200, 60);
  const r = radiusFor(L, 1, 100);
  const s = seekTarget(L, r);
  assert.equal(s.index, 1);
  near(s.time, 100, 1e-6);
});

test('out-of-range radii clamp to first / last track', () => {
  const L = buildLayout([100, 100], 200, 60);
  assert.equal(locate(L, 999).index, 0);
  assert.equal(locate(L, -5).index, 1);
});

test('stepIndex / previousTarget (deck semantics)', () => {
  assert.equal(stepIndex(0, -1, 3), null);
  assert.equal(stepIndex(2, 1, 3), null);
  assert.equal(stepIndex(1, 1, 3), 2);
  assert.deepEqual(previousTarget(2, 30, 5), { index: 2, time: 0 });   // far in -> restart
  assert.deepEqual(previousTarget(2, 1, 5), { index: 1, time: 0 });    // near start -> previous
  assert.deepEqual(previousTarget(0, 1, 5), { index: 0, time: 0 });    // first track
});

// ── flick ──
const C = { x: 0, y: 0 };
const trail = (n, dtMs, f) => Array.from({ length: n }, (_, i) => ({ ...f(i / (n - 1)), t: i * dtMs }));
const arcTrail = (rad, sweep, ms) => trail(8, ms / 7, (u) => ({
  x: rad * Math.sin(sweep * u), y: -rad * Math.cos(sweep * u),
}));

test('flick: quick clockwise arc = next, counter-clockwise = prev', () => {
  assert.equal(classifyFlick(arcTrail(200, 0.5, 120), C).dir, 'next');
  assert.equal(classifyFlick(arcTrail(200, -0.5, 120), C).dir, 'prev');
});

test('flick: too slow, too short, or radial = not a flick', () => {
  assert.equal(classifyFlick(arcTrail(200, 0.5, 900), C).dir, null);       // slow
  assert.equal(classifyFlick(arcTrail(200, 0.1, 60), C).dir, null);        // short (20px)
  const radial = trail(8, 15, (u) => ({ x: 0, y: -(200 + 100 * u) }));
  assert.equal(classifyFlick(radial, C).dir, null);                        // radial placement
  assert.equal(classifyFlick([], C).dir, null);
  assert.equal(classifyFlick([{ x: 1, y: 1, t: 0 }], C).dir, null);
});

test('flick: only the trailing flickMaxMs window counts (slow approach, quick end)', () => {
  const slow = arcTrail(200, 0.2, 2000);
  const lastT = slow[slow.length - 1].t;
  const quick = arcTrail(200, 0.5, 120).slice(1).map((p) => ({ ...p, t: p.t + lastT }));
  // the quick part starts where the slow part ended in angle
  const off = 0.2;
  const rot = quick.map((p) => {
    const a = Math.atan2(p.x, -p.y) + off;
    return { x: 200 * Math.sin(a), y: -200 * Math.cos(a), t: p.t };
  });
  assert.equal(classifyFlick([...slow, ...rot], C).dir, 'next');
});

test('flick: wraps correctly across the +/-PI seam', () => {
  const pts = trail(8, 15, (u) => {
    const a = Math.PI - 0.25 + 0.5 * u;  // crosses PI (atan2 seam), screen-clockwise-ish
    return { x: 200 * Math.cos(a), y: 200 * Math.sin(a) };
  });
  assert.equal(classifyFlick(pts, C).dir, 'next');
});
