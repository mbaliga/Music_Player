// Regression tests for the station-picker review fixes: no network TTS voices, linear-time text cleaning, slot sanitising,
// idempotent fallback start, and station-id / file-name checks in the build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignHostVoices } from '../../src/radio/canned/voices.js';
import { createSystemVoice, webSpeechBackend, prepareUtterance } from '../../src/radio/offline/voice.js';
import { createAuditioner } from '../../src/radio/canned/audition.js';
import { cleanTitle, cleanArtist, cleanAlbum, speakable } from '../../src/radio/offline/pronounce.js';
import { cleanSlotValue, isLatinText } from '../../src/radio/canned/slots.js';
import { validatePackDoc, isStationId } from '../../src/radio/canned/pack.js';
import { validStationId } from '../../src/radio/canned/session.js';
import { createFallbackController } from '../../src/radio/canned/fallback.js';
import { createFakeNet } from '../../src/radio/canned/net.js';
import { buildWeb } from '../../scripts/build-web.mjs';
import { packFileError } from '../../scripts/stations-index.mjs';
import { loadPackFile } from '../support/canned-sim.mjs';
import { fakeTime, FakeSynth, FakeUtterance } from '../radio-offline/helpers.mjs';
import { rig } from './rig.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MIN = 60 * 1000;
const CLOUD = { name: 'Google UK English Female', lang: 'en-GB', voiceURI: 'g-uk-f', localService: false, default: false };
const LOCAL_US = { name: 'Alex', lang: 'en-US', voiceURI: 'alex', localService: true, default: true };
const LOCAL_AU = { name: 'Karen', lang: 'en-AU', voiceURI: 'karen', localService: true, default: false };
const toVoices = (list) => list.map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang, local: v.localService !== false }));

// ── 1. no network voices ─────────────────────────────────────────────────────

test('assignHostVoices never gives a network voice to anyone, even when region and gender would favour it', () => {
  const pack = loadPackFile('meridian-91-5');
  const hostList = pack.hostList.map((h) => ({ ...h, voice: { ...h.voice, genderHint: 'female', accent: 'neutral-uk' } }));
  const { byHost } = assignHostVoices(hostList, toVoices([CLOUD, LOCAL_US, LOCAL_AU]), {});
  for (const a of Object.values(byHost)) assert.notEqual(a.voiceId, 'g-uk-f');
  // an owner pref that points at a network voice is ignored too
  const r = assignHostVoices(hostList, toVoices([CLOUD, LOCAL_US]), { [hostList[0].id]: 'g-uk-f' });
  assert.equal(r.byHost[hostList[0].id].voiceId, 'alex');
  // network voices only: nobody gets one (the adapter then refuses to speak)
  for (const a of Object.values(assignHostVoices(hostList, toVoices([CLOUD]), {}).byHost)) assert.equal(a.voiceId, null);
});

test('system voice: speak() never uses a network voice (host path, override path, stale override), the list hides them', async () => {
  const time = fakeTime();
  const synth = new FakeSynth(time, { voices: [CLOUD, LOCAL_US, LOCAL_AU] });
  const voice = createSystemVoice({ backends: [webSpeechBackend({ synth, Utterance: FakeUtterance, timers: time.timers })], timers: time.timers, now: time.now, prefs: { a: 'g-uk-f', b: 'g-uk-f' } });
  await voice.init();
  assert.equal(voice.available, true);
  assert.deepEqual(voice.allVoices().map((v) => v.id).sort(), ['alex', 'karen']);
  assert.equal(voice.diag.networkVoicesSkipped, 1);
  assert.notEqual(voice.hosts().a, 'g-uk-f');
  voice.setHost('b', 'g-uk-f'); // refused
  assert.notEqual(voice.hosts().b, 'g-uk-f');
  const prep = { id: 'x', speaker: 'a', chunks: [{ text: 'Hello there', pauseAfterMs: 0 }], params: { rate: 1, pitchMul: 1 } };
  for (const override of [undefined, { voiceId: 'g-uk-f', rate: 1, pitch: 1 }, { voiceId: null, rate: 1, pitch: 1 }]) {
    const p = voice.speak({ ...prep, override });
    await time.advance(3000); await p;
  }
  assert.equal(synth.spoken.length, 3);
  for (const s of synth.spoken) assert.ok(s.voice === 'Alex' || s.voice === 'Karen', `spoke with ${s.voice}`); // never undefined (engine default) and never the network voice
});

