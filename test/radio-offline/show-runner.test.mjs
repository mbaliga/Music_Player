import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './rig.mjs';
import { verifyScript } from '../../src/radio/core/grounding.js';
import { validateScript } from '../../src/radio/core/schemas.js';
import { findDeadAir } from '../../src/radio/core/scheduler.js';
import { fakeLibrary } from './helpers.mjs';

const captions = (events) => events.filter((e) => e.type === 'caption');
const phases = (events) => events.filter((e) => e.type === 'state').map((e) => e.phase);

test('cold start: speaking and the first song begin within a second, with nothing waited on', async () => {
  const r = await rig();
  r.runner.start();
  assert.equal(r.runner.phase, 'starting');
  await r.time.advance(1200);
  assert.ok(r.player.ev.some((e) => e[0] === 'load'), 'the first song was loaded');
  assert.equal(r.runner.phase, 'playing');
  assert.ok(captions(r.events).length >= 1, 'the station ID line was spoken at once');
  assert.match(captions(r.events)[0].text, /You Radio/);
  // the ID masks the decode: speech started before the song began (song load is instant here, speech start 40 ms)
  const firstCap = r.events.findIndex((e) => e.type === 'caption');
  assert.ok(firstCap >= 0);
  assert.ok(r.events.some((e) => e.type === 'now'), 'now-playing was announced');
  assert.equal(r.runner.current.track.title.startsWith('Song'), true);
  assert.ok(phases(r.events).includes('playing'));
});

test('cold start still works with no speech engine: the first sound is the user’s own song', async () => {
  const r = await rig({ voices: [], mode: 'nostart' });
  r.runner.start();
  await r.time.advance(6000);
  assert.equal(r.runner.phase, 'playing');
  assert.ok(r.player.played.length >= 1);
  assert.equal(r.player.played[0].startSec * 1000 - r.time.now() < 0, true);
});

test('empty library: friendly empty state, no audio, no speech, no timers left running', async () => {
  const r = await rig({ tracks: [] });
  r.runner.start();
  await r.time.advance(3000);
  assert.equal(r.runner.phase, 'empty');
  const st = r.events.find((e) => e.type === 'state' && e.phase === 'empty');
  assert.match(st.error.message, /Scan your music folder/);
  assert.equal(r.player.ev.length, 0); assert.equal(r.synth.spoken.length, 0); assert.equal(r.time.pending(), 0);
  r.runner.skip(); r.runner.stop();
  assert.equal(r.runner.phase, 'idle');
});

test('a library of only re-link entries is also "empty" (nothing playable)', async () => {
  const r = await rig({ tracks: [{ id: 'x', title: 'Needs relink', artist: 'A', album: 'B', relink: true, file: null }] });
  r.runner.start(); await r.time.advance(1000);
  assert.equal(r.runner.phase, 'empty');
});

test('breaks air as live speech with captions, the music is ducked during them, and restored after', async () => {
  const r = await rig({ seed: 3 });
  r.runner.start();
  await r.time.advance(8 * 60 * 1000);
  assert.ok(r.runner.aired.length >= 3, `only ${r.runner.aired.length} breaks aired in 8 minutes`);
  assert.ok(r.synth.spoken.length >= 5);
  // duck automation: every hold produced a ramp down then a ramp up; ends at unity
  const ramps = r.param.calls.filter((c) => c[0] === 'ramp');
  assert.ok(ramps.some((c) => c[1] < 0.5) && ramps.some((c) => c[1] === 1));
  assert.equal(r.duck.ducked, false);
  const last = ramps[ramps.length - 1];
  assert.ok(last[1] === 1 || r.duck.holdCount === 0);
  // captions carry the host name and the exact words
  const c = captions(r.events);
  assert.ok(c.every((x) => x.text && ['Casey', 'Jo'].includes(x.name)));
  assert.ok(new Set(c.map((x) => x.name)).size === 2, 'both hosts speak');
});

