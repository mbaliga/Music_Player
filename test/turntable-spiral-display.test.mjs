import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../src/turntable/spiral.js';
import * as G from '../src/turntable/geometry.js';
import * as D from '../src/turntable/display.js';

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} !~ ${b}`);

test('spiral tables: M = 14000, TURNS = 12, radius/angle follow geometry', () => {
  assert.equal(S.M, 14000); assert.equal(S.TURNS, 12);
  const T = S.makeTables();
  assert.equal(T.rU.length, 14000);
  near(T.rU[0], 612, 1e-3); near(T.rU[13999], 268, 1e-3);
  near(T.thU[0], 0); near(T.thU[13999], 2 * Math.PI * 12, 1e-3);
  near(T.rU[7000], G.rOf(7000 / 13999), 1e-3);
  for (const i of [0, 100, 9000]) { near(T.cU[i], Math.cos(T.thU[i]), 1e-5); near(T.sU[i], Math.sin(T.thU[i]), 1e-5); }
});

test('peaks come from the real samples: min/max per bin, normalised, pow .8', () => {
  const env = S.makeEnv(100);
  const N = 10000;
  const x = new Float32Array(N); for (let i = 0; i < N; i++) x[i] = Math.sin(i / 20) * (i < N / 2 ? 0.25 : 1);
  const pk = S.computePeaks(env, (i) => x[i], N, 0, 99);
  near(pk, 1, 1e-3);
  assert.ok(env.hi[10] < env.hi[90] && env.hi[90] <= 1 + 1e-6);
  assert.ok(env.lo[90] < 0 && env.lo[90] >= -1 - 1e-6);
  near(env.hi[90], Math.pow(Math.max(...x.slice(9000, 9100)) / pk, 0.8), 0.02);
  // silence stays silent (no NaN from the 1e-6 floor)
  const z = S.computePeaks(env, () => 0, 100, 0, 99); assert.ok(z > 0); assert.equal(env.hi[5], 0);
});

test('peaks of a sub-range only touch that range (an album band)', () => {
  const env = S.makeEnv(100); S.fillSilence(env, 0, 99);
  S.computePeaks(env, () => 0.5, 5000, 20, 39);
  assert.equal(env.hi[19], 0); assert.ok(env.hi[20] > 0.99); assert.ok(env.hi[39] > 0.99); assert.equal(env.hi[40], 0);
});

test('fillRibbon matches a direct computation and does not allocate', () => {
  const T = S.makeTables(), env = S.makeEnv();
  for (let i = 0; i < S.M; i++) { env.hi[i] = 0.5; env.lo[i] = -0.5; }
  const pts = new Float32Array(S.M * 4);
  const s = 0.4, th0 = G.phiOf(s);
  S.fillRibbon(pts, T, env, s, 1, th0);
  for (const i of [0, 1, 5000, 5599, 13999]) {
    const u = i / 13999, d = (u - s) / (0.17 / 12), amp = 0.9 + (25 - 0.9) * Math.exp(-d * d);
    const ang = G.thG(u) + th0, r = G.rOf(u);
    const ro = r + env.hi[i] * amp + 0.4, ri = r + env.lo[i] * amp - 0.4;
    near(pts[4 * i], G.C.x + ro * Math.cos(ang), 0.02); near(pts[4 * i + 1], G.C.y + ro * Math.sin(ang), 0.02);
    near(pts[4 * i + 2], G.C.x + ri * Math.cos(ang), 0.02); near(pts[4 * i + 3], G.C.y + ri * Math.sin(ang), 0.02);
  }
  // the magnified part: amplitude is largest at the playhead
  const iS = S.playIndex(s);
  const wid = (i) => Math.hypot(pts[4 * i] - pts[4 * i + 2], pts[4 * i + 1] - pts[4 * i + 3]);
  assert.ok(wid(iS) > 10 * wid(iS + 3000));
  assert.equal(iS, Math.round(0.4 * 13999)); assert.deepEqual(S.highlightRange(0), [0, S.highlightRange(0)[1]]);
  // wv = 0 (waveform off) = the tiny base amplitude everywhere
  S.fillRibbon(pts, T, env, s, 0, th0); assert.ok(wid(iS) < 3);
});

test('the playhead stays at the stylus: the playhead point lands on thS(s) for any s (also while scratching)', () => {
  const T = S.makeTables();
  for (const s of [0, 0.1, 0.5, 0.93, 1]) {
    const i = S.playIndex(s), th0 = G.phiOf(s);
    const ang = T.thU[i] + th0;
    // point on the disc at the playhead (radius rU[i]) is at the stylus: same direction as thS(s)
    near(Math.cos(ang), Math.cos(G.thS(s)), 6e-3); near(Math.sin(ang), Math.sin(G.thS(s)), 6e-3);
  }
});

// ── display ──────────────────────────────────────────────────────────────────
test('dot-matrix grid constants', () => {
  assert.equal(D.DN, 12); assert.equal(D.GRID, 25); assert.equal(D.DP, 8);
  assert.equal(D.R_LIT, 3); assert.equal(D.R_UNLIT, 2.3); assert.equal(D.R_BEZEL, 108); assert.equal(G.DISP.bezel, 108);
});

test('5x7 font: glyph columns', () => {
  const cols = D.textCols('I');
  assert.equal(cols.length, 6 + 14);
  // 'I' = 01110,00100 x5,01110: the first column has rows 0 and 6 lit; the middle column all rows
  assert.equal(cols[0], 0); assert.equal(cols[1], (1 << 0) | (1 << 6)); assert.equal(cols[2], 0b1111111);
  assert.equal(cols[5], 0);
  assert.equal(D.textCols('a').length, D.textCols('A').length);   // case-insensitive
  assert.deepEqual(D.textCols('~'), D.textCols('?'));             // unknown glyph = '?'
  assert.deepEqual(D.textCols('A–B'), D.textCols('A-B'));
});

test('name rows are -3..3 and wrap around the scroll width', () => {
  const lit = new Uint8Array(D.GRID * D.GRID), cols = D.textCols('HI');
  D.fillName(lit, cols, 0);
  let any = false; for (let k = 0; k < lit.length; k++) if (lit[k]) any = true;
  assert.ok(any);
  for (let j = 0; j < D.GRID; j++) for (let i = 0; i < D.GRID; i++) if (lit[j * D.GRID + i]) assert.ok(j >= D.DN - 3 && j <= D.DN + 3, 'rows -3..3 only');
  assert.equal(D.scrollOffset(1, 20), 13 % 20); assert.equal(D.scrollOffset(3, 20), 39 % 20);
});

test('track pips: 1 track none, 5 tracks 2-col spacing, 12 tracks 1-col, 30 tracks mapped onto 21', () => {
  assert.deepEqual(D.pipLayout(1, 0).cols, []); assert.equal(D.pipLayout(0, 0).n, 0);
  const p5 = D.pipLayout(5, 2); assert.equal(p5.n, 5); assert.equal(p5.spacing, 2); assert.deepEqual(p5.cols, [-4, -2, 0, 2, 4]); assert.equal(p5.current, 2);
  const p10 = D.pipLayout(10, 9); assert.equal(p10.spacing, 2); assert.equal(p10.cols[0], -9); assert.equal(p10.cols[9], 9); assert.equal(p10.current, 9);
  const p12 = D.pipLayout(12, 0); assert.equal(p12.n, 12); assert.equal(p12.spacing, 1); assert.deepEqual(p12.cols, [-6, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6].map((v, i) => Math.round((i - 5.5))));
  const p21 = D.pipLayout(21, 20); assert.equal(p21.n, 21); assert.equal(p21.spacing, 1); assert.equal(p21.cols[0], -10); assert.equal(p21.cols[20], 10);
  const p30 = D.pipLayout(30, 15); assert.equal(p30.n, 21); assert.equal(p30.current, Math.round(15 * 20 / 29)); assert.equal(D.pipLayout(30, 29).current, 20); assert.equal(D.pipLayout(30, 0).current, 0);
  // every pip fits inside the 25-column grid
  for (const n of [2, 5, 10, 11, 21, 30, 99]) for (const c of D.pipLayout(n, 0).cols) assert.ok(Math.abs(c) <= D.DN);
  const lit = new Uint8Array(D.GRID * D.GRID); D.fillPips(lit, p5);
  assert.equal(lit[(6 + 12) * 25 + (0 + 12)], 1); assert.equal(lit[(6 + 12) * 25 + (2 + 12)], 2); assert.equal(lit[(6 + 12) * 25 + (1 + 12)], 0);
});

test('equaliser: 13 bars 2 columns apart, peak hold decays', () => {
  const lit = new Uint8Array(D.GRID * D.GRID), hold = new Float32Array(13), vals = new Float32Array(13);
  vals[0] = 0.5; vals[12] = 1;
  D.fillEq(lit, vals, hold);
  const col = (c) => { let n = 0; for (let j = 0; j < D.GRID; j++) if (lit[j * D.GRID + c + D.DN]) n++; return n; };
  // the prototype's bars grow from the centre row upward (rows below index 0 are clipped): a full bar is 13 dots, kept as is
  assert.equal(col(-12), 13); assert.equal(col(12), 13); assert.equal(col(-11), 0);
  const v2 = new Float32Array(13); D.fillEq(new Uint8Array(625), v2, hold); near(hold[12], 0.98); near(hold[0], 0.48);
  const bytes = new Uint8Array(32).fill(230); const o = new Float32Array(13); D.eqFromBytes(bytes, o); assert.equal(o[0], 1);
  assert.equal(D.EQ_BARS, 13);
});
