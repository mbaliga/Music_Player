// Architecture 10.2 failure matrix, one test per row. Rows that live in the call state machine
// or the clock are exercised directly; the rest run a whole simulated show with the failure injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSimulatedShow, makeFakeAdapters } from '../../src/radio/core/sim.js';
import { verifyScript } from '../../src/radio/core/grounding.js';
import { findDeadAir } from '../../src/radio/core/scheduler.js';
import { replay } from '../../src/radio/core/turn-taking.js';
import { ShowClock } from '../../src/radio/core/show-clock.js';
import { repairRundown, rundownProblems } from '../../src/radio/core/director-client.js';
import { FakeDirector, FakeContext, FakeVoice, FakeWriter, createVirtualClock, AdapterError, TTS_STALL_MS } from '../../src/radio/core/fake-adapters.js';
import { snapshotFixture, goldenRundown, makeLibrary, FIXTURE_NOW_MS } from '../../src/radio/core/fixtures.js';

const LIB_IDS = new Set(makeLibrary(20).map((t) => t.trackId));
const SHOW = 1500;
const run = (adapters, o = {}) => runSimulatedShow({ adapters, durationSec: SHOW, ...o });
const noDeadAir = (r) => { assert.deepEqual(r.deadAir, []); assert.ok(r.endSec >= SHOW); };
const verifiedAll = (r) => { for (const a of r.aired) assert.deepEqual(verifyScript(a.script, a.snapshot, { atMs: a.airAtMs }).problems, [], a.slotId); };
const voiceCount = (r) => r.segments.filter((s) => s.kind === 'voice').length;
const noErrorLeak = (r) => assert.doesNotMatch(JSON.stringify(r.aired.map((a) => a.script)), /error|offline|timeout|429|refusal|exception/i);

test('10.2 offline / backend down -> music only, offline badge, never silence', async () => {
  const a = makeFakeAdapters();
  for (const k of ['context', 'director', 'writer', 'voice']) a[k].injectAlways('offline');
  const r = await run(a);
  noDeadAir(r);
  assert.equal(voiceCount(r), 0);
  assert.equal(r.badge, 'offline_music_only');
  assert.ok(r.errors.some((e) => e.stage === 'director' && e.code === 'offline'));
  const songs = r.segments.filter((s) => s.kind === 'song').map((s) => s.trackId);
  assert.ok(songs.length >= 5);
  assert.equal(new Set(songs).size, songs.length);
  assert.ok(songs.every((id) => LIB_IDS.has(id)));
  noErrorLeak(r);
});

test('10.2 LLM refusal / timeout / invalid JSON -> retry once, else drop the slot, never an error on air', async () => {
  let a = makeFakeAdapters(); a.writer.inject('refusal', 1);
  let r = await run(a);
  noDeadAir(r); verifiedAll(r);
  assert.equal(r.regenerations, 1);
  assert.deepEqual(r.dropped, []);
  a = makeFakeAdapters(); a.writer.inject('invalid_json', 2);
  r = await run(a); noDeadAir(r); verifiedAll(r);
  assert.ok(r.errors.some((e) => e.code === 'invalid_json'));
  assert.equal(r.regenerations, 1);
  assert.equal(r.dropped.length, 1);             // first slot: both attempts invalid -> dropped
  a = makeFakeAdapters(); a.writer.injectAlways('timeout');
  r = await run(a); noDeadAir(r); noErrorLeak(r);
  assert.ok(r.dropped.length >= 3);
  assert.ok(r.dropped.every((d) => d.why === 'writer_failed'));
  assert.equal(voiceCount(r), 0);
});

test('10.2 hallucinated track id -> hint ignored, selector picks from the library', async () => {
  const a = makeFakeAdapters(); a.director.injectAlways('bad_hints');
  const r = await run(a);
  noDeadAir(r);
  assert.ok(r.repairs.filter((x) => x.code === 'drop_unknown_hint').length >= 3);
  const songs = r.segments.filter((s) => s.kind === 'song').map((s) => s.trackId);
  assert.ok(songs.every((id) => LIB_IDS.has(id)));
  assert.equal(new Set(songs).size, songs.length);
});

