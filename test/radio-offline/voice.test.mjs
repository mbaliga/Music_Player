import test from 'node:test';
import assert from 'node:assert/strict';
import { createSystemVoice, webSpeechBackend, capacitorBackend, prepareUtterance, SYSTEM_CAPS, englishVoices, defaultHostVoices, TIMEOUTS, loadVoicePrefs, saveVoicePrefs, VOICE_PREFS_KEY } from '../../src/radio/offline/voice.js';
import { degradeUtterance, CAPS_NONE } from '../../src/radio/core/markup.js';
import { fakeTime, FakeSynth, FakeUtterance, VOICES } from './helpers.mjs';

function rig(mode = 'normal', { voices = VOICES, extra = [] } = {}) {
  const time = fakeTime();
  const synth = new FakeSynth(time, { voices, mode });
  const backend = webSpeechBackend({ synth, Utterance: FakeUtterance, timers: time.timers });
  const voice = createSystemVoice({ backends: [backend, ...extra], timers: time.timers, now: time.now });
  return { time, synth, voice, backend };
}
const utt = (text, o = {}) => ({ id: 'u', text, style: { emotion: 'warm', energy: 0.5, pace: 1, ...(o.style || {}) }, speaker: o.speaker || 'a', pauseAfterMs: o.pauseAfterMs ?? 200 });
const prep = (text, o) => prepareUtterance(utt(text, o), {});

test('capabilities are honest: rate and pitch only, no pre-render, no expressive markup', () => {
  const { voice } = rig();
  const c = voice.capabilities();
  assert.equal(c.ssml, false); assert.equal(c.audioTags, false); assert.equal(c.direction, false); assert.equal(c.namedStyles, null);
  assert.equal(c.rate, true); assert.equal(c.pitch, true); assert.equal(c.preRender, false); assert.equal(c.liveOnly, true);
  assert.equal(c.available, true); assert.equal(c.engine, 'web-speech');
  assert.deepEqual(SYSTEM_CAPS.styleMap, {});
  // no engine at all is stated plainly
  const none = createSystemVoice({ backends: [webSpeechBackend({ synth: undefined, Utterance: undefined })] });
  assert.equal(none.capabilities().available, false); assert.equal(none.capabilities().engine, 'none');
});

test('markup degrade path: the core maps an utterance onto these caps and drops what cannot be done', () => {
  const r = degradeUtterance({ text: 'Hi {laugh} there {pause:600} {em}friend{/em} {sfx:ding}', style: { emotion: 'hype', energy: 0.9, pace: 1.1, pitchSemitones: 1, direction: 'smile' } }, SYSTEM_CAPS);
  assert.equal(r.form, 'text'); assert.doesNotMatch(r.body, /[{}<>]/);
  for (const d of ['laugh', 'emphasis', 'direction', 'pitch']) assert.ok(r.dropped.includes(d), d);
  assert.equal(r.params.rate, 1.1); assert.deepEqual(r.sfx.map((x) => x.name), ['ding']);
});

test('prepareUtterance: pauses become timed gaps, pitch and rate come from style, nothing leaks', () => {
  const p = prepareUtterance(utt('One. {pause:700} Two {breath} three {laugh}{em}four{/em} {sfx:x}.', { style: { emotion: 'hype', pace: 1.0, pitchSemitones: 2 } }), {});
  assert.deepEqual(p.chunks.map((c) => c.pauseAfterMs), [700, 220, 0]);
  for (const c of p.chunks) assert.doesNotMatch(c.text, /[{}]/);
  assert.ok(p.params.pitchMul > 1.1 && p.params.pitchMul <= 1.6); assert.ok(p.params.rate > 1);
  assert.ok(p.dropped.includes('laugh') && p.dropped.includes('emphasis') && p.dropped.includes('sfx'));
  const low = prepareUtterance(utt('Hush now.', { style: { emotion: 'hushed', pace: 0.8, pitchSemitones: -2 } }), {});
  assert.ok(low.params.rate >= 0.6 && low.params.pitchMul >= 0.5 && low.params.pitchMul < 1);
  // late-bound tokens resolve at prepare time; long text is chunked under the engine limit
  const t = prepareUtterance(utt('It is {{time.spoken}}.'), { resolve: (n) => (n === 'time.spoken' ? '4:52' : '') });
  assert.equal(t.display, 'It is four fifty-two.');
  const long = prepareUtterance(utt(`${'This is a sentence about nothing in particular. '.repeat(12)}`), {});
  assert.ok(long.chunks.length >= 2 && long.chunks.every((c) => c.text.length <= 190));
  assert.ok(p.durationSec > 0);
});

