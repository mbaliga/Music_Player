// Adversarial event orders against the canned runner (and its You Radio sibling where the code is shared): cancel during the
// pause between a break's lines, Stop while a decode is in flight, a record started by the user under a running show, a library
// that empties mid-show, a recording chain that fails slowly. Every test here failed on the code before the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCannedRunner } from '../../src/radio/canned/runner.js';
import { createSystemVoice, webSpeechBackend } from '../../src/radio/offline/voice.js';
import { createDuckController } from '../../src/radio/offline/ducking.js';
import { assignHostVoices } from '../../src/radio/canned/voices.js';
import { createEngineGate } from '../../src/engine-gate.js';
import { fakeTime, FakeSynth, FakeUtterance, fakeLibrary, fakePlayer, fakeParam } from '../radio-offline/helpers.mjs';
import { loadPackFile } from '../support/canned-sim.mjs';
import { MANY_VOICES } from './rig.mjs';

const MIN = 60 * 1000;

/** a runner on virtual time with an injectable host (player) and audio backend */
async function build({ id = 'meridian-91-5', n = 16, wrapPlayer = (p) => p, audio = null, audioEntries = null, getTracks = null } = {}) {
  const time = fakeTime();
  const lib = fakeLibrary(n);
  const base = fakePlayer(time, {});
  const player = wrapPlayer(base, time);
  const synth = new FakeSynth(time, { voices: MANY_VOICES });
  const voice = createSystemVoice({ backends: [webSpeechBackend({ synth, Utterance: FakeUtterance, timers: time.timers })], timers: time.timers, now: time.now });
  const param = fakeParam(1);
  const duck = createDuckController({ param, now: () => time.now() / 1000 });
  const pack = loadPackFile(id);
  const events = [];
  let assign = { byHost: {} };
  const audioPack = audioEntries ? { entries: audioEntries, base: 'audio', stationId: pack.id } : null;
  const runner = createCannedRunner({
    now: time.now, timers: time.timers, pack, voice, audio, audioPack, player, duck, seed: 1,
    getTracks: getTracks ? () => getTracks(lib) : () => lib.map((t) => ({ ...t, file: t.file || {} })),
    emit: (e) => events.push(e), getVoiceAssign: () => assign,
  });
  await voice.init(); assign = assignHostVoices(pack.hostList, voice.allVoices(), {});
  return { time, lib, base, player, synth, voice, param, duck, pack, events, runner };
}

/** step until the runner is in the pause between two lines of the same break (a line has finished, the next has not started) */
async function untilPaused(r) {
  for (let i = 0; i < 4000; i++) {
    await r.time.advance(20, 20);
    const rec = r.runner.aired[r.runner.aired.length - 1];
    if (rec && rec.lines.length > 1 && r.synth.spoken.length >= 1 && r.synth.spoken.length < rec.lines.length && !r.synth.speaking && !r.voice.speaking && r.duck.holdCount > 0) return rec;
  }
  throw new Error('never saw a pause between lines');
}

test('skip during the pause between a break\'s lines: the rest of that break is NOT spoken over the next song', async () => {
  let found = null;
  for (const id of ['meridian-91-5', 'pirate-1400', 'tape-hiss-fm', 'static-city-98-1', 'kilo-hertz-rock-102-7']) {
    const r = await build({ id });
    r.runner.start();
    try { await untilPaused(r); } catch { continue; }
    found = r; break;
  }
  assert.ok(found, 'a station with a multi-line opening break');
  const r = found;
  const spokenBefore = r.synth.spoken.length;
  r.runner.skip();
  await r.time.advance(3000, 50);
  assert.equal(r.synth.spoken.length, spokenBefore, 'no further lines of the cancelled break were spoken');
  assert.equal(r.duck.holdCount, 0, 'nothing stays ducked');
  assert.ok(Math.abs(r.duck.gainAt(r.time.now() / 1000 + 1) - 1) < 0.01);
  r.runner.stop(); await r.time.advance(1000);
});