test('system voice: when every voice is a network voice, speech is unavailable with a specific reason and speak() is never called on the engine', async () => {
  const time = fakeTime();
  const synth = new FakeSynth(time, { voices: [CLOUD] });
  const voice = createSystemVoice({ backends: [webSpeechBackend({ synth, Utterance: FakeUtterance, timers: time.timers })], timers: time.timers, now: time.now });
  await voice.init();
  assert.equal(voice.available, false);
  assert.equal(voice.unavailableReason, 'no_local_voice');
  const r = await voice.speak({ id: 'x', speaker: 'a', chunks: [{ text: 'Hi', pauseAfterMs: 0 }], params: { rate: 1, pitchMul: 1 } });
  assert.deepEqual([r.ok, r.reason], [false, 'no_local_voice']);
  assert.equal(synth.spoken.length, 0);
  // a device that reports NO voices at all keeps the engine-default behaviour (nothing to filter)
  const synth0 = new FakeSynth(time, { voices: [] });
  const v0 = createSystemVoice({ backends: [webSpeechBackend({ synth: synth0, Utterance: FakeUtterance, timers: time.timers })], timers: time.timers, now: time.now, timeouts: { startMs: 2200, stallNoBoundaryMs: 4000, endSlackMs: 2000, endFactor: 1.6, voicesWaitMs: 0 } });
  await v0.init();
  assert.equal(v0.available, true);
});

test('canned show on a device with a cloud voice: the cloud voice is never spoken with; with only cloud voices the show is music only', async () => {
  const r = await rig({ id: 'meridian-91-5', voices: [CLOUD, LOCAL_US, LOCAL_AU] });
  r.runner.start();
  await r.time.advance(12 * MIN, 250);
  assert.ok(r.synth.spoken.length >= 4);
  assert.ok(r.synth.spoken.every((s) => s.voice === 'Alex' || s.voice === 'Karen'), JSON.stringify([...new Set(r.synth.spoken.map((s) => s.voice))]));
  r.runner.stop();

  const only = await rig({ id: 'meridian-91-5', voices: [CLOUD] });
  only.runner.start();
  await only.time.advance(12 * MIN, 250);
  assert.equal(only.synth.spoken.length, 0);
  assert.equal(only.runner.state.speech, 'off');
  assert.equal(only.voice.unavailableReason, 'no_local_voice');
  only.runner.stop();
});

test('dial audition: network voices are not used; with only network voices it says "no offline voice" and speaks nothing', async () => {
  const time = fakeTime();
  const mk = (voices) => {
    const synth = new FakeSynth(time, { voices });
    return { synth, aud: createAuditioner({ win: { speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance }, timers: time.timers }) };
  };
  const host = { id: 'h', name: 'H', rate: 1, pitch: 1, pauseHabit: '300 ms', mood: 'warm' };
  const a = mk([CLOUD]);
  assert.deepEqual(await a.aud.audition(host), { ok: false, spoken: 0, reason: 'no offline voice' });
  assert.equal(a.synth.spoken.length, 0);
  const b = mk([CLOUD, LOCAL_US]);
  const p = b.aud.audition(host);
  await time.advance(120000, 250);
  await p;
  assert.ok(b.synth.spoken.length > 0 && b.synth.spoken.every((s) => s.voice === 'Alex'));
});

// ── 2. ReDoS ─────────────────────────────────────────────────────────────────

const adversarial = (n) => ({
  brackets: '[a '.repeat(n / 3), parens: '(x'.repeat(n / 2), spaces: ' '.repeat(n) + 'a', digits: '1'.repeat(n), spacedDigits: '1 '.repeat(n / 2),
  trailingSpaces: 'a' + ' '.repeat(n) + 'x', decimals: '1.1'.repeat(n / 3), years: '1990'.repeat(n / 4), caps: 'Ab II '.repeat(n / 6), commas: ',;'.repeat(n / 2),
});
const timed = (f) => { const t = performance.now(); f(); return performance.now() - t; };

test('text cleaners and slot cleaning are linear on 200 KB adversarial library strings (budget 50 ms each)', () => {
  for (const [name, text] of Object.entries(adversarial(200000))) {
    for (const [fn, f] of [['cleanTitle', cleanTitle], ['cleanArtist', cleanArtist], ['cleanAlbum', cleanAlbum], ['cleanSlotValue', (x) => cleanSlotValue('prevTitle', x)], ['isLatinText', (x) => isLatinText(x.slice(0, 1000))]]) {
      const ms = timed(() => f(text));
      assert.ok(ms < 50, `${fn}(${name}) took ${ms.toFixed(0)} ms`);
    }
  }
});

test('speakable and the pack validator are linear on adversarial text (quadratic before; budget is generous)', () => {
  for (const [name, text] of Object.entries(adversarial(100000))) {
    const ms = timed(() => speakable(text));
    assert.ok(ms < 400, `speakable(${name}) took ${ms.toFixed(0)} ms`);
    const doc = JSON.parse(JSON.stringify({ v: 1, station: { id: 'a', hosts: [] }, segments: [{ id: 's', kind: 'liner', hosts: ['h'], lines: [{ host: 'h', text }], usesSlots: [], estSec: 1, tags: [], weight: 1 }] }));
    const v = timed(() => validatePackDoc(doc));
    assert.ok(v < 100, `validatePackDoc(${name}) took ${v.toFixed(0)} ms`);
  }
  assert.ok(timed(() => prepareUtterance({ id: 'u', text: '1'.repeat(100000) })) < 400);
});

