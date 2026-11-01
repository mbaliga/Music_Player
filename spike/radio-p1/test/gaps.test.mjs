import test from 'node:test';
import assert from 'node:assert/strict';
import { findGaps, parseWavPcm16 } from '../lib/gaps.mjs';

const SR = 8000;
const tone = (ms, amp = 0.3) => Float32Array.from({ length: Math.round(SR * ms / 1000) }, (_, i) => amp * Math.sin(2 * Math.PI * 440 * i / SR));
const cat = (...a) => { const o = new Float32Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

test('findGaps: finds a 300 ms dropout with ~correct position, ignores a 50 ms one', () => {
  const s = cat(tone(2000), new Float32Array(SR * 0.3), tone(2000), new Float32Array(SR * 0.05), tone(1000));
  const { gaps } = findGaps(s, SR, { minGapMs: 100 });
  assert.equal(gaps.length, 1);
  assert.ok(Math.abs(gaps[0].startMs - 2000) <= 20 && Math.abs(gaps[0].durMs - 300) <= 20, JSON.stringify(gaps));
});
test('findGaps: continuous tone has none', () => assert.equal(findGaps(tone(3000), SR).gaps.length, 0));

test('parseWavPcm16 round-trips a tiny file and rejects non-wav', () => {
  const n = 100, b = new Uint8Array(44 + n * 2), dv = new DataView(b.buffer);
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0); dv.setUint32(4, 36 + n * 2, true); b.set([...'WAVEfmt '].map((c) => c.charCodeAt(0)), 8);
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, SR, true); dv.setUint32(28, SR * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  b.set([...'data'].map((c) => c.charCodeAt(0)), 36); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, 16384, true);
  const w = parseWavPcm16(b);
  assert.equal(w.sampleRate, SR); assert.equal(w.samples.length, n); assert.ok(Math.abs(w.samples[0] - 0.5) < 1e-4);
  assert.throws(() => parseWavPcm16(new Uint8Array(64)), /RIFF/);
});
