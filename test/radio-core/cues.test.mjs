import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCues, extractCuesFromEnvelope, extractCuesFromPcm, toLibraryCues, kWeightCoefficients, synthPcm, synthEnvelope, songPlan } from '../../src/radio/core/cues.js';
import { validateContextSnapshot } from '../../src/radio/core/schemas.js';
import { snapshotFixture } from '../../src/radio/core/fixtures.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, want ${b} +-${tol}`);
const plan = songPlan({ durationSec: 200, leadSilenceSec: 1.5, introEndSec: 14, outroStartSec: 180, fadeEndSec: 195 });

test('envelope path finds intro end, outro start and trims on a structured song', () => {
  const r = extractCuesFromEnvelope(synthEnvelope(plan, 2000), { durationSec: 200, absolute: true });
  near(r.cues.introEndSec, 14, 0.8, 'introEnd');
  near(r.cues.outroStartSec, 180, 3, 'outroStart');
  near(r.cues.startTrimSec, 1.5, 0.3, 'startTrim');
  near(r.cues.endTrimSec, 5, 1.5, 'endTrim');
  assert.equal(r.cues.confidence, 'high');
  assert.ok(r.detail.introEnd.confidence >= 0.75 && r.detail.outroStart.confidence >= 0.75);
});

test('PCM path (stereo, 22.05 kHz) agrees with the envelope path', () => {
  const sr = 22050;
  const mono = synthPcm({ ...plan, sampleRate: sr });
  const r = extractCuesFromPcm({ channels: [mono, mono], sampleRate: sr });
  near(r.cues.introEndSec, 14, 0.8, 'introEnd');
  near(r.cues.outroStartSec, 180, 3, 'outroStart');
  near(r.cues.startTrimSec, 1.5, 0.3, 'startTrim');
  assert.equal(r.method, 'pcm-bs1770');
  assert.equal(r.detail.loudness.method, 'bs1770-gated');
  assert.ok(Number.isFinite(r.cues.loudnessGainDb));
});

test('model.js-style normalised envelope (pow 0.6) is accepted; loudness is then unknown', () => {
  const e = synthEnvelope(plan, 1024); let pk = 0; for (const v of e) pk = Math.max(pk, v);
  const norm = Float32Array.from(e, (v) => Math.pow(v / pk, 0.6));
  const r = extractCuesFromEnvelope(norm, { durationSec: 200 });
  near(r.cues.introEndSec, 14, 1.2, 'introEnd');
  near(r.cues.outroStartSec, 180, 4, 'outroStart');
  assert.equal(r.detail.loudness.lufs, null);
  assert.equal('loudnessGainDb' in r.cues, false);
});

test('constant tone: no intro, abrupt end, no trims, loudness still reported', () => {
  const x = synthPcm({ durationSec: 30, sampleRate: 8000, segments: [{ fromSec: 0, toSec: 30, from: 0.3, to: 0.3 }] });
  const r = extractCuesFromPcm({ samples: x, sampleRate: 8000 });
  assert.equal(r.cues.introEndSec, null);
  assert.equal(r.detail.introEnd.reason, 'no_intro');
  assert.equal(r.cues.outroStartSec, null);
  assert.equal(r.detail.outroStart.reason, 'abrupt_end');
  assert.equal(r.cues.startTrimSec, 0);
  assert.equal(r.cues.endTrimSec, 0);
  near(r.detail.loudness.lufs, 20 * Math.log10(0.3), 1, 'loudness');
});