test('sign-off cancelled by skip in the pause between lines does not interleave', async () => {
  const r = await build({ id: 'kilo-hertz-rock-102-7' });
  r.runner.start();
  await r.time.advance(6 * MIN, 250);
  r.runner.signOff();
  let paused = false;
  for (let i = 0; i < 3000 && !paused; i++) { await r.time.advance(20, 20); const rec = r.runner.aired.at(-1); paused = !!rec && rec.why === 'sign_off' && rec.lines.length > 1 && !r.synth.speaking && !r.voice.speaking && r.synth.spoken.length > 0 && r.duck.holdCount > 0; }
  if (!paused) return; // this pack's sign-off is a single line: nothing to interleave
  const n = r.synth.spoken.length;
  r.runner.skip();
  await r.time.advance(2500, 50);
  assert.equal(r.synth.spoken.length, n);
  assert.equal(r.duck.holdCount, 0);
});

/** a host whose load/prepare honour a gate the way main.js makeAiHost does, with a slow decode */
function gatedHost(decodeMs) {
  const gate = createEngineGate();
  return {
    gate,
    wrap(base, time) {
      const wait = (ms) => new Promise((res) => time.setTimeout(res, ms));
      return Object.assign(Object.create(base), {
        owner: () => gate.token(),
        cancelPending: () => { gate.bump(); },
        async load(lib) { const t = gate.token(); await wait(decodeMs); gate.check(t); return base.load(lib); },
        async decodeNext(lib) { const t = gate.token(); const h = await base.decodeNext(lib); await wait(decodeMs); gate.check(t); return { ...h, tok: t }; },
        async prepareNext(h) { gate.check(h.tok); return base.prepareNext(h); },
        joinNext: (f) => base.joinNext(f), adopt: (h) => base.adopt(h), dropNext: () => base.dropNext(), position: () => base.position(), halt: () => base.halt(),
        getTracks: undefined,
      });
    },
  };
}

test('Stop while the first song is still decoding: the stale load does not install the old song afterwards', async () => {
  const h = gatedHost(3000);
  const r = await build({ wrapPlayer: h.wrap });
  r.runner.start();
  await r.time.advance(500, 50);
  r.runner.stop();
  await r.time.advance(8000, 100);
  assert.equal(r.runner.phase, 'idle');
  assert.equal(r.base.deck, null, 'no song on the deck after Stop');
  assert.ok(!r.base.ev.some((e) => e[0] === 'load'), 'the load was cancelled before it touched the engine');
});

test('Skip with nothing prepared, then Stop during the cold load: nothing is installed', async () => {
  const h = gatedHost(2500);
  const r = await build({ wrapPlayer: h.wrap });
  r.runner.start();
  await r.time.advance(4000, 100);
  assert.ok(r.base.deck, 'first song playing');
  r.runner.skip();
  await r.time.advance(300, 50);
  r.runner.stop();
  await r.time.advance(8000, 100);
  assert.equal(r.base.deck, null);
  assert.equal(r.base.next, null);
});

test('a track the user started on the shared engine ends the show without touching the new deck or its prepared next', async () => {
  const h = gatedHost(10);
  const r = await build({ wrapPlayer: h.wrap });
  r.runner.start();
  await r.time.advance(20 * 1000, 100);
  assert.equal(r.runner.phase, 'playing');
  // the user starts a record: the app bumps the gate and loads its own deck, with its own prepared next (a mixtape)
  h.gate.bump();
  await r.base.load({ id: 'user-track', durationSec: 300 });
  await r.base.prepareNext({ id: 'user-next', durationSec: 200 });
  const evBefore = r.base.ev.length;
  await r.time.advance(2000, 100);
  assert.equal(r.runner.phase, 'idle', 'the show stood down');
  const after = r.base.ev.slice(evBefore);
  assert.ok(!after.some((e) => e[0] === 'halt' || e[0] === 'dropNext' || e[0] === 'join' || e[0] === 'load'), `touched the engine: ${JSON.stringify(after)}`);
  assert.equal(r.base.deck.id, 'user-track');
  assert.equal(r.base.next.id, 'user-next');
  assert.equal(r.duck.holdCount, 0);
  assert.ok(Math.abs(r.duck.gainAt(r.time.now() / 1000 + 1) - 1) < 0.01, 'the music bus is back at unity');
  const n = r.synth.spoken.length;
  await r.time.advance(2 * MIN, 250);
  assert.equal(r.synth.spoken.length, n, 'no more talk');
  assert.equal(r.base.deck.id, 'user-track');
});

