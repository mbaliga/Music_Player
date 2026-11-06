// cassette-reels.test.mjs — pure reel/tape physics (area-conserving pack,
// omega = v / r, forward = counter-clockwise, side B mirror) and the DOM-free
// parts of the reel driver (no per-frame churn).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import {
  FAMS, RH, famFor, rU, packR, playSpeed, hubStep, rollerStep, mirrorProgress, markerX, tapeD,
  OMEGA_MID, MAX_HUB_STEP,
} from '../src/cassette/reels-physics.js';
import { createReelDriver } from '../src/cassette/reels-driver.js';
import { Cassette } from '../src/cassette/index.js';

const families = Object.values(FAMS);

test('families: opaque / clear / glass chosen from the style', () => {
  assert.equal(famFor(Cassette.style('brass')), FAMS.baseOpaque);
  assert.equal(famFor(Cassette.style('clear')), FAMS.baseClear);
  assert.equal(famFor(Cassette.style('smoke')), FAMS.baseClear);
  assert.equal(famFor(Cassette.style('glass-amber')), FAMS.glass);
  assert.equal(famFor(undefined), FAMS.baseOpaque);
});

test('pack radii conserve area: rL^2 + rR^2 is constant for every p and family', () => {
  for (const f of families) {
    const total = (f.R ** 2 + (RH * f.S) ** 2);          // full pack + empty core, in px^2
    for (let i = 0; i <= 100; i++) {
      const p = i / 100, l = packR(f, 'left', p), r = packR(f, 'right', p);
      assert.ok(Math.abs(l * l + r * r - total) < 1e-6, `${f.key} p=${p}`);
    }
  }
});

test('pack radii: p=0 supply full / take-up bare, p=1 swapped, monotonic, clamped', () => {
  for (const f of families) {
    const core = RH * f.S;
    assert.ok(Math.abs(packR(f, 'left', 0) - f.R) < 1e-9 && Math.abs(packR(f, 'right', 0) - core) < 1e-9);
    assert.ok(Math.abs(packR(f, 'left', 1) - core) < 1e-9 && Math.abs(packR(f, 'right', 1) - f.R) < 1e-9);
    let prev = packR(f, 'right', 0);
    for (let i = 1; i <= 50; i++) { const x = packR(f, 'right', i / 50); assert.ok(x >= prev); prev = x; }
    assert.equal(packR(f, 'left', -4), packR(f, 'left', 0));
    assert.equal(packR(f, 'right', 9), packR(f, 'right', 1));
    assert.equal(packR(f, 'right', NaN), packR(f, 'right', 0));
    assert.ok(packR(f, 'left', 0.25) - packR(f, 'left', 0.75) > 3);   // visibly different (the point)
  }
});

test('side B is the mirror of side A: progress_B = 1 - progress_A swaps the reels', () => {
  assert.equal(mirrorProgress(0.3), 0.7); assert.equal(mirrorProgress(-1), 1); assert.equal(mirrorProgress(2), 0);
  for (const f of families) for (const p of [0, 0.2, 0.5, 0.83, 1]) {
    // face B's left reel is face A's right reel seen from behind
    assert.ok(Math.abs(packR(f, 'left', mirrorProgress(p)) - packR(f, 'right', p)) < 1e-9);
    assert.ok(Math.abs(packR(f, 'right', mirrorProgress(p)) - packR(f, 'left', p)) < 1e-9);
  }
});

test('omega = v / r: tape speed equal at both reels, small roll spins faster', () => {
  const dt = 1 / 120;                                    // small step: no cap involved
  for (const f of families) {
    for (const p of [0.1, 0.4, 0.5, 0.9]) {
      const wL = Math.abs(hubStep(f, 'left', p, 1, dt)) / dt, wR = Math.abs(hubStep(f, 'right', p, 1, dt)) / dt;
      const v = playSpeed(f);
      assert.ok(Math.abs(wL * rU(f, 1 - p) - v) < 1e-6 * v, 'left v = w r');
      assert.ok(Math.abs(wR * rU(f, p) - v) < 1e-6 * v, 'right v = w r');
      assert.ok((wL > wR) === (packR(f, 'left', p) < packR(f, 'right', p)), 'smaller pack spins faster');
    }
    // mid-pack hub turns at OMEGA_MID in play
    assert.ok(Math.abs(Math.abs(hubStep(f, 'left', 0.5, 1, 1 / 1000)) * 1000 - OMEGA_MID) < 1e-6);
  }
});

test('direction: forward (and play) turns counter-clockwise (negative), rewind clockwise, stopped = 0', () => {
  const f = FAMS.baseClear;
  assert.ok(hubStep(f, 'left', 0.5, 1, 0.016) < 0 && hubStep(f, 'right', 0.5, 1, 0.016) < 0);
  assert.ok(hubStep(f, 'left', 0.5, -24, 0.016) > 0);
  assert.ok(rollerStep(f, 1, 0.016) < 0 && rollerStep(f, -1, 0.016) > 0);
  assert.equal(hubStep(f, 'left', 0.5, 0, 0.016), 0);
  assert.equal(hubStep(f, 'left', 0.5, 1, 0), 0);
  assert.equal(rollerStep(f, 0, 0.016), 0);
});

