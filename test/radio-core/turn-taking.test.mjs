import test from 'node:test';
import assert from 'node:assert/strict';
import { createCall, step, replay, DEFAULTS } from '../../src/radio/core/turn-taking.js';
import { LATENCY_STAGES, budgetTotals, evaluateGate, percentile, BACKCHANNEL, MASK_STAGE_IDS, TARGETS } from '../../src/radio/core/latency.js';

const ev = (type, at, extra = {}) => ({ type, at, ...extra });
const types = (effects) => effects.map((e) => e.type);
const FD = { mode: 'full_duplex', autoMode: false };

// a greeting then the listener's first turn, leaving the call in SPEAKING (RJ answering)
function toSpeaking(cfg = FD) {
  return [
    ev('start', 0), ev('tts_audio_start', 800), ev('tts_done', 3000),
    ev('vad_onset', 4000), ev('vad_offset', 5000), ev('tick', 5300),
    ev('transcript_final', 5400, { text: 'hello there', confidence: 0.9 }),
    ev('llm_first_chunk', 5900), ev('tts_audio_start', 6200), ev('tts_progress', 6500, { spokenChars: 120 }),
  ];
}

test('happy path: greeting, listener turn, endpoint after hangover, measured latency', () => {
  const r = replay(FD, toSpeaking());
  assert.equal(r.state.phase, 'speaking');
  assert.deepEqual(r.state.turns.map((t) => t.latencyMs), [800, 1200]); // end of speech 5000 -> first audio 6200
  assert.ok(types(r.effects).includes('finalize_stt'));
  assert.deepEqual(r.effects.find((e) => e.type === 'start_llm' && e.text), { type: 'start_llm', text: 'hello there' });
  const ended = r.log.find((l) => l.event.at === 5300);
  assert.deepEqual(ended.trace, ['listening', 'thinking']);
});

test('endpointing: speech resuming inside the hangover cancels the endpoint', () => {
  const r = replay(FD, [ev('start', 0), ev('tts_audio_start', 100), ev('tts_done', 200), ev('vad_onset', 1000), ev('vad_offset', 2000),
    ev('tick', 2200), ev('vad_onset', 2250), ev('vad_offset', 2900), ev('tick', 3100)]);
  assert.equal(r.state.phase, 'listening');
  const r2 = replay(FD, [...r.log.map((l) => l.event), ev('tick', 3200)]);
  assert.equal(r2.state.phase, 'thinking');
  assert.equal(r2.state.endOfSpeechAt, 2900);
});

test('barge-in: duck at onset, cancel TTS and LLM after 300 ms of speech, record chars spoken', () => {
  const r = replay(FD, [...toSpeaking(), ev('vad_onset', 7000), ev('tick', 7200), ev('tick', 7300)]);
  const duck = r.log.find((l) => l.event.at === 7000);
  assert.deepEqual(duck.effects, [{ type: 'duck_voice', db: -18, ms: 80 }]);
  const cut = r.log.find((l) => l.event.at === 7300);
  assert.deepEqual(types(cut.effects), ['cancel_tts', 'cancel_llm', 'record_interrupt', 'mic']);
  assert.deepEqual(cut.effects[2], { type: 'record_interrupt', spokenChars: 120 });
  assert.deepEqual(cut.trace, ['speaking', 'interrupted', 'listening']);
  assert.equal(r.state.phase, 'listening');
  assert.equal(r.state.speech.active, true);
  assert.equal(r.state.speech.onsetAt, 7000);
  assert.equal(r.state.turns.at(-1).interrupted, true);
});

test('barge-in: a cough (short speech) restores the voice and the RJ keeps talking', () => {
  const r = replay(FD, [...toSpeaking(), ev('vad_onset', 7000), ev('vad_offset', 7150), ev('tick', 7500)]);
  assert.equal(r.state.phase, 'speaking');
  assert.ok(types(r.effects).includes('restore_voice'));
  assert.ok(!types(r.effects).includes('cancel_tts'));
  // speech that ends after the confirm window, with no tick in between, still counts as a barge-in
  const r2 = replay(FD, [...toSpeaking(), ev('vad_onset', 7000), ev('vad_offset', 7400)]);
  assert.equal(r2.state.phase, 'listening');
});

test('half-duplex: mic is closed while the RJ speaks, so VAD cannot barge in', () => {
  const r = replay({ mode: 'half_duplex', autoMode: false }, [...toSpeaking(), ev('vad_onset', 7000), ev('tick', 7400)]);
  assert.equal(r.state.phase, 'speaking');
  assert.ok(!types(r.effects).includes('duck_voice'));
  assert.deepEqual(r.effects.filter((e) => e.type === 'mic').slice(-1), [{ type: 'mic', open: false }]);
});