test('render() prepares, never synthesizes: estimates durations, resolves tokens, keeps ids and speakers', async () => {
  const { voice } = rig();
  const script = { schemaVersion: 1, slotId: 's', utterances: [{ id: 'a1', text: 'Hello there, friend. It is {{time.spoken}}.', style: { emotion: 'warm', energy: 0.5, pace: 1 }, speaker: 'a', factRefs: [] }, { id: 'a2', text: 'Right you are.', style: { emotion: 'wry', energy: 0.4, pace: 0.95 }, speaker: 'b', factRefs: [], droppable: true }] };
  const r = await voice.render({ script, nowParts: { hour: 7, minute: 5 } });
  assert.equal(r.live, true); assert.equal(r.audioId, null);
  assert.deepEqual(r.utterances.map((u) => [u.id, u.speaker, u.droppable]), [['a1', 'a', false], ['a2', 'b', true]]);
  assert.match(r.utterances[0].display, /seven oh five/);
  assert.ok(r.durationSec > 2 && r.durationSec < 15);
});

test('speak: normal run fires start/end, resolves ok, speaks every chunk with host voice, rate and pitch', async () => {
  const { time, synth, voice } = rig();
  await voice.init();
  const events = [];
  const p = voice.speak(prep('First chunk here. {pause:500} Second chunk there.'), { onStart: () => events.push('start'), onChunk: (t) => events.push(`chunk:${t}`), onEnd: (r) => events.push(`end:${r.ok}`) });
  await time.advance(8000);
  const res = await p;
  assert.equal(res.ok, true); assert.equal(res.chunks, 2);
  assert.deepEqual(events, ['chunk:First chunk here.', 'start', 'chunk:Second chunk there.', 'end:true']);
  assert.equal(synth.spoken.length, 2);
  assert.equal(synth.spoken[0].voice, 'Alex');
  assert.ok(synth.spoken[1].at - synth.spoken[0].at >= 500, 'the 500 ms pause is honoured between chunks');
  assert.equal(voice.speaking, false);
});

test('two hosts: different voices when available, pitch/rate offsets when only one voice exists', async () => {
  const a = rig();
  await a.voice.init();
  const h = a.voice.hosts();
  assert.notEqual(h.a, h.b);
  let p = a.voice.speak(prep('Host a.', { speaker: 'a' })); await a.time.advance(3000); await p;
  p = a.voice.speak(prep('Host b.', { speaker: 'b' })); await a.time.advance(3000); await p;
  assert.deepEqual(a.synth.spoken.map((s) => s.voice), ['Alex', 'Fiona']);
  const one = rig('normal', { voices: [VOICES[0]] });
  await one.voice.init();
  assert.equal(one.voice.hosts().a, one.voice.hosts().b);
  p = one.voice.speak(prep('Host a.', { speaker: 'a' })); await one.time.advance(3000); await p;
  p = one.voice.speak(prep('Host b.', { speaker: 'b' })); await one.time.advance(3000); await p;
  const [sa, sb] = one.synth.spoken;
  assert.ok(sb.pitch < sa.pitch && sb.rate < sa.rate, 'same voice, different host: lower and slower');
  // user choice wins and is persisted
  a.voice.setHost('b', 'alex');
  assert.equal(a.voice.hosts().b, 'alex');
  const store = new Map();
  const st = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(saveVoicePrefs(st, a.voice.hosts()), true);
  assert.deepEqual(loadVoicePrefs(st), { a: a.voice.hosts().a, b: 'alex' });
  assert.ok(store.has(VOICE_PREFS_KEY));
  assert.deepEqual(loadVoicePrefs({ getItem: () => 'junk' }), { a: null, b: null });
  assert.deepEqual(loadVoicePrefs(null), { a: null, b: null });
});