test('hub step is capped per frame (no wagon-wheel aliasing) even at wind speed or a long frame', () => {
  const f = FAMS.glass;
  assert.equal(Math.abs(hubStep(f, 'left', 0.99, 64, 0.05)), MAX_HUB_STEP);
  assert.ok(Math.abs(hubStep(f, 'left', 0.5, 1, 0.016)) < MAX_HUB_STEP);
  assert.ok(Math.abs(rollerStep(f, 64, 0.05)) <= 0.9);
});

test('marker and tape path follow progress', () => {
  const f = FAMS.baseClear;
  assert.equal(markerX(f, 0), f.mark.x0); assert.equal(markerX(f, 1), f.mark.x1); assert.equal(markerX(f, 7), f.mark.x1);
  const d0 = tapeD(f, packR(f, 'left', 0), packR(f, 'right', 0)), d1 = tapeD(f, packR(f, 'left', 1), packR(f, 'right', 1));
  assert.match(d0, /^M[\d.\- ]+L[\d.\- ]+A9 9 0 0 0/);
  assert.notEqual(d0, d1);
  assert.ok(!/NaN|Infinity/.test(d0 + d1));
  for (const f2 of [FAMS.baseClear, FAMS.glass]) for (let i = 0; i <= 20; i++) assert.ok(!/NaN/.test(tapeD(f2, packR(f2, 'left', i / 20), packR(f2, 'right', i / 20))));
});

// ── driver against fake DOM nodes ────────────────────────────────────────────
function fakeEl() {
  const attrs = {};
  const el = { attrs, rot: 0, rotCalls: 0,
    setAttribute(k, v) { attrs[k] = v; this.sets = (this.sets || 0) + 1; },
    querySelector(sel) { return this.kids && this.kids[sel] || null; },
    transform: { baseVal: { numberOfItems: 1, getItem: () => ({ setRotate: (deg) => { el.rot = deg; el.rotCalls++; } }) } } };
  return el;
}
function fakeHandle() {
  const mk = () => {
    const spin = fakeEl(), pack = fakeEl(), edge = fakeEl();
    return { spin, pack, edge, g: { querySelector: (s) => ({ '[data-pack]': pack, '[data-edge]': edge, '[data-spin]': spin }[s]) } };
  };
  const L = mk(), R = mk(), tape = fakeEl(), rl = fakeEl(), rr = fakeEl(), mark = fakeEl();
  const svg = { querySelector: (s) => ({ '[data-tape]': tape, '[data-roller="L"]': rl, '[data-roller="R"]': rr, '[data-marker]': mark }[s] || null) };
  return { L, R, tape, rl, rr, mark, h: { svg, reels: { left: L.g, right: R.g }, cfg: { noHits: true } } };
}

test('driver: spins hubs by omega = v / r, rewrites packs/tape only when progress moves', () => {
  const f = fakeHandle(), d = createReelDriver();
  d.bind(f.h, Cassette.style('clear'));
  d.frame(0.5, 1, 1 / 60);
  assert.ok(f.L.spin.rot !== 0 && f.R.spin.rot !== 0);
  assert.ok(f.L.pack.attrs.r && f.tape.attrs.d && f.mark.attrs.x);
  const w0 = d.stats.packWrites, t0 = d.stats.tapeWrites;
  for (let i = 0; i < 300; i++) d.frame(0.5, 1, 1 / 60);          // same progress: spin only
  assert.equal(d.stats.packWrites, w0); assert.equal(d.stats.tapeWrites, t0);
  assert.ok(f.L.spin.rotCalls > 300);
  d.frame(0.5 + 0.01, 1, 1 / 60);
  assert.equal(d.stats.packWrites, w0 + 1);
  d.frame(0.51, 0, 1 / 60);                                         // stopped: no spin writes
  const spins = d.stats.spinWrites;
  d.frame(0.51, 0, 1 / 60); assert.equal(d.stats.spinWrites, spins);
  // reverse motion rotates the other way
  const before = f.L.spin.rot;
  d.frame(0.51, -24, 1 / 60); assert.ok(f.L.spin.rot > before || before > 100);
});

test('driver: no per-frame allocation in the steady state (heap flat over 200k frames)', () => {
  v8.setFlagsFromString('--expose_gc');
  const gc = vm.runInNewContext('gc');
  const f = fakeHandle(), d = createReelDriver();
  d.bind(f.h, Cassette.style('glass'));
  for (let i = 0; i < 2000; i++) d.frame(0.4, 1, 1 / 60);          // warm up
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 200000; i++) d.frame(0.4 + (i % 2) * 1e-6, 1, 1 / 60);
  gc(); gc();
  const grew = process.memoryUsage().heapUsed - before;
  assert.ok(grew < 1.5e6, `heap grew ${grew} bytes over 200k frames`);
});

test('driver: bind with no handle / frame before bind are harmless', () => {
  const d = createReelDriver();
  d.frame(0.5, 1, 0.016); d.set(0.3); d.bind(null); d.destroy(); d.frame(0.5, 1, 0.016);
});
