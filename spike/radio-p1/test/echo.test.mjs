import test from 'node:test';
import assert from 'node:assert/strict';
import { fft, crossCorrelate, echoMetrics, classifyEcho, simulateEcho, rms, toDb } from '../lib/echo.mjs';
import { speechLike, noise } from '../lib/synth.mjs';

const SR = 16000;

test('fft: forward then inverse recovers the signal; impulse -> flat spectrum', () => {
  const n = 64, re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin(i * 0.3) + 0.1 * i;
  const orig = Float64Array.from(re);
  fft(re, im); fft(re, im, true);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(re[i] - orig[i]) < 1e-9);
  const r2 = new Float64Array(8), i2 = new Float64Array(8); r2[0] = 1; fft(r2, i2);
  assert.ok([...r2].every((v) => Math.abs(v - 1) < 1e-12));
});

test('crossCorrelate matches brute force', () => {
  const x = Float32Array.from({ length: 50 }, (_, i) => Math.sin(i)), y = Float32Array.from({ length: 80 }, (_, i) => Math.cos(i * 0.7));
  const c = crossCorrelate(x, y, 20);
  for (let l = 0; l <= 20; l++) {
    let s = 0; for (let n = 0; n < x.length; n++) if (n + l < y.length) s += x[n] * y[n + l];
    assert.ok(Math.abs(c[l] - s) < 1e-6, `lag ${l}`);
  }
});

test('echoMetrics recovers lag and coupling gain of a simulated echo path', () => {
  const ref = speechLike(SR, 3000, { seed: 5, level: 0.5 });
  const { cap, playStartSample } = simulateEcho(ref, SR, { delayMs: 85, gainDb: -20, noiseDb: -60, noiseFn: (n) => noise(SR, (n / SR) * 1000, 0, 9) });
  const m = echoMetrics(ref, cap, SR, { playStartSample });
  assert.ok(Math.abs(m.lagMs - 85) <= 1, `lag ${m.lagMs}`);
  assert.ok(Math.abs(m.echoReturnDb - -20) < 0.5, `echoReturn ${m.echoReturnDb}`);
  assert.ok(m.rho > 0.9);
  assert.equal(classifyEcho(m), 'leaky');
});

test('echoMetrics: attenuated echo (-45 dB, ~AEC-on) is distinguishable from -20 dB', () => {
  const ref = speechLike(SR, 3000, { seed: 5, level: 0.5 });
  const mk = (g) => { const { cap, playStartSample } = simulateEcho(ref, SR, { delayMs: 60, gainDb: g, noiseDb: -60, noiseFn: (n) => noise(SR, (n / SR) * 1000, 0, 9) }); return echoMetrics(ref, cap, SR, { playStartSample }); };
  const loud = mk(-20), quiet = mk(-45);
  assert.ok(loud.echoReturnDb - quiet.echoReturnDb > 20);
  assert.ok(loud.excessDb > quiet.excessDb + 15);
  assert.equal(classifyEcho(quiet), 'clean');
});

test('echoMetrics: no echo at all (noise only) -> low correlation, ~0 dB excess, clean', () => {
  const ref = speechLike(SR, 3000, { seed: 5, level: 0.5 });
  const cap = noise(SR, 800 + 3000 + 700, -60, 11);
  const m = echoMetrics(ref, cap, SR, { playStartSample: Math.round(0.8 * SR) });
  assert.ok(m.rho < 0.1, `rho ${m.rho}`);
  assert.ok(Math.abs(m.excessDb) < 3, `excess ${m.excessDb}`);
  assert.equal(classifyEcho(m), 'clean');
});

test('rms / toDb sanity', () => {
  assert.ok(Math.abs(toDb(rms(new Float32Array(100).fill(0.1))) - -20) < 1e-6);
  assert.equal(toDb(0), -180);
});

test('synth: speechLike is deterministic per seed, normalised to level, broadband (not a pure tone)', () => {
  const a = speechLike(SR, 500, { seed: 2, level: 0.4 }), b = speechLike(SR, 500, { seed: 2, level: 0.4 });
  assert.deepEqual(a, b);
  assert.ok(Math.abs(Math.max(...a.map(Math.abs)) - 0.4) < 1e-6);
  let zc = 0; for (let i = 1; i < a.length; i++) if ((a[i] > 0) !== (a[i - 1] > 0)) zc++;
  assert.ok(zc > 20);
});