test('abandon() (RadioUI.foreignPlayback) is an immediate stop that leaves the deck, next deck and bus alone', async () => {
  const r = await build();
  r.runner.start();
  await r.time.advance(30 * 1000, 100);
  const deck = r.base.deck;
  r.runner.abandon();
  await r.time.advance(2000, 100);
  assert.equal(r.runner.phase, 'idle');
  assert.ok(!r.base.ev.some((e) => e[0] === 'halt'), 'player.halt (which seeks to the runout) is not called');
  assert.equal(r.base.deck, deck);
  assert.equal(r.duck.holdCount, 0);
});

test('library emptied mid-show: the show ends with the friendly message instead of sitting silent as "On air"', async () => {
  let empty = false;
  const r = await build({ n: 3, getTracks: (lib) => (empty ? [] : lib.map((t) => ({ ...t, file: {} }))) });
  r.runner.start();
  await r.time.advance(20 * 1000, 100);
  assert.equal(r.runner.phase, 'playing');
  empty = true; // the next song was already picked; after it nothing is playable
  await r.time.advance(12 * MIN, 250);
  assert.notEqual(r.runner.phase, 'playing');
  assert.match(r.runner.state.error.message, /no playable songs/i);
});

test('library emptied mid-show: Skip ends the show cleanly too (it used to do nothing)', async () => {
  let empty = false;
  const r = await build({ n: 2, getTracks: (lib) => (empty ? [] : lib.map((t) => ({ ...t, file: {} }))) });
  r.runner.start();
  await r.time.advance(20 * 1000, 100);
  r.runner.skip(); // consumes the already-picked next song
  await r.time.advance(2000, 100);
  empty = true;
  for (let i = 0; i < 4 && r.runner.phase === 'playing'; i++) { await r.time.advance(30 * 1000, 100); r.runner.skip(); await r.time.advance(2000, 100); }
  assert.notEqual(r.runner.phase, 'playing');
});

test('a recording chain that fails slowly does not duck the song while nothing is audible; the duck is taken for the TTS fallback', async () => {
  const time0 = { t: null };
  // a recording backend whose candidates all fail after 7 s (the real per-candidate start timeout), without ever starting
  let cancel = null;
  const audio = {
    cancel() { if (cancel) cancel(); },
    play: () => new Promise((resolve) => {
      const t = time0.t.setTimeout(() => { cancel = null; resolve({ ok: false, reason: 'load_failed:no_start', tried: 2 }); }, 7000);
      cancel = () => { time0.t.clearTimeout(t); cancel = null; resolve({ ok: false, reason: 'cancelled' }); };
    }),
  };
  const probe = await build({ id: 'tape-hiss-fm' });
  const entries = new Map();
  for (const u of probe.pack.units) for (const s of [u.seg, ...u.twins]) if (!s.usesSlots.length) entries.set(s.id, { id: s.id, candidates: [{ file: `${s.id}.opus`, type: 'audio/ogg; codecs="opus"' }], durationSec: Math.max(2, s.estSec * 0.9) });
  const r = await build({ id: 'tape-hiss-fm', audio, audioEntries: entries });
  time0.t = r.time;
  r.runner.start();
  await r.time.advance(5000, 50);
  assert.equal(r.runner.aired.length >= 1, true, 'a recording break is being aired');
  assert.equal(r.duck.holdCount, 0, 'not ducked while the recording has not started');
  assert.ok(!r.param.calls.some((c) => c[0] === 'ramp' && c[1] < 0.5), 'no duck ramp yet');
  await r.time.advance(6000, 50);
  assert.ok(r.synth.spoken.length >= 1, 'the segment fell back to TTS');
  assert.ok(r.param.calls.some((c) => c[0] === 'ramp' && c[1] < 0.5), 'ducked once the voice was actually heard');
  r.runner.stop(); await r.time.advance(1000);
  assert.equal(r.duck.holdCount, 0);
});