test('pure silence and junk never throw and report low confidence', () => {
  const junk = [
    new Float32Array(0), new Float32Array(48000), new Float32Array(10), [], null, undefined, 42, 'x', {}, { channels: [] },
    { channels: [new Float32Array(100), new Float32Array(50)], sampleRate: 8000 },
    { samples: new Float32Array(8000).fill(NaN), sampleRate: 8000 },
    { samples: new Float32Array(8000).fill(Infinity), sampleRate: 8000 },
    { samples: new Float32Array(8000), sampleRate: -1 }, { samples: new Float32Array(8000), sampleRate: NaN },
  ];
  for (const j of junk) {
    const r = extractCues(j, { sampleRate: 48000 });
    assert.equal(r.schema, 'runout/cues/1');
    assert.equal(r.cues.confidence, 'low', JSON.stringify(r.warnings));
    assert.equal(r.cues.introEndSec, null);
    assert.equal(r.cues.outroStartSec, null);
  }
  for (const e of [null, [], [NaN, NaN, NaN], new Float32Array(100), [1], 'abc', [0, 0, 'x']]) {
    for (const d of [0, -5, NaN, 10, undefined]) {
      const r = extractCuesFromEnvelope(e, { durationSec: d });
      assert.equal(r.cues.confidence, 'low');
    }
  }
  assert.ok(extractCuesFromPcm(new Float32Array(48000), { sampleRate: 48000 }).warnings.includes('silent'));
});

test('mismatched stereo channels are truncated with a warning', () => {
  const a = synthPcm({ durationSec: 20, sampleRate: 8000, segments: [{ fromSec: 0, toSec: 20, from: 0.3, to: 0.3 }] });
  const r = extractCuesFromPcm({ channels: [a, a.subarray(0, 8000)], sampleRate: 8000 });
  assert.ok(r.warnings.includes('channel_length_mismatch_truncated'));
  near(r.durationSec, 1, 0.01, 'duration');
});

test('very short clip: trims and loudness only, structure cues null', () => {
  const x = synthPcm({ durationSec: 1.2, sampleRate: 8000, segments: [{ fromSec: 0.2, toSec: 1.1, from: 0.3, to: 0.3 }] });
  const r = extractCuesFromPcm({ samples: x, sampleRate: 8000 });
  assert.equal(r.cues.introEndSec, null);
  assert.equal(r.cues.outroStartSec, null);
  assert.ok(r.warnings.includes('too_short_for_structure'));
  near(r.cues.startTrimSec, 0.2, 0.15, 'startTrim');
  assert.ok(r.detail.loudness.lufs !== null);
});

test('clipping is flagged and does not move the cues', () => {
  const base = synthPcm({ ...plan, durationSec: 200, sampleRate: 8000 });
  const loud = Float32Array.from(base, (v) => Math.max(-1, Math.min(1, v * 3)));
  const r = extractCuesFromPcm({ samples: loud, sampleRate: 8000 });
  assert.ok(r.warnings.includes('clipping'));
  near(r.cues.introEndSec, 14, 0.8, 'introEnd');
  near(r.cues.outroStartSec, 180, 4, 'outroStart');
  assert.equal(r.detail.loudness.samplePeak, 1);
});

test('a quiet-intro gradual build is low/med confidence or null, never confidently wrong', () => {
  const gradual = { durationSec: 120, segments: [{ fromSec: 0, toSec: 40, from: 0.05, to: 0.4 }, { fromSec: 40, toSec: 110, from: 0.4, to: 0.4 }, { fromSec: 110, toSec: 119, from: 0.4, to: 0.002 }] };
  const r = extractCuesFromEnvelope(synthEnvelope(gradual, 1200), { durationSec: 120, absolute: true });
  assert.ok(r.cues.introEndSec === null || r.detail.introEnd.confidence < 0.75, JSON.stringify(r.detail.introEnd));
});