test('10.2 verifier rejects a claim -> regenerate once, else canned link', async () => {
  let a = makeFakeAdapters(); a.writer.inject('hallucinate', 1);
  let r = await run(a); noDeadAir(r); verifiedAll(r);
  assert.equal(r.regenerations, 1); assert.equal(r.canned.length, 0);
  assert.ok(r.aired.every((x) => x.source === 'writer'));
  a = makeFakeAdapters(); a.writer.inject('unreferenced_claim', 1); a.writer.inject('hallucinate', 1);
  r = await run(a); noDeadAir(r); verifiedAll(r);
  assert.equal(r.canned.length, 1);
  assert.equal(r.aired.filter((x) => x.source === 'canned').length, 1);
  a = makeFakeAdapters(); a.writer.inject('pii', 2);
  r = await run(a); verifiedAll(r); assert.equal(r.canned.length, 1);
});

test('10.2 TTS slow / stall (no first byte in 2.5 s) -> drop the slot', async () => {
  const a = makeFakeAdapters(); a.voice.inject('tts_stall', 3);
  const r = await run(a);
  noDeadAir(r); verifiedAll(r);
  assert.ok(r.dropped.length >= 1 && r.dropped.every((d) => d.why === 'tts_stall'));
  assert.ok(r.errors.every((e) => e.stage === 'voice' || e.code !== 'x'));
  const clock = createVirtualClock(0);
  const v = new FakeVoice({ clock, delayMs: 100 }).inject('tts_stall');
  await assert.rejects(v.render({ script: { slotId: 's', utterances: [{ id: 'u', text: 'hi', style: { emotion: 'warm', energy: 0.5, pace: 1 } }] } }), (e) => e.code === 'tts_stall');
  assert.equal(clock.now(), 100 + TTS_STALL_MS);
});

test('10.2 talk longer than the intro window -> trim droppable, pre-roll, or move between songs', async () => {
  const a = makeFakeAdapters();
  a.voice.wordsPerSec = 0.9; // a very slow host: every break overruns its window
  const r = await run(a);
  noDeadAir(r);
  const notes = r.notes.map((n) => n.note).join('|');
  assert.match(notes, /trimmed|pre_roll|between_songs/);
  assert.ok(r.segments.filter((s) => s.mode === 'over_intro' && s.attachedTo).every((v) => {
    const song = r.segments.find((s) => s.segmentId === v.attachedTo);
    return v.startSec + v.durationSec <= song.startSec + 25;
  }));
});

test('10.2 stale air-time facts -> the writer is never handed a fact that will have expired', async () => {
  const a = makeFakeAdapters();
  a.context.ttlSec = 120; // facts expire long before the slot airs
  const r = await run(a);
  noDeadAir(r); verifiedAll(r);
  assert.ok(r.aired.length > 0);
  const refs = r.aired.flatMap((x) => x.script.utterances.flatMap((u) => u.factRefs));
  assert.ok(!refs.includes('wx.now') && !refs.includes('wx.next6h'));
  assert.ok(r.aired.every((x) => x.script.utterances.every((u) => u.expiresAt === null)));
});

test('10.2 quota / spend ceiling (429) -> one in-character "on a break", then music only', async () => {
  const a = makeFakeAdapters();
  a.director.injectAlways('http_429'); a.writer.injectAlways('http_429');
  const r = await run(a);
  noDeadAir(r); verifiedAll(r);
  assert.equal(r.aired.filter((x) => x.source === 'break').length, 1);
  assert.match(r.aired[0].script.utterances[0].text, /short break/);
  assert.ok(r.errors.some((e) => e.code === 'http_429'));
  assert.ok(r.segments.filter((s) => s.kind === 'song').length >= 5);
  noErrorLeak(r);
});

test('10.2 memory pressure / decode failure -> stay on the current deck, keep going', async () => {
  const a = makeFakeAdapters(); a.decoder.inject('oom', 3);
  const r = await run(a);
  noDeadAir(r);
  assert.equal(r.decodeFailures.length, 3);
  assert.ok(r.fallbacks.some((f) => f.kind === 'any_decoded_track' || f.kind === 'local_filler'));
  assert.ok(r.replays.length + r.fallbacks.filter((f) => f.kind === 'local_filler').length >= 3);
});