test('push-to-talk: VAD is ignored, release ends the turn at once, pressing over the RJ cuts in', () => {
  const cfg = { mode: 'push_to_talk', autoMode: false };
  const r = replay(cfg, [ev('start', 0), ev('tts_audio_start', 100), ev('tts_done', 200), ev('vad_onset', 300), ev('tick', 900),
    ev('ptt_down', 1000), ev('ptt_up', 2000)]);
  assert.equal(r.state.phase, 'thinking');
  assert.equal(r.state.endOfSpeechAt, 2000);
  assert.deepEqual(r.log[3].effects, []); // vad_onset ignored
  const barge = replay(cfg, [ev('start', 0), ev('tts_audio_start', 100), ev('ptt_down', 500)]);
  assert.equal(barge.state.phase, 'listening');
  assert.ok(types(barge.effects).includes('cancel_tts'));
  assert.equal(barge.state.speech.active, true);
});

test('route changes pick the mode when autoMode is on', () => {
  let r = replay({ mode: 'push_to_talk' }, [ev('start', 0), ev('route_change', 10, { headphones: true })]);
  assert.equal(r.state.mode, 'full_duplex');
  assert.deepEqual(r.log[1].effects, [{ type: 'set_mode', mode: 'full_duplex' }]);
  r = replay({ mode: 'full_duplex' }, [ev('start', 0), ev('route_change', 10, { headphones: false })]);
  assert.equal(r.state.mode, 'push_to_talk');
  r = replay({ mode: 'push_to_talk', autoMode: false }, [ev('start', 0), ev('route_change', 10, { headphones: true })]);
  assert.equal(r.state.mode, 'push_to_talk');
});

test('STT garbage: ask to repeat once, then a graceful exit', () => {
  const base = [ev('start', 0), ev('tts_audio_start', 10), ev('tts_done', 20), ev('vad_onset', 100), ev('vad_offset', 600), ev('tick', 900)];
  let r = replay(FD, [...base, ev('transcript_final', 950, { text: '', confidence: 0.1 })]);
  assert.deepEqual(r.log.at(-1).effects, [{ type: 'say_canned', id: 'ask_repeat' }]);
  assert.equal(r.state.phase, 'speaking');
  r = replay(FD, [...base, ev('transcript_final', 950, { text: 'mmf', confidence: 0.2 }), ev('tts_audio_start', 1000), ev('tts_done', 1500),
    ev('vad_onset', 1600), ev('vad_offset', 2100), ev('tick', 2400), ev('transcript_final', 2450, { text: '', confidence: 0 }), ev('tts_done', 3000)]);
  assert.deepEqual(r.effects.filter((e) => e.type === 'say_canned').map((e) => e.id), ['ask_repeat', 'graceful_exit']);
  assert.equal(r.state.phase, 'ended');
  assert.equal(r.state.endReason, 'stt_garbage');
  // a clear transcript in between resets the strike
  const ok = replay(FD, [...base, ev('transcript_final', 950, { text: 'hi', confidence: 0.9 })]);
  assert.equal(ok.state.repeatsAsked, 0);
});

test('backchannel: once the first chunk is late (1.4 s), at most once per 3 turns, never if the chunk arrived', () => {
  const turn = (t0, n, chunkAt) => [ev('vad_onset', t0), ev('vad_offset', t0 + 500), ev('tick', t0 + 900),
    ev('transcript_final', t0 + 950, { text: `turn ${n}`, confidence: 0.9 }), ...(chunkAt ? [ev('llm_first_chunk', chunkAt)] : []),
    ev('tick', t0 + 500 + 1399), ev('tick', t0 + 500 + 1400), ev('tick', t0 + 500 + 1600),
    ev('tts_audio_start', t0 + 500 + 1700), ev('tts_done', t0 + 500 + 2500)];
  const boot = [ev('start', 0), ev('tts_audio_start', 10), ev('tts_done', 20)];
  const count = (evs) => replay(FD, evs).effects.filter((e) => e.type === 'play_backchannel').length;
  assert.equal(count([...boot, ...turn(1000, 1)]), 1);
  assert.equal(replay(FD, [...boot, ...turn(1000, 1)]).log.find((l) => l.effects.some((e) => e.type === 'play_backchannel')).event.at, 1000 + 500 + 1400);
  assert.equal(count([...boot, ...turn(1000, 1, 1900)]), 0); // chunk arrived at +1400-? before threshold
  assert.equal(count([...boot, ...turn(1000, 1), ...turn(10000, 2), ...turn(20000, 3)]), 1); // cooldown: turns 2 and 3 are masked-free
  assert.equal(count([...boot, ...turn(1000, 1), ...turn(10000, 2), ...turn(20000, 3), ...turn(30000, 4)]), 2);
  assert.equal(BACKCHANNEL.afterMs, DEFAULTS.backchannelAfterMs);
});