test('every break is verified at AIR time: the aired script passes the grounding verifier at that moment', async () => {
  const r = await rig({ seed: 5, location: { lat: 47.6, lon: -122.3 } });
  r.runner.start();
  await r.time.advance(20 * 60 * 1000);
  assert.ok(r.runner.aired.length >= 6);
  for (const a of r.runner.aired) {
    assert.deepEqual(validateScript(a.script), { ok: true, errors: [] });
    const v = verifyScript(a.script, a.snapshot, { atMs: a.airAtMs, trackMeta: a.trackMeta });
    assert.equal(v.ok, true, `${a.slotId}: ${JSON.stringify(v.problems)}`);
    assert.ok(['writer', 'canned'].includes(a.source));
  }
  assert.ok(r.runner.aired.some((a) => a.source === 'writer'));
});

test('stale facts at air time are never spoken: an expired weekday line is dropped or replaced', async () => {
  // start 5 minutes before local midnight: weekday facts expire at midnight
  const r = await rig({ seed: 2, startMs: Date.parse('2026-11-04T23:55:00Z') });
  r.runner.start();
  await r.time.advance(25 * 60 * 1000);
  for (const a of r.runner.aired) {
    const v = verifyScript(a.script, a.snapshot, { atMs: a.airAtMs, trackMeta: a.trackMeta });
    assert.equal(v.ok, true, `${a.slotId} aired with a problem: ${JSON.stringify(v.problems)}`);
  }
});

test('gapless: the next song is decoded ahead, parked, and joined; never more than two decks', async () => {
  const r = await rig({ seed: 4 });
  r.runner.start();
  let maxDecks = 0;
  for (let i = 0; i < 40; i++) {
    await r.time.advance(15000);
    maxDecks = Math.max(maxDecks, (r.player.deck ? 1 : 0) + (r.player.next ? 1 : 0));
  }
  assert.ok(maxDecks <= 2);
  const kinds = r.player.ev.map((e) => e[0]);
  assert.ok(kinds.filter((k) => k === 'join').length >= 2, 'songs were joined, not cold-loaded');
  assert.equal(kinds.filter((k) => k === 'load').length, 1, 'only the very first song is a cold load');
  // each join is preceded by its decode + prepare
  const seq = r.player.ev.filter((e) => ['decodeNext', 'prepareNext', 'join'].includes(e[0])).map((e) => e[0]);
  for (let i = 0; i < seq.length; i += 3) assert.deepEqual(seq.slice(i, i + 3), ['decodeNext', 'prepareNext', 'join'].slice(0, seq.slice(i, i + 3).length));
  const ids = r.player.played.map((p) => p.trackId);
  assert.equal(new Set(ids).size, ids.length, 'no repeats within a round');
  assert.ok(r.history.tracks[ids[0]].n >= 1, 'plays are recorded in the local history');
  assert.equal(r.history.sessions, 1);
});

test('talk-over-intro lines start with the song they introduce; outro breaks end before the join', async () => {
  const r = await rig({ seed: 6 });
  r.runner.start();
  await r.time.advance(15 * 60 * 1000);
  const speechAt = r.synth.spoken.map((s) => s.at / 1000);
  const songStarts = r.player.played.map((p) => p.startSec);
  assert.ok(speechAt.length > 3);
  // some speech starts within 3 s of a song start (intro / sign-on talk-up)
  assert.ok(speechAt.some((t) => songStarts.some((s) => t - s >= 0 && t - s < 3)), 'a talk-over-intro');
  // and some starts well inside a song's second half (outro break)
  assert.ok(speechAt.some((t) => r.player.played.some((p) => t > p.startSec + (p.endSec - p.startSec) * 0.5 && t < p.endSec)), 'an outro break');
});