test('10.2 background suspension -> the clock re-flows on resume and flags what is overdue', () => {
  const snap = snapshotFixture();
  const c = new ShowClock().append(repairRundown(goldenRundown(), { snapshot: snap, atMs: FIXTURE_NOW_MS }).rundown.slots);
  for (const s of ['select', 'script', 'tts', 'decode']) c.markDone('g5', s);
  c.begin('g1', 0); c.complete('g1', 6);
  c.begin('g2', 6);
  // WebView frozen: g2 only reports done 40 s late; later slots slide, tasks that should have run are overdue
  c.complete('g2', 233);
  assert.equal(c.get('g4').start, 233);
  const late = c.overdue(470);
  assert.ok(late.some((x) => x.slotId === 'g6' && x.stage === 'decode'));
  assert.ok(!late.some((x) => x.slotId === 'g5'));
});

test('10.2 call rows: mic denied, no AEC / headphones unplugged, STT garbage, call drops mid-turn', () => {
  const E = (type, at, x = {}) => ({ type, at, ...x });
  assert.equal(replay({}, [E('start', 0), E('mic_denied', 1)]).state.endReason, 'mic_denied');
  const route = replay({ mode: 'full_duplex' }, [E('start', 0), E('route_change', 5, { headphones: false })]);
  assert.equal(route.state.mode, 'push_to_talk');
  const garbage = replay({ mode: 'full_duplex', autoMode: false }, [E('start', 0), E('tts_audio_start', 1), E('tts_done', 2), E('vad_onset', 3), E('vad_offset', 400), E('tick', 800), E('transcript_final', 850, { text: '', confidence: 0 })]);
  assert.deepEqual(garbage.log.at(-1).effects, [{ type: 'say_canned', id: 'ask_repeat' }]);
  const drop = replay({ mode: 'full_duplex' }, [E('start', 0), E('tts_audio_start', 1), E('connection_lost', 50)]);
  assert.ok(drop.effects.some((e) => e.type === 'say_canned' && e.id === 'we_lost_you'));
  assert.equal(drop.state.phase, 'ended');
});

test('golden rundown properties hold for every Director failure mode after repair', async () => {
  for (const scenario of ['rainy-commute', 'weather-down', 'no-location']) {
    for (const fault of [null, 'bad_hints', 'adjacent_talk', 'bad_first', 'wrong_horizon']) {
      const clock = createVirtualClock(FIXTURE_NOW_MS);
      const ctx = new FakeContext({ clock, scenario });
      const dir = new FakeDirector({ clock });
      if (fault) dir.inject(fault);
      const snapshot = await ctx.getSnapshot({ nowMs: FIXTURE_NOW_MS });
      const raw = await dir.plan({ snapshot, wantSlots: 8 });
      const r = repairRundown(raw, { snapshot, atMs: FIXTURE_NOW_MS });
      assert.equal(r.ok, true, `${scenario}/${fault}`);
      assert.deepEqual(rundownProblems(r.rundown, snapshot), [], `${scenario}/${fault}`);
    }
  }
  const garbage = new FakeDirector({ clock: createVirtualClock() }).inject('garbage');
  const r = repairRundown(await garbage.plan({ snapshot: snapshotFixture() }), { snapshot: snapshotFixture() });
  assert.equal(r.ok, false);
});

test('fake adapters: configurable delays, failure injection and call logs', async () => {
  const clock = createVirtualClock(1000);
  const w = new FakeWriter({ clock, delayMs: { base: 500, jitter: 100, seed: 3 } });
  const slot = { slotId: 's', kind: 'talk_break', targetSec: 20, talk: { budgetSec: 12 } };
  await w.write({ slot }); await w.write({ slot });
  assert.ok(w.calls.every((c) => c.ms >= 400 && c.ms <= 600));
  assert.equal(clock.now(), 1000 + w.calls[0].ms + w.calls[1].ms);
  const f = new FakeWriter({ clock, delayMs: (i) => 100 * (i + 1) });
  await f.write({ slot }); await f.write({ slot });
  assert.deepEqual(f.calls.map((c) => c.ms), [100, 200]);
  f.inject('refusal', 1);
  await assert.rejects(f.write({ slot }), (e) => e instanceof AdapterError && e.code === 'refusal');
  assert.ok((await f.write({ slot })).utterances.length > 0);
  assert.deepEqual(f.calls.map((c) => c.fault), [null, null, 'refusal', null]);
  f.injectAlways('offline');
  await assert.rejects(f.write({ slot }), /offline/);
  f.clearFaults();
  assert.ok(await f.write({ slot }));
});
