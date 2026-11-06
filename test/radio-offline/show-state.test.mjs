import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceShow, initialShow, MAX_DECODE_FAILS, MAX_SPEECH_FAILS, EMPTY_MESSAGE } from '../../src/radio/offline/show-state.js';

const run = (events, from = initialShow()) => {
  let state = from; const actions = [];
  for (const e of events) { const r = reduceShow(state, e); state = r.state; actions.push(...r.actions.map((a) => a.type)); }
  return { state, actions };
};

test('cold start: begin at once; first sound flips starting -> playing; a song start also does', () => {
  let r = run([{ type: 'start', tracks: 5, speechAvailable: true }]);
  assert.equal(r.state.phase, 'starting'); assert.deepEqual(r.actions, ['begin']); assert.equal(r.state.speech, 'ok');
  r = run([{ type: 'first-sound' }], r.state);
  assert.equal(r.state.phase, 'playing');
  const s = run([{ type: 'start', tracks: 5, speechAvailable: false }, { type: 'song-started', slotId: 'a', trackId: 't1' }]);
  assert.equal(s.state.phase, 'playing'); assert.equal(s.state.played, 1); assert.equal(s.state.speech, 'off');
});

test('empty library: a friendly empty state, nothing begins, skip and stop do no harm', () => {
  const r = run([{ type: 'start', tracks: 0, speechAvailable: true }]);
  assert.equal(r.state.phase, 'empty'); assert.equal(r.state.error.kind, 'empty_library'); assert.equal(r.state.error.message, EMPTY_MESSAGE);
  assert.match(EMPTY_MESSAGE, /Scan your music folder/);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(run([{ type: 'skip' }, { type: 'decode-failed' }], r.state).actions, []);
  assert.equal(run([{ type: 'stop' }], r.state).state.phase, 'idle');
});

test('skip: cancels speech and advances, only while on air', () => {
  const on = run([{ type: 'start', tracks: 3, speechAvailable: true }, { type: 'song-started', slotId: 'a', trackId: 't' }]);
  const r = run([{ type: 'skip' }], on.state);
  assert.deepEqual(r.actions, ['cancel-speech', 'advance']); assert.equal(r.state.skipped, 1); assert.equal(r.state.phase, 'playing');
  assert.deepEqual(run([{ type: 'skip' }], initialShow()).actions, []);
});

test('stop: cancels speech, restores music, drops the queued deck, halts; stays idle after', () => {
  const on = run([{ type: 'start', tracks: 3, speechAvailable: true }, { type: 'song-started', slotId: 'a', trackId: 't' }]);
  const r = run([{ type: 'stop' }], on.state);
  assert.deepEqual(r.actions, ['cancel-speech', 'restore-music', 'drop-next', 'halt']); assert.equal(r.state.phase, 'idle'); assert.equal(r.state.cur, null);
  assert.deepEqual(run([{ type: 'skip' }, { type: 'song-started', slotId: 'z', trackId: 'z' }], r.state).actions, []); // late events after stop are ignored
  assert.equal(run([{ type: 'song-started', slotId: 'z', trackId: 'z' }], r.state).state.phase, 'idle');
});

test('decode failure: advance silently; five in a row is a plain error that halts; a good song resets the count', () => {
  let r = run([{ type: 'start', tracks: 3, speechAvailable: true }]);
  for (let i = 1; i < MAX_DECODE_FAILS; i++) { r = run([{ type: 'decode-failed', trackId: `x${i}` }], r.state); assert.deepEqual(r.actions, ['advance']); assert.equal(r.state.phase, 'starting'); }
  const ok = run([{ type: 'song-started', slotId: 'a', trackId: 't' }], r.state);
  assert.equal(ok.state.decodeFails, 0);
  let e = run([{ type: 'start', tracks: 3, speechAvailable: true }]);
  for (let i = 0; i < MAX_DECODE_FAILS; i++) e = run([{ type: 'decode-failed', trackId: `x${i}` }], e.state);
  assert.equal(e.state.phase, 'error'); assert.equal(e.state.error.kind, 'nothing_playable'); assert.ok(e.actions.includes('halt'));
  // a failed preload counts but does not advance
  const p = run([{ type: 'start', tracks: 3, speechAvailable: true }, { type: 'song-started', slotId: 'a', trackId: 't' }, { type: 'preload-failed', trackId: 'n' }]);
  assert.deepEqual(p.actions, ['begin']); assert.equal(p.state.decodeFails, 1);
});

test('speech failures: three in a row switch the hosts off with one notice; success resets; voice change re-enables', () => {
  let r = run([{ type: 'start', tracks: 3, speechAvailable: true }, { type: 'song-started', slotId: 'a', trackId: 't' }]);
  r = run([{ type: 'speech-failed', reason: 'no_start' }, { type: 'speech-failed', reason: 'no_start' }, { type: 'speech-ok' }, { type: 'speech-failed', reason: 'x' }, { type: 'speech-failed', reason: 'x' }], r.state);
  assert.equal(r.state.speech, 'ok'); assert.equal(r.state.speechFails, 2);
  r = run([{ type: 'speech-failed', reason: 'x' }], r.state);
  assert.equal(r.state.speech, 'off'); assert.deepEqual(r.actions, ['notice']); assert.equal(r.state.phase, 'playing', 'the music carries on');
  assert.deepEqual(run([{ type: 'speech-failed', reason: 'x' }], r.state).actions, []);
  assert.equal(run([{ type: 'voice-changed' }], r.state).state.speech, 'ok');
  assert.equal(MAX_SPEECH_FAILS, 3);
});

test('fail halts with a plain message; unknown events are ignored', () => {
  const on = run([{ type: 'start', tracks: 3, speechAvailable: true }]);
  const r = run([{ type: 'fail', message: 'x'.repeat(500) }], on.state);
  assert.equal(r.state.phase, 'error'); assert.ok(r.state.error.message.length <= 200); assert.ok(r.actions.includes('halt'));
  assert.equal(run([{ type: 'wat' }], on.state).state, on.state);
});
