import test from 'node:test';
import assert from 'node:assert/strict';
import { rig, MANY_VOICES } from './rig.mjs';
import { fakeLibrary } from '../radio-offline/helpers.mjs';
import { findDeadAir } from '../../src/radio/core/scheduler.js';
import { MAX_AUDIO_FAILS } from '../../src/radio/canned/runner.js';
import { wordCount } from '../../src/radio/canned/pack.js';

const MIN = 60 * 1000;
const hostNames = (pack) => new Set(pack.hostList.map((h) => h.name));
const gainDips = (param) => param.calls.filter((c) => c[0] === 'ramp');

test('a canned show: sign-on first, captions carry the speaking person\'s name, music keeps playing gaplessly underneath', async () => {
  const r = await rig({ id: 'meridian-91-5' });
  r.runner.start();
  assert.equal(r.runner.phase, 'starting');
  await r.time.advance(18 * MIN, 250);
  assert.equal(r.runner.phase, 'playing');
  const a = r.runner.aired;
  assert.equal(a[0].kind, 'sign_on');
  assert.ok(a.length >= 4, `${a.length} breaks in 18 min`);
  assert.ok(a.every((x) => x.source === 'tts'));
  const caps = r.events.filter((e) => e.type === 'caption');
  assert.ok(caps.length >= 8);
  const names = hostNames(r.pack);
  for (const c of caps) { assert.ok(names.has(c.name), c.name); assert.ok(c.text.length > 2); assert.doesNotMatch(c.text, /\{\w+\}/); }
  // everything that was spoken was captioned first
  assert.ok(r.synth.spoken.length >= caps.length);
  // gapless: first song cold, the rest joined with the next deck prepared in advance
  assert.equal(r.runner.diag.colds, 1);
  assert.ok(r.runner.diag.joins >= 3);
  const ev = r.player.ev.map((e) => e[0]);
  assert.ok(ev.includes('prepareNext') && ev.includes('join'));
  assert.deepEqual(findDeadAir(r.player.played.map((p) => ({ startSec: p.startSec, durationSec: p.endSec - p.startSec })), { fromSec: r.player.played[0].startSec, toSec: r.time.now() / 1000 - 5 }), []);
  r.runner.stop(); await r.time.advance(1000);
});

test('each cast member speaks in their own voice: several distinct voice/rate/pitch combinations in one pirate show', async () => {
  const r = await rig({ id: 'pirate-1400' });
  r.runner.start();
  await r.time.advance(25 * MIN, 250);
  const speakers = new Set(r.events.filter((e) => e.type === 'caption').map((e) => e.speaker));
  assert.ok(speakers.size >= 4, [...speakers].join());
  const combos = new Set(r.synth.spoken.map((s) => `${s.voice}|${s.rate.toFixed(2)}|${s.pitch.toFixed(2)}`));
  assert.ok(combos.size >= 6, `${combos.size} voice combos`);
  const usedVoices = new Set(r.synth.spoken.map((s) => s.voice));
  assert.ok(usedVoices.size >= 3, [...usedVoices].join());
  r.runner.stop(); await r.time.advance(1000);
});

test('ducking: the music bus goes down for every break and is back to unity afterwards', async () => {
  const r = await rig({ id: 'static-city-98-1' });
  r.runner.start();
  await r.time.advance(12 * MIN, 250);
  const ramps = gainDips(r.param);
  const downs = ramps.filter((c) => c[1] < 0.5), ups = ramps.filter((c) => c[1] === 1);
  assert.ok(downs.length >= 3, `${downs.length} duck-downs`);
  assert.ok(Math.abs(downs[0][1] - 0.1995) < 0.01);
  assert.ok(ups.length >= downs.length - 1);
  await r.time.advance(2 * MIN, 250);
  r.runner.stop(); await r.time.advance(1000);
  assert.equal(r.duck.holdCount, 0);
  assert.ok(Math.abs(r.duck.gainNow() - 1) < 0.01, `gain ${r.duck.gainNow()}`);
});

