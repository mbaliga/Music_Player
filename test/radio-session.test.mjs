// radio-session.test.mjs — alternate URLs + reconnect, driven by a fake <audio>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamSession } from '../src/radio-session.js';

function fakeAudio(behaviour) {
  const l = {};
  const a = {
    src: '', error: null, loads: [],
    addEventListener(n, f) { (l[n] ||= []).push(f); },
    emit(n) { (l[n] || []).forEach((f) => f()); },
    pause() {}, load() {}, removeAttribute() { a.src = ''; },
    async play() { a.loads.push(a.src); return behaviour(a, a.src, a.loads.length); },
  };
  return a;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = (audio, o = {}) => ({ audioElement: audio, isOnline: () => true, reconnectDelayMs: () => 5, connectTimeoutMs: 200, stallMs: 30, stableMs: 40, ...o });
const station = { type: 'radio-browser', id: 'rb:1', name: 'S', streamUrl: 'https://a/1', streamUrls: ['https://a/1', 'https://b/1'] };
const dead = (a) => { a.error = { code: 4 }; const e = new Error('nope'); e.name = 'NotSupportedError'; queueMicrotask(() => a.emit('error')); throw e; };
const live = (a) => { queueMicrotask(() => a.emit('playing')); };

test('dead primary falls through to the alternate URL without surfacing an error', async () => {
  const a = fakeAudio((au, url) => (url.includes('a/') ? dead(au) : live(au)));
  const s = createStreamSession(station, env(a)); const seen = [];
  s.onChange((st) => seen.push(st.phase));
  await s.start(); await sleep(20);
  assert.deepEqual(a.loads, ['https://a/1', 'https://b/1']);
  assert.equal(s.state.phase, 'playing');
  assert.ok(!seen.includes('error'));
});

test('all candidates dead -> one clear error', async () => {
  const a = fakeAudio((au) => dead(au));
  const s = createStreamSession(station, env(a));
  await s.start(); await sleep(20);
  assert.equal(s.state.phase, 'error');
  assert.equal(s.state.error.kind, 'unsupported');
  assert.equal(a.loads.length, 2);
});

test('mid-stream drop reconnects with backoff, then recovers', async () => {
  let n = 0;
  const a = fakeAudio((au) => { n++; live(au); });
  const s = createStreamSession(station, env(a)); const seen = [];
  s.onChange((st) => seen.push(st.phase + (st.attempt ?? '')));
  await s.start(); await sleep(10);
  assert.equal(s.state.phase, 'playing');
  a.error = { code: 2 }; a.emit('error');
  assert.equal(s.state.phase, 'reconnecting'); assert.equal(s.state.attempt, 1);
  await sleep(30);
  assert.equal(s.state.phase, 'playing'); assert.equal(n, 2);
  assert.equal(a.loads[1], 'https://a/1'); // first retry: same URL
});

test('reconnects are bounded, rotate alternates, then error', async () => {
  let n = 0;
  const a = fakeAudio((au) => { n++; if (n === 1) return live(au); return dead(au); });
  const s = createStreamSession(station, env(a));
  await s.start(); await sleep(10);
  a.emit('ended');
  await sleep(120);
  assert.equal(s.state.phase, 'error');
  assert.equal(n, 1 + 4); // initial + MAX_RECONNECTS
  assert.deepEqual(a.loads.slice(0, 3), ['https://a/1', 'https://a/1', 'https://b/1']);
});

test('a stalled stream is treated as a drop; stop() cancels a pending retry', async () => {
  const a = fakeAudio((au) => live(au));
  const s = createStreamSession(station, env(a, { reconnectDelayMs: () => 50 }));
  await s.start(); await sleep(10);
  a.emit('waiting'); assert.equal(s.state.phase, 'buffering');
  await sleep(50); assert.equal(s.state.phase, 'reconnecting');
  s.stop(); await sleep(80);
  assert.equal(s.state.phase, 'idle'); assert.equal(a.loads.length, 1);
});

test('offline start errors immediately; no candidates is an error, not a throw', async () => {
  const a = fakeAudio(live);
  const s = createStreamSession(station, env(a, { isOnline: () => false }));
  await s.start(); assert.equal(s.state.error.kind, 'offline'); assert.equal(a.loads.length, 0);
  const s2 = createStreamSession({ type: 't', id: 'i', name: 'n' }, env(fakeAudio(live)));
  await s2.start(); assert.equal(s2.state.phase, 'error');
});

test('connect timeout moves to the alternate, then errors as timeout', async () => {
  const a = fakeAudio(() => new Promise(() => {})); // never plays
  const s = createStreamSession(station, env(a, { connectTimeoutMs: 20 }));
  s.start(); await sleep(80);
  assert.equal(s.state.phase, 'error'); assert.equal(s.state.error.kind, 'timeout');
  assert.equal(a.loads.length, 2);
});