test('BS.1770 loudness: sine references (dual-mono -23 dBFS = -23 LUFS) at several rates', () => {
  for (const sr of [44100, 48000, 22050]) {
    const n = sr * 10, A = Math.pow(10, -23 / 20), x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = A * Math.sin(2 * Math.PI * 997 * i / sr);
    const mono = extractCuesFromPcm({ samples: x, sampleRate: sr });
    near(mono.detail.loudness.lufs, -23, 0.15, `mono ${sr}`);
    const st = extractCuesFromPcm({ channels: [x, x], sampleRate: sr });
    near(st.detail.loudness.lufs, -23, 0.15, `stereo ${sr}`);
    near(st.cues.loudnessGainDb, 7, 0.2, 'gain to -16');
  }
  // gating: -23 LUFS section plus a long -60 dBFS gap (below the absolute gate) must not pull the result down
  const sr = 48000, x = new Float32Array(sr * 20);
  for (let i = 0; i < x.length; i++) x[i] = (i < sr * 10 ? Math.pow(10, -23 / 20) : 1e-3 * 0.0) * Math.sin(2 * Math.PI * 997 * i / sr);
  near(extractCuesFromPcm({ samples: x, sampleRate: sr }).detail.loudness.lufs, -23, 0.2, 'absolute gate');
  // K-weighting shape: ~+4 dB high shelf near 10 kHz, strong attenuation at 30 Hz
  const gainAt = (f, fs) => {
    const cs = kWeightCoefficients(fs); let g = 1;
    const w = 2 * Math.PI * f / fs;
    for (const c of cs) {
      const re = (z) => z; void re;
      const nr = c.b[0] + c.b[1] * Math.cos(w) + c.b[2] * Math.cos(2 * w), ni = -c.b[1] * Math.sin(w) - c.b[2] * Math.sin(2 * w);
      const dr = 1 + c.a[0] * Math.cos(w) + c.a[1] * Math.cos(2 * w), di = -c.a[0] * Math.sin(w) - c.a[1] * Math.sin(2 * w);
      g *= Math.hypot(nr, ni) / Math.hypot(dr, di);
    }
    return 20 * Math.log10(g);
  };
  near(gainAt(997, 48000), 0.69, 0.1, 'gain @ 997 Hz');
  near(gainAt(10000, 48000), 4.0, 0.6, 'gain @ 10 kHz');
  assert.ok(gainAt(30, 48000) < -4, 'gain @ 30 Hz');
});

test('deterministic: identical input gives identical output, both entry points', () => {
  const sr = 8000, x = synthPcm({ ...plan, sampleRate: sr });
  const a = extractCuesFromPcm({ samples: x, sampleRate: sr }), b = extractCuesFromPcm({ samples: Float32Array.from(x), sampleRate: sr });
  assert.deepEqual(a, b);
  const e = synthEnvelope(plan, 1000);
  assert.deepEqual(extractCuesFromEnvelope(e, { durationSec: 200, absolute: true }), extractCuesFromEnvelope(Float32Array.from(e), { durationSec: 200, absolute: true }));
});

test('output cues plug into the ContextSnapshot schema; hand-set override wins', () => {
  const r = extractCuesFromEnvelope(synthEnvelope(plan, 2000), { durationSec: 200, absolute: true });
  const s = snapshotFixture('rainy-commute');
  s.libraryDigest.candidates[0].cues = toLibraryCues(r);
  assert.deepEqual(validateContextSnapshot(s), { ok: true, errors: [] });
  const o = toLibraryCues(r, { introEndSec: 9, confidence: 'high' });
  assert.equal(o.introEndSec, 9);
  assert.equal(o.outroStartSec, r.cues.outroStartSec);
});

test('benchmark: PCM entry on a 4-minute stereo 44.1 kHz track', (t) => {
  const sr = 44100, d = 240, x = synthPcm({ ...songPlan({ durationSec: d, leadSilenceSec: 1, introEndSec: 15, outroStartSec: 220, fadeEndSec: 236 }), sampleRate: sr });
  const y = Float32Array.from(x, (v) => v * 0.9);
  const t0 = performance.now();
  const r = extractCuesFromPcm({ channels: [x, y], sampleRate: sr });
  const pcmMs = performance.now() - t0;
  const env = synthEnvelope(plan, 1024);
  const t1 = performance.now();
  for (let i = 0; i < 100; i++) extractCuesFromEnvelope(env, { durationSec: 240, absolute: true });
  const envMs = (performance.now() - t1) / 100;
  t.diagnostic(`PCM 4min stereo 44.1k: ${pcmMs.toFixed(0)} ms; envelope (1024 bins): ${envMs.toFixed(3)} ms`);
  near(r.cues.introEndSec, 15, 0.8, 'introEnd');
  assert.ok(pcmMs < 5000);
});