test('skip cancels the speech in progress and joins the next song; nothing stays ducked', async () => {
  const r = await rig({ id: 'tape-hiss-fm' });
  r.runner.start();
  await r.time.advance(20 * 1000, 100);
  assert.equal(r.runner.aired[0].kind, 'sign_on');
  const cancels = r.synth.cancels;
  const before = r.runner.current.track.title;
  r.runner.skip();
  await r.time.advance(4000, 100);
  assert.ok(r.synth.cancels > cancels);
  assert.notEqual(r.runner.current.track.title, before);
  assert.equal(r.runner.diag.skips, 1);
  await r.time.advance(3000, 100);
  assert.ok(Math.abs(r.duck.gainAt(r.time.now() / 1000 + 1) - 1) < 0.01);
  r.runner.stop(); await r.time.advance(1000);
});

test('stop: speech cancelled, music restored, the deck halted, phase idle', async () => {
  const r = await rig({ id: 'sunbelt-soul-1060' });
  r.runner.start();
  await r.time.advance(5000, 100);
  r.runner.stop();
  await r.time.advance(1500, 100);
  assert.equal(r.runner.phase, 'idle');
  assert.ok(r.player.ev.some((e) => e[0] === 'halt'));
  assert.equal(r.duck.holdCount, 0);
  const n = r.synth.spoken.length;
  await r.time.advance(2 * MIN, 250);
  assert.equal(r.synth.spoken.length, n, 'nothing speaks after stop');
});

test('sign-off: Stop airs the station\'s sign-off, then stops; a second Stop stops at once', async () => {
  const r = await rig({ id: 'kilo-hertz-rock-102-7' });
  r.runner.start();
  await r.time.advance(6 * MIN, 250);
  r.runner.signOff();
  await r.time.advance(500, 50);
  assert.equal(r.events.some((e) => e.type === 'signing-off'), true);
  assert.equal(r.runner.phase, 'playing', 'still on air while it signs off');
  await r.time.advance(40 * 1000, 100);
  assert.equal(r.runner.aired.at(-1).kind, 'sign_off');
  assert.equal(r.runner.phase, 'idle');
  const r2 = await rig({ id: 'kilo-hertz-rock-102-7' });
  r2.runner.start(); await r2.time.advance(6 * MIN, 250);
  r2.runner.signOff(); await r2.time.advance(200, 50);
  r2.runner.signOff(); await r2.time.advance(300, 50);
  assert.equal(r2.runner.phase, 'idle');
  assert.ok(r2.synth.cancels >= 1, 'the sign-off speech was cut');
});

test('an empty library gets a friendly message and no show', async () => {
  const r = await rig({ tracks: [] });
  r.runner.start();
  await r.time.advance(2000, 100);
  assert.equal(r.runner.phase, 'empty');
  assert.match(r.runner.state.error.message, /no playable songs/i);
  assert.equal(r.synth.spoken.length, 0);
  const only = await rig({ tracks: fakeLibrary(3).map((t) => ({ ...t, file: undefined, relink: true })) });
  only.runner.start(); await only.time.advance(1000, 100);
  assert.equal(only.runner.phase, 'empty');
});

test('speech that keeps failing: that segment is skipped, three in a row switch the talk off with a visible note, the music plays on', async () => {
  const r = await rig({ id: 'pirate-1400', mode: 'error' });
  r.runner.start();
  await r.time.advance(14 * MIN, 250);
  assert.equal(r.runner.phase, 'playing');
  assert.equal(r.runner.state.speech, 'off');
  const note = r.events.find((e) => e.type === 'notice');
  assert.ok(note && /Music only/i.test(note.text), JSON.stringify(note));
  assert.equal(r.events.filter((e) => e.type === 'caption').length, 0, 'a failed line is never captioned as if it was heard');
  assert.ok(r.runner.diag.joins >= 2, 'the music kept going');
  const after = r.runner.aired.length;
  await r.time.advance(10 * MIN, 250);
  assert.equal(r.runner.aired.length, after, 'no more breaks are attempted');
  r.runner.stop(); await r.time.advance(1000);
});