test('the cleaners still clean ordinary titles after the rewrite (junk tags removed, meaningful brackets kept)', () => {
  assert.equal(cleanTitle('01 - Harbor_Lights [Remastered 2011].mp3'), 'Harbor Lights');
  assert.equal(cleanTitle('Paper Moon (Live) (Official Video)'), 'Paper Moon (Live)');
  assert.equal(cleanTitle('x'.repeat(300)), null);
  assert.equal(speakable('It is 3% at 4:52pm in 1999'), 'It is three percent at four fifty-two p m in nineteen ninety-nine');
});

// ── 3. slot sanitising ───────────────────────────────────────────────────────

test('slot values: bidi/zero-width/format chars and emoji are stripped; accented Latin names are kept; symbols-only and non-Latin are refused', () => {
  assert.equal(cleanSlotValue('nextTitle', 'Moon‮river'), 'Moonriver');
  assert.equal(cleanSlotValue('nextTitle', 'Pa​per⁠ Moon‍'), 'Paper Moon');
  assert.equal(cleanSlotValue('nextTitle', '﻿Midnight \u{1F319} Drive'), 'Midnight Drive');
  assert.equal(cleanSlotValue('nextTitle', 'Night Shift\u0085'), 'Night Shift');
  for (const [slot, name] of [['nextArtist', 'Ø'], ['nextArtist', 'Æon'], ['nextArtist', 'Ñu'], ['album', 'Éé'], ['nextTitle', 'Ångström'], ['prevArtist', 'Sigur Rós']]) assert.equal(cleanSlotValue(slot, name), name, name);
  for (const bad of ['???', '\u{1F319}\u{1F319}', '‮', '1999', '夜に駆ける', 'Дождь']) assert.equal(cleanSlotValue('nextTitle', bad), null, bad);
});

// ── 4. fallback start idempotent ─────────────────────────────────────────────

test('fallback controller: a second start() neither orphans the first session nor registers a second net subscription', async () => {
  const log = [];
  let subs = 0, unsubs = 0;
  const base = createFakeNet(true);
  const net = { ...base, isOnline: () => base.isOnline(), onChange: (f) => { subs++; const off = base.onChange(f); return () => { unsubs++; off(); }; } };
  const mk = (name) => () => { let st = {}; return { onChange() {}, get state() { return st; }, async start() { log.push(`${name}:start`); }, stop() { log.push(`${name}:stop`); } }; };
  const fc = createFallbackController({ station: { id: 'x', kind: 'style' }, flagOn: true, cloudAvailable: true, net, factories: { cloud: mk('cloud'), canned: mk('canned') } });
  await fc.start();
  await fc.start();
  assert.equal(fc.source, 'cloud');
  assert.deepEqual(log, ['cloud:start']);
  assert.equal(subs, 1);
  fc.stop();
  assert.deepEqual(log, ['cloud:start', 'cloud:stop']);
  assert.equal(unsubs, 1);
  await fc.start(); // a restart after stop still works
  assert.deepEqual(log, ['cloud:start', 'cloud:stop', 'cloud:start']);
  fc.stop();
});

// ── 5. station id / file name ────────────────────────────────────────────────

test('station ids: URL-safe rule is shared with the session loader; the validator and the file-name check reject bad packs', async () => {
  for (const id of ['meridian-91-5', 'a', '9-lives', '../evil', 'Evil', 'a/b', 'a.b', '', '-x', 'x'.repeat(62), null]) assert.equal(isStationId(id), validStationId(id), String(id));
  const doc = JSON.parse(await readFile(resolve(root, 'content/stations/meridian-91-5.json'), 'utf8'));
  assert.deepEqual(validatePackDoc(doc).errors, []);
  assert.equal(packFileError('meridian-91-5.json', doc), null);
  assert.match(packFileError('other.json', doc), /does not match the file name/);
  assert.match(packFileError('meridian-91-5.json', { ...doc, station: { ...doc.station, id: '../evil' } }), /not URL-safe/);
  const bad = { ...doc, station: { ...doc.station, id: '../evil' } };
  assert.ok(validatePackDoc(bad).errors.some((e) => /URL-safe/.test(e.msg)));
});

test('build: a pack whose station.id is not URL-safe, or does not match its file name, fails the build', async () => {
  const tmp = await mkdtemp(resolve(tmpdir(), 'runout-ids-'));
  try {
    const doc = JSON.parse(await readFile(resolve(root, 'content/stations/meridian-91-5.json'), 'utf8'));
    const cases = [['mismatch', 'meridian-91-5.json', { ...doc, station: { ...doc.station, id: 'meridian-91-6' } }, /does not match the file name/],
      ['unsafe', 'evil.json', { ...doc, station: { ...doc.station, id: '../evil' } }, /not URL-safe/]];
    for (const [name, file, d, re] of cases) {
      const sd = resolve(tmp, name); await mkdir(sd, { recursive: true });
      await writeFile(resolve(sd, file), JSON.stringify(d));
      await assert.rejects(buildWeb({ outDir: resolve(tmp, `out-${name}`), buildId: 't', quiet: true, stationsDir: sd, audioDir: resolve(tmp, 'none') }), re, name);
    }
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
