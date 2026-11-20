import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/turntable/geometry.js';
import * as K from '../src/turntable/camera.js';
import * as A from '../src/turntable/arm.js';

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} !~ ${b}`);

test('stage constants are the handoff numbers', () => {
  assert.deepEqual({ ...G.VB }, { x: 222.5, y: -15, w: 1241, h: 561 });
  assert.deepEqual({ ...G.C }, { x: 278, y: 457 });
  assert.equal(G.RDISC, 644); assert.equal(G.QY, 80); assert.equal(G.DS, 502); assert.equal(G.DIMX, 330); assert.equal(G.QPARK, 1393);
  near(G.AD, 22 * Math.PI / 180); assert.equal(G.TURNS, 12);
});

test('carriage kinematics: the stylus path is a horizontal chord from radius 612 to 268', () => {
  near(G.TY, 80 + Math.sin(G.AD) * 502);
  near(G.TY, 268.0525098947878, 1e-9);
  near(G.TX0, 860.1020924055683, 1e-9); near(G.TX1, 468.0601114988117, 1e-9);
  near(G.QS, G.TX0 + Math.cos(G.AD) * 502, 1e-9); near(G.QS, 1325.5483873980957, 1e-9);
  near(G.TRAVEL, G.TX0 - G.TX1); near(G.TRAVEL, 392.04198090675663, 1e-9);
  for (const s of [0, 0.13, 0.5, 0.77, 1]) near(G.Tp(s).y, G.TY, 1e-9);          // horizontal chord
  near(G.rOf(0), 612, 1e-9); near(G.rOf(1), 268, 1e-9);
  assert.equal(G.R_OUT, G.rOf(0)); assert.equal(G.R_IN, G.rOf(1));
  // radius falls monotonically with s along the chord (the groove is a single spiral)
  let prev = Infinity; for (let i = 0; i <= 100; i++) { const r = G.rOf(i / 100); assert.ok(r < prev); prev = r; }
  near(G.KTH, 2 * Math.PI * 12 / (612 - 268));
});

test('disc rotation phi(s) = thS(s) - thG(s) keeps groove point s under the stylus', () => {
  for (const s of [0, 0.25, 0.5, 1]) {
    // the groove point u = s on the disc, rotated by phi, lands at the stylus angle thS(s)
    near(G.thG(s) + G.phiOf(s), G.thS(s), 1e-9);
  }
  near(G.phiOf(0), G.thS(0) - 0);
  near(G.thG(0), 0); near(G.thG(1), 2 * Math.PI * 12, 1e-9);
});

test('camFor: landscape viewBox centre / matrix', () => {
  const W = 1241, H = 561;
  const c = K.camFor(false, W, H, 1);
  near(c.s0, 1); near(c.s, 1);
  assert.deepEqual(c.M.map((v) => Math.round(v * 1e6) / 1e6), [1, 0, 0, 1, W / 2 - 843, H / 2 - 265.5]);
  assert.equal(c.vcx, 843); assert.equal(c.vcy, 265.5);
  // the stage's centre (843, 265.5) maps to the viewport centre
  near(c.M[0] * 843 + c.M[2] * 265.5 + c.M[4], W / 2); near(c.M[1] * 843 + c.M[3] * 265.5 + c.M[5], H / 2);
  const r = K.rectOf(c.M); near(r.x, 0); near(r.y, 0); near(r.w, 1241); near(r.h, 561);
  assert.equal(K.viewBoxFor(c, W, H), '222.50 -15.00 1241.00 561.00');
});

test('camFor: portrait = stage rotated 90 degrees clockwise (screen top is the stage left edge)', () => {
  const W = 561, H = 1241;
  const c = K.camFor(true, W, H, 1);
  near(c.s, 1);
  assert.deepEqual(c.M.map((v) => Math.round(v * 1e6) / 1e6), [0, 1, -1, 0, W / 2 + 265.5, H / 2 - 843]);
  // stage left-top (222.5,-15) -> screen (W, 0): the right-top corner; stage left-bottom (222.5,546) -> screen (0,0)
  const sx = (x, y) => c.M[0] * x + c.M[2] * y + c.M[4], sy = (x, y) => c.M[1] * x + c.M[3] * y + c.M[5];
  near(sx(222.5, -15), 561); near(sy(222.5, -15), 0);
  near(sx(222.5, 546), 0); near(sy(222.5, 546), 0);
  near(sx(1463.5, 546), 0); near(sy(1463.5, 546), 1241);
  // the disc centre (278,457) lands near the top of the screen, left of centre
  near(sx(278, 457), 89); near(sy(278, 457), 55.5);
  // the same rotation as the SVG layers use (PORTRAIT_TRANSFORM): translate(561 0) rotate(90) translate(-222.5 15)
  const px = 561 - (457 + 15), py = 278 - 222.5; near(px, 89); near(py, 55.5);
  assert.equal(G.PORTRAIT_TRANSFORM, 'translate(561 0) rotate(90) translate(-222.5 15)');
  assert.equal(c.vcx, 280.5); assert.equal(c.vcy, 620.5);
  // a narrower aspect (582x1162 = the handoff's check size) is limited by width
  const n = K.camFor(true, 582, 1162, 1); near(n.s0, Math.min(582 / 561, 1162 / 1241));
});

test('zoom choreography windows (smoothstep sm(a,b,z)) and K1 = .56', () => {
  assert.equal(K.ZOOM.K1, 0.56);
  near(K.sm(0, 0.5, 0), 0); near(K.sm(0, 0.5, 0.25), 0.5); near(K.sm(0, 0.5, 0.5), 1); near(K.sm(0.1, 0.5, 0.3), 0.5);
  const l0 = K.layers(0), l5 = K.layers(0.5), l1 = K.layers(1);
  near(l0.k, 1); near(l5.k, 0.56); near(l1.k, 0.56);
  near(K.layers(0.25).k, 1 - 0.44 * 0.5);
  near(l0.matOpacity, 1); near(l5.matOpacity, 0); near(K.layers(0.3).matOpacity, 0.5);
  near(K.layers(0.2).controlsOpacity, 0.4); near(K.layers(1 / 3).controlsOpacity, 0);
  assert.equal(l0.topPointerEvents, ''); assert.equal(K.layers(0.05).topPointerEvents, 'none');
  near(l0.frameOpacity, 0); assert.ok(K.layers(0.2).frameOpacity > 0.9); near(K.layers(0.5).frameOpacity, 0);
  near(l0.libBgOpacity, 0); near(K.layers(0.3).libBgOpacity, 0); near(K.layers(0.55).libBgOpacity, 1);
  near(K.layers(0.42).libOpacity, 0); near(K.layers(0.6).libOpacity, 1);
  assert.equal(K.layers(0.6).libInteractive, false); assert.equal(K.layers(0.61).libInteractive, true);
  assert.equal(K.layers(0.34).showDisplay, true); assert.equal(K.layers(0.35).showDisplay, false);
  near(K.layers(0.175).displayAlpha, 0.5);
  assert.deepEqual(l0.bg, [0, 0, 3]); assert.deepEqual(l1.bg, [22, 22, 25]);
});

test('disc path: phase A lifts to the hover point (6% bump), phase B lowers into the slot centre', () => {
  const MX = K.camFor(false, 1241, 561, 1).M;
  const slot = { left: 600, top: 200, width: 200, height: 200 };
  assert.equal(K.discPlacement(0, MX, slot, G.C, G.RDISC), null);
  const se = 1, rt = 0.46 * 200, rh = rt / (644 * se);
  // z = .5: phase A complete (eA = 1), phase B starting (eB = 0): hover point = slot centre x, 0.62 * width above its centre y
  const h = K.discPlacement(0.5, MX, slot, G.C, G.RDISC);
  near(h.rho, rh * (1 + 0.06 * Math.sin(Math.PI * Math.min(1, 0.5 / 0.3))), 1e-9);
  const cx = (m) => m[0] * G.C.x + m[2] * G.C.y + m[4], cy = (m) => m[1] * G.C.x + m[3] * G.C.y + m[5];
  near(cx(h.M), 700, 1e-6); near(cy(h.M), 300 - 0.62 * 200, 1e-6);
  // z = 1: into the slot centre, rho = rh (bump is 0 at z > .3: sin(pi*clamp(z/.3)) = sin(pi) = 0)
  const e = K.discPlacement(1, MX, slot, G.C, G.RDISC);
  near(e.rho, rh, 1e-9); near(cx(e.M), 700, 1e-6); near(cy(e.M), 300, 1e-6);
  // the 6% bump peaks at z = .15
  const b = K.discPlacement(0.15, MX, slot, G.C, G.RDISC);
  const eA = K.sm(0, 0.5, 0.15); near(b.rho, (1 + (rh - 1) * eA) * 1.06, 1e-9);
});

test('input: pinch IN = zoom OUT, gain 2.2, snaps .35 / .65, ctrl+wheel deltaY > 0 = zoom out', () => {
  near(K.pinchZ(0, 0.8), 0.44); near(K.pinchZ(0, 1.2), 0); near(K.pinchZ(1, 1.2), 1 - 0.44); near(K.pinchZ(0, 0.1), 1);
  assert.equal(K.pinchSettle(0.36, 0), 1); assert.equal(K.pinchSettle(0.34, 0), 0);
  assert.equal(K.pinchSettle(0.64, 1), 0); assert.equal(K.pinchSettle(0.66, 1), 1);
  near(K.wheelZ(0, 10), 0.12); near(K.wheelZ(0.5, -100), 0); assert.equal(K.wheelSettle(0.51), 1); assert.equal(K.wheelSettle(0.5), 0);
  // easing: monotone to the target, snaps, reduced motion is faster but still arrives
  let z = 0, n = 0; while (z !== 1 && n < 1000) { z = K.easeZ(z, 1, 1 / 60); n++; }
  assert.equal(z, 1); assert.ok(n > 20 && n < 120);
  let z2 = 0, n2 = 0; while (z2 !== 1 && n2 < 1000) { z2 = K.easeZ(z2, 1, 1 / 60, true); n2++; }
  assert.ok(n2 < n / 2);
});

test('tonearm pose: s in {0,.5,1}, d in {0,1}', () => {
  const lo = A.armPose(0, 1), mid = A.armPose(0.5, 1), hi = A.armPose(1, 1);
  near(lo.qx, G.QS); near(mid.qx, G.QS - 0.5 * G.TRAVEL); near(hi.qx, G.QS - G.TRAVEL);
  for (const p of [lo, mid, hi]) { near(p.ang, G.AD); near(p.rotDeg, 180 - 22, 1e-9); near(p.tipY, G.TY, 1e-9); near(p.qy, 80); }
  near(lo.tipX, G.TX0, 1e-9); near(hi.tipX, G.TX1, 1e-9);
  near(lo.dimX, G.QS - Math.cos(G.AD) * 330); near(lo.dimY, 80 + Math.sin(G.AD) * 330);
  // the stylus path is a horizontal chord: tipY constant for every s
  for (let i = 0; i <= 10; i++) near(A.armPose(i / 10, 1).tipY, G.TY, 1e-9);
  // d = 0: parked FLAT at QPARK regardless of s
  for (const s of [0, 0.5, 1]) { const p = A.armPose(s, 0); near(p.qx, 1393); near(p.ang, 0); near(p.rotDeg, 180); near(p.dimX, 1393 - 330); near(p.dimY, 80); }
  assert.equal(A.armTransform(A.armPose(0, 0)), 'translate(1393.00 80) rotate(180.000)');
  assert.equal(A.dimpleTransform(A.armPose(0, 0)), 'translate(1063.00 80.00)');   // the prototype's initial dimple
  // mid-fold is eased, between park and deployed
  const m = A.armPose(0.5, 0.5); near(m.ang, G.AD * 0.5); near(m.qx, 1393 + (G.QS - 0.5 * G.TRAVEL - 1393) * 0.5);
});

test('the parked arm lies flat inside the stadium slot', () => {
  const e = A.parkedExtent(), S = G.SLOT;
  assert.ok(e.x0 >= S.x + 4 && e.x1 <= S.x + S.w - 4, JSON.stringify(e));
  assert.ok(e.y0 >= S.y && e.y1 <= S.y + S.h, JSON.stringify(e));
  near(e.y0 + 28, 80);
});

test('arm drag: pointer x <-> s, with the grab offset kept', () => {
  for (const s of [0, 0.3, 1]) {
    const px = 700, off = A.grabOffset(s, px);
    near(A.sFromPointer(px, off), s, 1e-9);
    near(A.sFromPointer(px - 100, off), Math.min(1, s + 100 / G.TRAVEL), 1e-9);   // moving left = toward the inner groove
  }
  assert.equal(A.sFromPointer(-5000, 0), 1); assert.equal(A.sFromPointer(5000, 0), 0);
});