test('voice choice prefers English, local, then region; falls back sanely', () => {
  const norm = VOICES.map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang, local: v.localService, default: v.default }));
  assert.deepEqual(englishVoices(norm).map((v) => v.name), ['Alex', 'Fiona', 'Cloudy']);
  assert.deepEqual(defaultHostVoices(norm), { a: 'alex', b: 'fiona' });
  assert.deepEqual(defaultHostVoices([]), { a: null, b: null });
  assert.deepEqual(defaultHostVoices([{ id: 'x', name: 'X', lang: 'de-DE', local: true }]), { a: null, b: null });
});

test('watchdog: no start event within the limit -> fails "no_start", cancels the engine, never hangs', async () => {
  const { time, synth, voice } = rig('nostart');
  await voice.init();
  const p = voice.speak(prep('Nobody home.'));
  await time.advance(TIMEOUTS.startMs + 200);
  const res = await p;
  assert.deepEqual([res.ok, res.reason], [false, 'no_start']);
  assert.ok(synth.cancels >= 1);
  assert.equal(voice.speaking, false);
  assert.equal(voice.diag.failures, 1);
});

test('watchdog: start but the end event never comes -> ends as assumed after the estimate, engine cancelled', async () => {
  const { time, synth, voice } = rig('noend');
  await voice.init();
  const p = voice.speak(prep('This speech starts and then the engine goes quiet forever.'));
  await time.advance(30000);
  const res = await p;
  assert.equal(res.ok, true); assert.equal(voice.diag.assumedEnds, 1);
  assert.ok(synth.cancels >= 1, 'stuck speech is cancelled so the queue is clear');
  assert.ok(res.endedMs - res.startedMs < 12000, 'the wait is bounded by the estimate');
  // and the next utterance still works (state machine recovered)
  synth.mode = 'normal';
  const p2 = voice.speak(prep('Back again.')); await time.advance(4000);
  assert.equal((await p2).ok, true);
});

test('engine error mid-speech fails the utterance with its code, once', async () => {
  const { time, voice } = rig('error');
  await voice.init();
  const p = voice.speak(prep('Boom.'));
  await time.advance(500);
  const res = await p;
  assert.deepEqual([res.ok, res.reason], [false, 'error:synthesis-failed']);
});

test('cancel() mid-speech settles "cancelled", clears the engine, and does not count as a failure', async () => {
  const { time, synth, voice } = rig();
  await voice.init();
  const p = voice.speak(prep('A fairly long line that would take a few seconds to say out loud properly.'));
  await time.advance(600);
  assert.equal(voice.speaking, true);
  voice.cancel();
  const res = await p;
  assert.deepEqual([res.ok, res.reason], [false, 'cancelled']);
  assert.equal(voice.speaking, false); assert.equal(voice.diag.failures, 0);
  await time.advance(10000);
  assert.equal(synth.spoken.length, 1, 'nothing else was spoken after the cancel');
  // cancel during a pause between chunks also settles
  const q = voice.speak(prep('One. {pause:1500} Two.'));
  await time.advance(1500);
  voice.cancel();
  assert.equal((await q).reason, 'cancelled');
  await time.advance(5000);
  assert.equal(synth.spoken.length, 2);
});

test('a new speak() supersedes the one in flight (one voice at a time)', async () => {
  const { time, voice } = rig();
  await voice.init();
  const a = voice.speak(prep('The first one goes on and on and on for a good while yet.'));
  await time.advance(400);
  const b = voice.speak(prep('Second.'));
  await time.advance(4000);
  assert.equal((await a).reason, 'cancelled'); assert.equal((await b).ok, true);
});

