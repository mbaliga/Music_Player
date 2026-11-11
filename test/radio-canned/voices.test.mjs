import test from 'node:test';
import assert from 'node:assert/strict';
import { assignHostVoices, describeVoice, directionTweak, lineVoice, loadCannedVoicePrefs, saveCannedVoicePrefs } from '../../src/radio/canned/voices.js';
import { createSystemVoice, webSpeechBackend } from '../../src/radio/offline/voice.js';
import { STATION_IDS, loadPackFile } from '../support/canned-sim.mjs';
import { fakeTime, FakeSynth, FakeUtterance } from '../radio-offline/helpers.mjs';
import { MANY_VOICES } from './rig.mjs';

const toVoices = (list) => list.map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang, local: v.localService !== false }));
const lg = (a, b) => Math.abs(Math.log(a / b));

test('voices are described from their name and language; Android-style names stay "unknown" gender', () => {
  assert.deepEqual(describeVoice({ name: 'Samantha', lang: 'en-US' }), { gender: 'female', region: 'us', local: true, english: true });
  assert.equal(describeVoice({ name: 'Daniel', lang: 'en_GB' }).region, 'uk');
  assert.equal(describeVoice({ name: 'en-us-x-iom-local', lang: 'en-US' }).gender, 'unknown');
  assert.equal(describeVoice({ name: 'Amelie', lang: 'fr-FR' }).english, false);
  assert.doesNotThrow(() => describeVoice(null));
});

test('every host of every pack gets a rate/pitch inside the engine range and a voice from the device when one exists', () => {
  for (const id of STATION_IDS) {
    const pack = loadPackFile(id);
    for (const voices of [toVoices(MANY_VOICES), toVoices(MANY_VOICES.slice(0, 1)), []]) {
      const { byHost } = assignHostVoices(pack.hostList, voices, {});
      assert.deepEqual(Object.keys(byHost).sort(), pack.hostList.map((h) => h.id).sort());
      for (const a of Object.values(byHost)) {
        assert.ok(a.rate >= 0.6 && a.rate <= 1.6 && a.pitch >= 0.5 && a.pitch <= 1.6, JSON.stringify(a));
        if (voices.length) assert.ok(voices.some((v) => v.id === a.voiceId)); else assert.equal(a.voiceId, null);
      }
    }
  }
});

test('hosts are distinguishable: no two cast members end up with the same voice AND the same pitch/pace (0, 1, 2 and 5 voices)', () => {
  for (const id of STATION_IDS) {
    const pack = loadPackFile(id);
    for (const n of [0, 1, 2, 5]) {
      const voices = toVoices(MANY_VOICES.slice(0, n));
      const { byHost, distinct } = assignHostVoices(pack.hostList, voices, {});
      const list = Object.entries(byHost);
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const [ai, a] = list[i], [aj, b] = list[j];
        if (a.voiceId === b.voiceId) assert.ok(lg(a.pitch, b.pitch) >= 0.05 || lg(a.rate, b.rate) >= 0.04, `${id} (${n} voices): ${ai} and ${aj} sound alike: ${JSON.stringify([a, b])}`);
      }
      assert.equal(distinct, list.length, `${id} (${n} voices)`);
    }
  }
});

test('with several voices, the main hosts get different voices and accents are matched where the device has them', () => {
  const pirate = loadPackFile('pirate-1400');
  const { byHost } = assignHostVoices(pirate.hostList, toVoices(MANY_VOICES), {});
  assert.notEqual(byHost.ros.voiceId, byHost.barnaby.voiceId);
  assert.notEqual(byHost.barnaby.voiceId, byHost.grumm.voiceId);
  assert.equal(byHost.ros.voiceName, 'Moira', 'irish hint -> the en-IE voice');
  assert.equal(byHost.barnaby.voiceName, 'Daniel', 'neutral-UK male -> the en-GB male voice');
  assert.equal(byHost.gwen.voiceName, 'Karen', 'australian female -> the en-AU voice');
});

test('the owner\'s choice wins, a stale choice is ignored, and choices persist per station', () => {
  const pack = loadPackFile('tape-hiss-fm');
  const voices = toVoices(MANY_VOICES);
  assert.equal(assignHostVoices(pack.hostList, voices, { wren: 'alex' }).byHost.wren.voiceId, 'alex');
  assert.notEqual(assignHostVoices(pack.hostList, voices, { wren: 'gone' }).byHost.wren.voiceId, 'gone');
  const store = new Map(); const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(saveCannedVoicePrefs(storage, 'tape-hiss-fm', { wren: 'alex' }), true);
  assert.equal(saveCannedVoicePrefs(storage, 'pirate-1400', { ros: 'karen' }), true);
  assert.deepEqual(loadCannedVoicePrefs(storage), { 'tape-hiss-fm': { wren: 'alex' }, 'pirate-1400': { ros: 'karen' } });
  assert.deepEqual(loadCannedVoicePrefs({ getItem() { throw new Error('x'); } }), {});
  assert.equal(saveCannedVoicePrefs({ getItem: () => 'garbage', setItem() { throw new Error('full'); } }, 'x', {}), false);
});

test('junk host lists and voice lists never throw', () => {
  for (const hl of [null, undefined, [], [null, {}, { id: 'a' }, { id: 'b', voice: 5 }]]) for (const vs of [null, [null, {}, { id: 'v' }]]) {
    assert.doesNotThrow(() => assignHostVoices(hl, vs, null));
  }
});

test('direction words tweak a line by a small, bounded amount', () => {
  assert.deepEqual(directionTweak(''), { rate: 0, pitch: 0 });
  assert.ok(directionTweak('whispered, close-mic').rate < 0);
  assert.ok(directionTweak('huge, gleeful, a proclamation').pitch > 0);
  for (const d of ['whisper gleeful deadpan fast slow queasy', 'x'.repeat(500), null, 5]) { const t = directionTweak(d); assert.ok(Math.abs(t.rate) <= 0.1 && Math.abs(t.pitch) <= 0.08); }
  const l = lineVoice({ voiceId: 'v', rate: 1.2, pitch: 1.3 }, 'gleeful, loud');
  assert.ok(l.rate <= 1.6 && l.pitch <= 1.6 && l.voiceId === 'v');
  assert.equal(lineVoice(null, '').rate, 1);
});

test('the speech adapter honours a per-line override (voice, rate, pitch) and leaves the two-host path alone', async () => {
  const time = fakeTime();
  const synth = new FakeSynth(time, { voices: MANY_VOICES });
  const voice = createSystemVoice({ backends: [webSpeechBackend({ synth, Utterance: FakeUtterance, timers: time.timers })], timers: time.timers, now: time.now });
  await voice.init();
  const prep = { id: 'x', speaker: 'a', chunks: [{ text: 'Hello there', pauseAfterMs: 0 }], params: { rate: 1, pitchMul: 1 } };
  const p1 = voice.speak({ ...prep, override: { voiceId: 'karen', rate: 1.17, pitch: 0.83 } });
  await time.advance(3000); await p1;
  const p2 = voice.speak({ ...prep });
  await time.advance(3000); await p2;
  const p3 = voice.speak({ ...prep, override: { voiceId: null, rate: 9, pitch: 0.1 } });
  await time.advance(3000); await p3;
  assert.deepEqual(synth.spoken.map((s) => [s.voice, s.rate, s.pitch]), [['Karen', 1.17, 0.83], ['Samantha', 1, 1], [undefined, 1.6, 0.5]]);
});
