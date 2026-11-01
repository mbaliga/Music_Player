import test from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock, BufferMic, runTurn, stagesFromMarks, createChunker, provenanceFor, MARKS } from '../lib/pipeline.mjs';
import { makeFakeAdapters, defaultFakeConfig } from '../lib/adapters-fake.mjs';
import { utterance } from '../lib/synth.mjs';
import { EnergyVad } from '../lib/vad.mjs';
import { RealSttStub, RealWriterStub, RealTtsStub, NotConfiguredError, NotImplementedError, realAdapterAvailability } from '../lib/adapters-real.mjs';
import { simulate } from '../scripts/run-fake-pipeline.mjs';
import { STAGES } from '../lib/budget.mjs';

test('stagesFromMarks: differences between consecutive marks; missing mark -> NaN', () => {
  const m = {}; MARKS.forEach((k, i) => { m[k] = i * 10; });
  const s = stagesFromMarks(m);
  assert.ok(Object.values(s).every((v) => v === 10));
  delete m.tts_first_byte;
  const s2 = stagesFromMarks(m);
  assert.ok(Number.isNaN(s2.tts_ttfb)); assert.ok(Number.isNaN(s2.downlink)); assert.equal(s2.output, 10);
});

test('chunker: first clause after minChars, ignores early comma, flush returns remainder', () => {
  const c = createChunker({ minChars: 12 });
  assert.equal(c.push('Hey, '), null);          // comma at index 3 < minChars
  assert.equal(c.push('you are '), null);
  assert.equal(c.push('on the air. '), 'Hey, you are on the air.');
  assert.equal(c.push('Next'), null);
  assert.equal(c.flush(), 'Next');
  assert.equal(c.flush(), null);
});

test('VAD: endpoint latency = hangover (+ <= 1 frame), speech end estimate within one frame of truth', () => {
  const sr = 16000, u = utterance(sr, { speechMs: 1000 });
  for (const hang of [200, 300, 500]) {
    const vad = new EnergyVad({ sampleRate: sr, hangoverMs: hang });
    const evs = []; for (let i = 0; i + 320 <= u.samples.length; i += 320) evs.push(...vad.push(u.samples.subarray(i, i + 320)));
    const start = evs.find((e) => e.type === 'speech_start'), end = evs.find((e) => e.type === 'speech_end');
    assert.ok(start && end, `events for hangover ${hang}`);
    assert.ok(Math.abs(end.speechEndMs - u.truth.speechEndMs) <= 60, `speechEnd est ${end.speechEndMs} vs ${u.truth.speechEndMs}`);
    const lat = end.atMs - u.truth.speechEndMs;
    assert.ok(lat >= hang - 60 && lat <= hang + 80, `latency ${lat} for hangover ${hang}`);
  }
});

test('VAD: pure noise never triggers', () => {
  const sr = 16000, u = utterance(sr, { speechMs: 0 + 1 }); // ~silence (1 ms of speech)
  const vad = new EnergyVad({ sampleRate: sr });
  const evs = []; for (let i = 0; i + 320 <= u.samples.length; i += 320) evs.push(...vad.push(u.samples.subarray(i, i + 320)));
  assert.equal(evs.length, 0);
});

test('pipeline on virtual clock: zero-delay adapters give ~hangover only; marks monotonic', async () => {
  const sr = 16000, u = utterance(sr, {});
  const cfg = defaultFakeConfig({ stt_final: 0, uplink: 0, llm_ttft: 0, first_chunk: 0, tts_ttfb: 0, downlink: 0, output: 0 });
  const a = makeFakeAdapters(new BufferMic(u.samples, sr), cfg);
  const r = await runTurn({ adapters: a, clock: new VirtualClock(), sampleRate: sr, truthSpeechEndMs: u.truth.speechEndMs });
  assert.ok(!r.error, r.error);
  const ts = MARKS.map((k) => r.marks[k]);
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] >= ts[i - 1], `${MARKS[i]} >= ${MARKS[i - 1]}`);
  assert.ok(r.stages.vad_endpoint >= 280 && r.stages.vad_endpoint <= 400);
  for (const k of ['stt_final', 'uplink', 'llm_ttft', 'first_chunk', 'tts_ttfb', 'downlink', 'output']) assert.ok(Math.abs(r.stages[k]) < 1e-6, k);
  assert.equal(r.firstChunk, 'Hey, you are on the air.');
});