test('no speech engine and no recordings: music only from the start, said plainly', async () => {
  const r = await rig({ id: 'meridian-91-5', noSynth: true });
  r.runner.start();
  await r.time.advance(8 * MIN, 250);
  assert.equal(r.runner.phase, 'playing');
  assert.equal(r.runner.state.speech, 'off');
  assert.equal(r.runner.state.speechAvailable, false);
  assert.equal(r.runner.aired.length, 0);
  assert.ok(r.runner.diag.joins >= 1);
  r.runner.stop(); await r.time.advance(1000);
});

test('a song that will not decode is skipped silently; five in a row stop the show with a plain message', async () => {
  const lib = fakeLibrary(12);
  const r = await rig({ tracks: lib, failLoad: new Set([lib[0].id, lib[1].id, lib[2].id]), id: 'tape-hiss-fm' });
  // whichever songs are picked first, failing ones are skipped; use ALL failing for the stop case below
  r.runner.start();
  await r.time.advance(5 * MIN, 250);
  assert.equal(r.runner.phase, 'playing');
  r.runner.stop(); await r.time.advance(1000);
  const all = fakeLibrary(8);
  const dead = await rig({ tracks: all, failLoad: new Set(all.map((t) => t.id)), id: 'tape-hiss-fm' });
  dead.runner.start();
  await dead.time.advance(20 * 1000, 100);
  assert.equal(dead.runner.phase, 'error');
  assert.match(dead.runner.state.error.message, /songs could be opened/i);
  assert.equal(dead.duck.holdCount, 0);
});

test('slots: good tags are read in the host\'s sentence; non-Latin and cruft titles use the slot-free twin', async () => {
  const good = fakeLibrary(14);
  const r = await rig({ id: 'static-city-98-1', tracks: good, seed: 3 });
  r.runner.start(); await r.time.advance(3 * 60 * MIN, 500);
  const filled = r.runner.aired.filter((a) => a.variant === 'slots');
  assert.ok(filled.length >= 1, 'a slot line aired');
  for (const f of filled) assert.ok(f.lines.some((l) => /Song \w+ \d+|Mara Quill|Velvet|Low Tide|June Parlor|Static Orchard|Album [A-D]/.test(l.text)), f.segment);
  r.runner.stop(); await r.time.advance(1000);
  const odd = fakeLibrary(14).map((t, i) => ({ ...t, title: i % 2 ? '夜に駆ける' : 'Track 0' + i, artist: 'Unknown Artist', album: 'Unknown Album' }));
  const s = await rig({ id: 'static-city-98-1', tracks: odd, seed: 3 });
  s.runner.start(); await s.time.advance(3 * 60 * MIN, 500);
  assert.ok(s.runner.aired.length > 10);
  assert.equal(s.runner.aired.filter((a) => a.variant === 'slots').length, 0);
  for (const a of s.runner.aired) for (const l of a.lines) assert.doesNotMatch(l.text, /\{\w+\}/);
  s.runner.stop(); await s.time.advance(1000);
});

test('going to the background cancels speech and drops breaks; the music keeps playing', async () => {
  const r = await rig({ id: 'tape-hiss-fm' });
  r.runner.start(); await r.time.advance(10 * 1000, 100);
  r.runner.setBackground(true);
  const n = r.runner.aired.length;
  await r.time.advance(8 * MIN, 250);
  assert.equal(r.runner.aired.length, n);
  assert.equal(r.runner.phase, 'playing');
  assert.ok(r.runner.diag.joins >= 1);
  r.runner.setBackground(false);
  r.runner.stop(); await r.time.advance(1000);
});

// ── voice source selection through the whole runner ──────────────────────────
function entriesFor(pack, { skip = new Set() } = {}) {
  const m = new Map();
  for (const u of pack.units) for (const s of [u.seg, ...u.twins]) if (!s.usesSlots.length && !skip.has(s.id)) m.set(s.id, { id: s.id, candidates: [{ file: `${s.id}.opus`, type: 'audio/ogg; codecs="opus"' }, { file: `${s.id}.m4a`, type: 'audio/mp4' }], durationSec: Math.max(2, s.estSec * 0.9) });
  return m;
}