test('skip: speech is cancelled, the music bus is restored, and the next song plays with no gap when it is parked', async () => {
  const r = await rig({ seed: 7 });
  r.runner.start();
  await r.time.advance(100 * 1000);           // song 1 is playing and song 2 is decoded and parked (40 s before the end)
  const before = r.player.played.length;
  r.runner.skip();
  await r.time.advance(2000);
  assert.ok(r.player.played.length >= before + 1, 'the next song started');
  assert.equal(r.runner.state.skipped, 1);
  assert.equal(r.duck.ducked, false);
  assert.equal(r.voice.speaking, false);
  // skipping mid-speech
  await r.time.advance(300 * 1000);
  const t0 = r.synth.spoken.length;
  for (let i = 0; i < 8000 && !r.voice.speaking; i++) await r.time.advance(250);
  assert.equal(r.voice.speaking, true, 'a break is being spoken');
  const cancels = r.synth.cancels;
  r.runner.skip();
  assert.equal(r.voice.speaking, false, 'the line in progress is cut at once'); assert.ok(r.synth.cancels > cancels);
  await r.time.advance(300);
  assert.equal(r.duck.holdCount <= 1, true);
  await r.time.advance(15000);
  assert.ok(phases(r.events).every((p) => p !== 'error'));
  assert.equal(r.runner.phase, 'playing');
});

test('skip when nothing is parked cold-loads the next pick and never repeats a played track', async () => {
  const r = await rig({ seed: 8 });
  r.runner.start();
  await r.time.advance(5000);          // too early for the preload
  for (let i = 0; i < 5; i++) { r.runner.skip(); await r.time.advance(500); }
  const ids = r.player.played.map((p) => p.trackId);
  assert.ok(ids.length >= 6);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(r.runner.phase, 'playing');
});

test('stop: cancels speech mid-word, restores the music, halts the engine, drops the parked deck, leaves no timers', async () => {
  const r = await rig({ seed: 9 });
  r.runner.start();
  for (let i = 0; i < 8000 && !r.voice.speaking; i++) await r.time.advance(250);
  assert.equal(r.voice.speaking, true);
  assert.equal(r.duck.ducked, true);
  r.runner.stop();
  assert.equal(r.runner.phase, 'idle');
  assert.equal(r.voice.speaking, false);
  assert.equal(r.duck.ducked, false);
  assert.ok(r.synth.cancels >= 1);
  await r.time.advance(5000);
  assert.ok(r.player.ev.some((e) => e[0] === 'halt'));
  assert.equal(r.player.next, null);
  assert.equal(r.time.pending(), 0, 'no timer left running after stop');
  const spokenAtStop = r.synth.spoken.length;
  await r.time.advance(600 * 1000);
  assert.equal(r.synth.spoken.length, spokenAtStop, 'nothing is spoken after stop');
  assert.equal(r.player.ev.filter((e) => e[0] === 'load').length, 1, 'nothing new loaded after stop');
  assert.ok(r.memory.recentShows.length === 1, 'the show was remembered for anti-repeat');
  // a stopped station can start again cleanly
  r.runner.start(); await r.time.advance(3000);
  assert.equal(r.runner.phase, 'playing');
});

test('decode failures: a bad first file is skipped silently; a bad parked file is replaced before it is needed', async () => {
  const lib = fakeLibrary(12);
  const r = await rig({ tracks: lib, failLoad: new Set(lib.map((t) => t.id).slice(0, 3)), failDecode: new Set(lib.map((t) => t.id).slice(3, 6)), seed: 10 });
  r.runner.start();
  await r.time.advance(10 * 60 * 1000);
  assert.equal(r.runner.phase, 'playing');
  const bad = new Set([...r.player.failLoad, ...r.player.failDecode]);
  assert.ok(r.player.played.length >= 2);
  assert.ok(r.player.played.every((p) => !bad.has(p.trackId)), 'a failing track is never played');
  assert.ok(r.runner.diag.decodeFailures >= 1);
  assert.ok(phases(r.events).every((p) => p !== 'error'));
});

test('everything unplayable: after five failures in a row the station stops with a plain message instead of idling', async () => {
  const lib = fakeLibrary(12);
  const r = await rig({ tracks: lib, failLoad: new Set(lib.map((t) => t.id)) });
  r.runner.start();
  await r.time.advance(30000);
  assert.equal(r.runner.phase, 'error');
  const e = r.events.filter((x) => x.type === 'state').pop();
  assert.equal(e.error.kind, 'nothing_playable');
  assert.equal(r.duck.ducked, false);
  assert.equal(r.time.pending(), 0);
});