test('pipeline: configured delays show up in the matching stage (no jitter)', async () => {
  const sr = 16000, u = utterance(sr, {});
  const cfg = defaultFakeConfig({ sigma: 0, stt_final: 111, uplink: 22, llm_ttft: 333, first_chunk: 150, tts_ttfb: 77, downlink: 66, output: 15 });
  const a = makeFakeAdapters(new BufferMic(u.samples, sr), cfg);
  const r = await runTurn({ adapters: a, clock: new VirtualClock(), sampleRate: sr, truthSpeechEndMs: u.truth.speechEndMs });
  const s = r.stages;
  assert.equal(Math.round(s.stt_final), 111); assert.equal(Math.round(s.uplink), 22); assert.equal(Math.round(s.llm_ttft), 333);
  assert.equal(Math.round(s.first_chunk), 150); assert.equal(Math.round(s.tts_ttfb), 77);
  assert.equal(Math.round(s.downlink), 66); assert.equal(Math.round(s.output), 15);
});

test('pipeline: no speech -> error, not a hang', async () => {
  const sr = 16000, u = utterance(sr, { speechMs: 1 });
  const a = makeFakeAdapters(new BufferMic(u.samples, sr), defaultFakeConfig());
  const r = await runTurn({ adapters: a, clock: new VirtualClock(), sampleRate: sr });
  assert.equal(r.error, 'no endpoint detected');
});

test('simulate(): deterministic for a given seed; provenance flags fake stages', async () => {
  const a = await simulate({ turns: 5 }), b = await simulate({ turns: 5 });
  assert.deepEqual(a.total, b.total);
  assert.equal(a.allStagesMeasured, false);
  assert.equal(a.rows.find((x) => x.id === 'vad_endpoint').provenance, 'measured');
  assert.equal(a.rows.find((x) => x.id === 'llm_ttft').provenance, 'configured-fake');
});

test('simulate(): heavy tails fail p95 even though medians sit at budget (why p95 is the gate)', async () => {
  const r = await simulate({ turns: 40, scenario: 'tail' });
  assert.equal(r.verdicts.docP95, false);
});

test('provenanceFor maps adapter kinds', () => {
  const p = provenanceFor({ stt: { kind: 'real' }, writer: { kind: 'fake' }, playback: {} });
  assert.equal(p.stt_final, 'measured'); assert.equal(p.llm_ttft, 'configured-fake'); assert.equal(p.output, 'reported');
  assert.deepEqual(Object.keys(p), STAGES.map((s) => s.id));
});

test('real adapter stubs: refuse without env key; with key they still throw NotImplemented; never return keys', async () => {
  assert.throws(() => new RealSttStub({}), NotConfiguredError);
  assert.throws(() => new RealWriterStub({}), NotConfiguredError);
  assert.throws(() => new RealTtsStub({}), NotConfiguredError);
  const env = { RUNOUT_SPIKE_STT_KEY: 'x', RUNOUT_SPIKE_LLM_KEY: 'y', RUNOUT_SPIKE_TTS_KEY: 'z' };
  await assert.rejects(new RealSttStub(env).finalize(), NotImplementedError);
  await assert.rejects(new RealTtsStub(env).synthesize(), NotImplementedError);
  await assert.rejects(new RealWriterStub(env).stream().next(), NotImplementedError);
  assert.deepEqual(realAdapterAvailability(env), { stt: true, llm: true, tts: true });
  assert.deepEqual(realAdapterAvailability({}), { stt: false, llm: false, tts: false });
});