test('limits: forced endpoint at the max listener turn, wrap-up at 80% of the call, hard end at the cap', () => {
  let r = replay(FD, [ev('start', 0), ev('tts_audio_start', 10), ev('tts_done', 20), ev('vad_onset', 100), ev('tick', 40099)]);
  assert.equal(r.state.phase, 'listening');
  r = replay(FD, [...r.log.map((l) => l.event), ev('tick', 40100)]);
  assert.equal(r.state.phase, 'thinking');
  assert.deepEqual(r.effects.find((e) => e.type === 'finalize_stt'), { type: 'finalize_stt', forced: true });
  const c = replay(FD, [ev('start', 0), ev('tts_audio_start', 10), ev('tts_done', 20), ev('tick', 143999), ev('tick', 144000), ev('tick', 150000), ev('tick', 180000)]);
  assert.equal(c.effects.filter((e) => e.type === 'wrap_up_line').length, 1);
  assert.equal(c.log[4].effects.some((e) => e.type === 'wrap_up_line'), true);
  assert.equal(c.state.phase, 'ended');
  assert.equal(c.state.endReason, 'max_duration');
});

test('call drops, mic denied, hang-up and take-back all land in defined states', () => {
  let r = replay(FD, [ev('start', 0), ev('tts_audio_start', 10), ev('connection_lost', 500)]);
  assert.deepEqual(types(r.log.at(-1).effects), ['cancel_tts', 'cancel_llm', 'say_canned', 'end_call']);
  assert.equal(r.log.at(-1).effects[2].id, 'we_lost_you');
  assert.equal(r.state.endReason, 'dropped');
  assert.equal(replay(FD, [ev('start', 0), ev('mic_denied', 5)]).state.endReason, 'mic_denied');
  assert.equal(replay(FD, [ev('start', 0), ev('end', 5)]).state.endReason, 'hangup');
  // keeps talking before the RJ has started: take the turn back
  r = replay(FD, [ev('start', 0), ev('tts_audio_start', 10), ev('tts_done', 20), ev('vad_onset', 100), ev('vad_offset', 400), ev('tick', 700),
    ev('transcript_final', 750, { text: 'so', confidence: 0.9 }), ev('vad_onset', 900)]);
  assert.equal(r.state.phase, 'listening');
  assert.ok(types(r.log.at(-1).effects).includes('cancel_llm'));
});

test('safety: abuse gets one warning then ends the call; distress drops the bit', () => {
  const base = [ev('start', 0), ev('tts_audio_start', 10), ev('tts_done', 20)];
  const r = replay(FD, [...base, ev('safety', 30, { label: 'abuse' }), ev('safety', 40, { label: 'abuse' })]);
  assert.deepEqual(r.effects.filter((e) => e.type === 'say_canned').map((e) => e.id), ['abuse_warning']);
  assert.equal(r.state.endReason, 'abuse');
  assert.ok(types(replay(FD, [...base, ev('safety', 30, { label: 'distress' })]).effects).includes('drop_bit'));
});

test('state machine is deterministic, immutable, ignores events after the end, and never throws', () => {
  const evs = toSpeaking();
  assert.deepEqual(replay(FD, evs).state, replay(FD, evs).state);
  const s0 = createCall(FD);
  const frozen = JSON.stringify(s0);
  step(s0, ev('start', 1));
  assert.equal(JSON.stringify(s0), frozen);
  const ended = replay(FD, [ev('start', 0), ev('end', 1), ev('vad_onset', 2), ev('tts_done', 3)]);
  assert.equal(ended.state.phase, 'ended');
  for (const bad of [undefined, null, 5, {}, { type: 'nope' }, { type: 'vad_onset', at: 'x' }, { type: 'transcript_final' }]) {
    const r = step(createCall(FD), bad);
    assert.ok(r.state && Array.isArray(r.effects));
  }
  assert.equal(createCall({ mode: 'bogus' }).mode, 'push_to_talk');
});

// ── latency budget (corrected 8.3) ───────────────────────────────────────────

test('latency budget: column sums and the corrected thresholds', () => {
  assert.deepEqual(budgetTotals(), { p50: 1570, lo: 942, hi: 2830 });
  const mask = LATENCY_STAGES.filter((s) => MASK_STAGE_IDS.includes(s.id)).reduce((a, s) => a + s.p50, 0);
  assert.equal(mask, 1180);
  assert.ok(BACKCHANNEL.afterMs > mask, 'masking must not fire at the p50 sum');
  assert.ok(!(900 > mask), 'the old 900 ms threshold was below the p50 sum');
});

test('latency gate: p95 decides, p50 is reported, kill line is looser', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.ok(Number.isNaN(percentile([], 50)));
  const fast = Array.from({ length: 30 }, (_, i) => 1200 + i * 20); // p95 ~1.77 s
  assert.equal(evaluateGate(fast).pass, true);
  // p50 under 1.6 s but a fat tail: FAILS the gate
  const tail = [...Array.from({ length: 24 }, () => 1400), ...Array.from({ length: 6 }, () => 2900)];
  const g = evaluateGate(tail);
  assert.equal(g.p50Within, true);
  assert.equal(g.pass, false);
  assert.equal(g.kill, false);
  assert.equal(evaluateGate(Array.from({ length: 30 }, () => 3100)).kill, true);
  assert.equal(evaluateGate([]).pass, false);
  assert.deepEqual([TARGETS.p50Ms, TARGETS.p95Ms], [1600, 2500]);
});