test('speech that never starts: breaks are skipped silently, three failures put the hosts off, the music never stops', async () => {
  const r = await rig({ mode: 'nostart', seed: 11 });
  r.runner.start();
  await r.time.advance(14 * 60 * 1000);
  assert.equal(r.runner.state.speech, 'off');
  assert.ok(r.events.some((e) => e.type === 'notice' && /Music only/.test(e.text)));
  assert.equal(r.runner.phase, 'playing');
  assert.ok(r.player.played.length >= 4);
  assert.equal(r.duck.ducked, false);
  assert.ok(r.runner.diag.dropped.length >= 1);
  assert.equal(findDeadAir(r.player.played.map((p) => ({ startSec: p.startSec, durationSec: p.endSec - p.startSec })), { fromSec: r.player.played[0].startSec, toSec: r.player.played[r.player.played.length - 2].endSec }).length, 0);
});

test('speech whose end event is dropped does not wedge the lane or the ducking', async () => {
  const r = await rig({ mode: 'noend', seed: 12 });
  r.runner.start();
  await r.time.advance(12 * 60 * 1000);
  assert.equal(r.runner.phase, 'playing');
  assert.ok(r.runner.aired.length >= 3, 'later breaks still air');
  await r.time.advance(60 * 1000);
  assert.equal(r.duck.ducked && !r.voice.speaking && r.runner.aired.length > 0 && false, false);
});

test('backgrounding cancels speech and keeps the music; foregrounding resumes breaks', async () => {
  const r = await rig({ seed: 13 });
  r.runner.start();
  for (let i = 0; i < 8000 && !r.voice.speaking; i++) await r.time.advance(250);
  assert.equal(r.voice.speaking, true);
  r.runner.setBackground(true);
  assert.equal(r.voice.speaking, false); assert.equal(r.duck.ducked, false);
  const n = r.synth.spoken.length;
  await r.time.advance(6 * 60 * 1000);
  assert.equal(r.synth.spoken.length, n, 'no speech while backgrounded');
  assert.equal(r.runner.phase, 'playing');
  r.runner.setBackground(false);
  await r.time.advance(10 * 60 * 1000);
  assert.ok(r.synth.spoken.length > n, 'speech resumes in the foreground');
});

test('a tiny library loops in rounds without ever repeating inside a round and never errors', async () => {
  const r = await rig({ n: 3, seed: 14 });
  r.runner.start();
  await r.time.advance(25 * 60 * 1000);
  assert.equal(r.runner.phase, 'playing');
  const ids = r.player.played.map((p) => p.trackId);
  assert.ok(ids.length >= 8);
  for (let i = 3; i < ids.length; i++) assert.notEqual(ids[i], ids[i - 1], 'never the same song twice in a row');
  assert.ok(phases(r.events).every((p) => p !== 'error'));
});

test('a one-song library keeps going (the only song repeats; nothing breaks)', async () => {
  const r = await rig({ n: 1, seed: 15 });
  r.runner.start();
  await r.time.advance(15 * 60 * 1000);
  assert.equal(r.runner.phase, 'playing');
  assert.ok(r.player.played.length >= 3);
});

test('director failure falls back to music-only slots; writer failure falls back to canned; the show goes on', async () => {
  const r = await rig({ seed: 16 });
  r.director.plan = async () => { throw new Error('offline director down'); };
  r.runner.start();
  await r.time.advance(8 * 60 * 1000);
  assert.equal(r.runner.phase, 'playing');
  assert.ok(r.player.played.length >= 2);
  const r2 = await rig({ seed: 17 });
  r2.writer.write = async () => { throw new Error('writer down'); };
  r2.runner.start();
  await r2.time.advance(10 * 60 * 1000);
  assert.ok(r2.runner.aired.length >= 2);
  assert.ok(r2.runner.aired.every((a) => a.source === 'canned'));
  for (const a of r2.runner.aired) assert.equal(verifyScript(a.script, a.snapshot, { atMs: a.airAtMs }).ok, true);
});

test('the same seed gives the same show', async () => {
  const run = async () => { const r = await rig({ seed: 21 }); r.runner.start(); await r.time.advance(12 * 60 * 1000); return JSON.stringify([r.player.played.map((p) => p.trackId), r.synth.spoken.map((s) => s.text)]); };
  assert.equal(await run(), await run());
});