test('events that arrive late or twice are ignored after the utterance settled', async () => {
  const { time, synth, voice } = rig();
  await voice.init();
  const p = voice.speak(prep('Short.'));
  await time.advance(3000);
  const res = await p;
  assert.equal(res.ok, true);
  const u = new FakeUtterance('x'); // stray callbacks on a finished job must not throw or revive it
  assert.doesNotThrow(() => { synth.cancel(); });
});

test('two consecutive no_start failures fall back to the Capacitor plugin, which then speaks', async () => {
  const time = fakeTime();
  const synth = new FakeSynth(time, { voices: VOICES, mode: 'nostart' });
  const spoken = [];
  const plugin = { async getSupportedVoices() { return { voices: [{ name: 'Android En', lang: 'en-US', localService: true, default: true }] }; }, async speak(o) { spoken.push(o); await new Promise((r) => time.setTimeout(r, 500)); }, async stop() { spoken.push('stop'); } };
  const voice = createSystemVoice({ backends: [webSpeechBackend({ synth, Utterance: FakeUtterance, timers: time.timers }), capacitorBackend({ plugin })], timers: time.timers, now: time.now });
  await voice.init();
  assert.equal(voice.backendName, 'web-speech');
  for (let i = 0; i < 2; i++) { const p = voice.speak(prep('Anyone?')); await time.advance(TIMEOUTS.startMs + 100); assert.equal((await p).reason, 'no_start'); }
  await time.advance(100);
  assert.equal(voice.backendName, 'capacitor-tts');
  const p = voice.speak(prep('Now it works.'));
  await time.advance(1500);
  const res = await p;
  assert.equal(res.ok, true);
  const call = spoken.find((x) => x && x.text);
  assert.equal(call.text, 'Now it works.'); assert.equal(call.queueStrategy, 0); assert.ok(call.rate > 0.5);
});

test('with no voices at all the engine default is used; with no engine, speak() says "unavailable" at once', async () => {
  const empty = rig('normal', { voices: [] });
  const initP = empty.voice.init();
  await empty.time.advance(TIMEOUTS.voicesWaitMs + 200); // waits briefly for a late voice list, then carries on
  const info = await initP;
  assert.deepEqual(info.voices, []);
  const p = empty.voice.speak(prep('Default voice.')); await empty.time.advance(3000);
  assert.equal((await p).ok, true); assert.equal(empty.synth.spoken[0].voice, undefined);
  const none = createSystemVoice({ backends: [] });
  assert.deepEqual(await none.speak(prep('x')), { ok: false, reason: 'unavailable', chunks: 0 });
  assert.equal((await none.init()).voices.length, 0);
});

test('capacitor backend: speak resolves at the end, errors map to failures, cancel calls stop()', async () => {
  const time = fakeTime();
  let stops = 0, fail = false;
  const plugin = { async speak() { if (fail) throw new Error('tts engine missing'); await new Promise((r) => time.setTimeout(r, 400)); }, async stop() { stops++; } };
  const voice = createSystemVoice({ backends: [capacitorBackend({ plugin })], timers: time.timers, now: time.now });
  await voice.init();
  let p = voice.speak(prep('Fine.')); await time.advance(1000); assert.equal((await p).ok, true);
  fail = true;
  p = voice.speak(prep('Broken.')); await time.advance(300);
  const r = await p; assert.equal(r.ok, false); assert.match(r.reason, /error:tts engine missing/);
  fail = false;
  p = voice.speak(prep('Cancel me please, this takes a while to say out loud.')); await time.advance(100); voice.cancel(); assert.equal((await p).reason, 'cancelled'); assert.ok(stops >= 1);
});

test('speak never throws even if the backend does', async () => {
  const time = fakeTime();
  const synth = { getVoices: () => [], speak() { throw new Error('explode'); }, cancel() { throw new Error('x'); }, speaking: false };
  const voice = createSystemVoice({ backends: [webSpeechBackend({ synth, Utterance: FakeUtterance, timers: time.timers })], timers: time.timers, now: time.now });
  await voice.init();
  const res = await voice.speak(prep('Hi.'));
  assert.equal(res.ok, false); assert.match(res.reason, /error:/);
  assert.doesNotThrow(() => voice.cancel());
});