test('audio-pack mode: recordings are played (slot segments via their recorded twin), captions follow the timeline, TTS stays silent', async () => {
  const pack = (await rig({ id: 'tape-hiss-fm' })).pack;
  const r = await rig({ id: 'tape-hiss-fm', audioEntries: entriesFor(pack) });
  r.runner.start();
  await r.time.advance(20 * MIN, 250);
  const a = r.runner.aired;
  assert.ok(a.length >= 4);
  assert.ok(a.every((x) => x.source === 'audio'), a.map((x) => x.source).join());
  assert.ok(a.every((x) => x.variant !== 'slots'), 'a slot segment is aired as its recorded twin');
  assert.equal(r.synth.spoken.length, 0, 'system speech was not used');
  assert.ok(r.audio.calls.length === a.length);
  assert.match(r.audio.calls[0].candidates[0].url, /^audio\/tape-hiss-fm\/.+\.opus$/);
  assert.match(r.audio.calls[0].candidates[1].url, /\.m4a$/);
  const caps = r.events.filter((e) => e.type === 'caption');
  assert.ok(caps.length >= a.length, 'every recording was captioned line by line');
  assert.equal(r.runner.diag.audioAired, a.length);
  r.runner.stop(); await r.time.advance(1000);
});

test('audio-pack mode: a recording that fails is spoken by TTS instead; three failures in a row switch recordings off with a note', async () => {
  const pack = (await rig({ id: 'tape-hiss-fm' })).pack;
  const r = await rig({ id: 'tape-hiss-fm', audioEntries: entriesFor(pack), audioMode: () => 'fail' });
  r.runner.start();
  await r.time.advance(30 * MIN, 250);
  const a = r.runner.aired;
  assert.ok(a.length >= 6);
  assert.equal(r.runner.audioDisabled, true);
  assert.ok(r.events.some((e) => e.type === 'notice' && /recorded voices/i.test(e.text)));
  assert.equal(r.audio.calls.length, MAX_AUDIO_FAILS, 'after three failures the recordings are not even tried');
  assert.ok(a.slice(0, MAX_AUDIO_FAILS).every((x) => x.fellBack), 'the failing segments were still heard, by TTS');
  assert.ok(a.every((x) => x.source === 'tts'));
  assert.ok(r.synth.spoken.length > 10);
  assert.equal(r.runner.state.speech, 'ok', 'recording failures do not count against the speech engine');
  r.runner.stop(); await r.time.advance(1000);
});

test('audio-pack mode: one good recording after two failures resets the count; segments without a recording use TTS; no TTS and a failure = that segment skipped', async () => {
  const pack = (await rig({ id: 'tape-hiss-fm' })).pack;
  const entries = entriesFor(pack);
  let n = 0;
  const r = await rig({ id: 'tape-hiss-fm', audioEntries: entries, audioMode: () => (n++ % 3 === 2 ? 'ok' : 'fail') });
  r.runner.start(); await r.time.advance(25 * MIN, 250);
  assert.equal(r.runner.audioDisabled, false, 'a success between failures keeps recordings on');
  r.runner.stop(); await r.time.advance(1000);
  // only half the segments have recordings -> a mix
  const half = new Map([...entries].filter((_, i) => i % 2 === 0));
  const m = await rig({ id: 'tape-hiss-fm', audioEntries: half });
  m.runner.start(); await m.time.advance(25 * MIN, 250);
  const srcs = new Set(m.runner.aired.map((x) => x.source));
  assert.deepEqual([...srcs].sort(), ['audio', 'tts']);
  m.runner.stop(); await m.time.advance(1000);
  // recordings fail and there is no speech engine: segments are skipped, the music plays on
  const x = await rig({ id: 'tape-hiss-fm', audioEntries: entries, audioMode: () => 'fail', noSynth: true });
  x.runner.start(); await x.time.advance(15 * MIN, 250);
  assert.equal(x.runner.phase, 'playing');
  assert.ok(x.runner.diag.joins >= 2);
  x.runner.stop(); await x.time.advance(1000);
});
