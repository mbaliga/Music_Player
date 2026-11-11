import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCannedSession, loadStationPack, loadStationsIndex, validStationId, _clearCaches } from '../../src/radio/canned/session.js';
import { createSystemVoice, webSpeechBackend } from '../../src/radio/offline/voice.js';
import { createFakeNet } from '../../src/radio/canned/net.js';
import { fakeTime, FakeSynth, FakeUtterance, fakeLibrary, fakePlayer, fakeParam } from '../radio-offline/helpers.mjs';
import { MANY_VOICES, fakeAudioBackend } from './rig.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = 'http://localhost:8123/index.html';
const disk = (rel) => readFileSync(resolve(root, rel), 'utf8');

function fakeFetch({ index = null, missing = [], extra = {} } = {}) {
  const requests = [];
  const files = { 'stations/index.json': index ?? disk('content/stations/index.json'), ...extra };
  const f = async (url) => {
    requests.push(url);
    const u = new URL(url);
    const path = u.pathname.replace(/^\//, '');
    if (u.origin !== new URL(BASE).origin) throw new Error(`cross-origin request: ${url}`);
    if (missing.includes(path)) return { ok: false, status: 404, json: async () => { throw new Error('404'); } };
    if (path.startsWith('stations/') && !(path in files)) { const id = path.slice('stations/'.length); try { files[path] = disk(`content/stations/${id}`); } catch { /* 404 */ } }
    if (!(path in files)) return { ok: false, status: 404, json: async () => { throw new Error('404'); } };
    return { ok: true, status: 200, json: async () => JSON.parse(files[path]) };
  };
  f.requests = requests;
  return f;
}

function env(over = {}) {
  const time = fakeTime();
  const lib = over.tracks || fakeLibrary(12);
  const player = fakePlayer(time, {});
  const param = fakeParam(1);
  const host = Object.assign(Object.create(player), { getTracks: () => lib.map((t) => ({ ...t, file: {} })), busParam: () => param, audioNow: () => time.now() / 1000 });
  for (const k of ['load', 'decodeNext', 'prepareNext', 'joinNext', 'adopt', 'dropNext', 'position', 'halt']) host[k] = player[k].bind(player);
  const synth = new FakeSynth(time, { voices: MANY_VOICES });
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const fetch = over.fetch || fakeFetch();
  return { time, player, host, synth, storage, fetch, param, e: { aiHost: host, storage, timers: time.timers, now: time.now, fetch, baseUrl: BASE, speechSynthesis: synth, Utterance: FakeUtterance, capPlugin: null, net: createFakeNet(true), ...over.e } };
}
const station = (id) => ({ type: 'canned', id, name: id, tags: ['canned'] });

test('session: loads the index and the pack from the app origin, plays, and a second start needs no requests at all', async () => {
  _clearCaches();
  const x = env();
  const s = createCannedSession(station('meridian-91-5'), x.e);
  const phases = []; s.onChange((st) => phases.push(st.phase));
  await s.start();
  await x.time.advance(10 * 60 * 1000, 250);
  assert.deepEqual(phases.slice(0, 2), ['connecting', 'playing']);
  assert.equal(s.state.phase, 'playing');
  assert.deepEqual(x.fetch.requests.sort(), ['http://localhost:8123/stations/index.json', 'http://localhost:8123/stations/meridian-91-5.json']);
  assert.ok(s.runner.aired.length >= 2);
  assert.equal(s.getView().recordings, false);
  assert.equal(s.decision.source, 'canned');
  s.stop(); await x.time.advance(1000);
  assert.equal(s.state.phase, 'idle');
  // again: cached, zero new requests (this is what makes it work with the network off)
  const n = x.fetch.requests.length;
  const x2 = env({ fetch: async () => { throw new Error('offline'); } });
  const s2 = createCannedSession(station('meridian-91-5'), x2.e);
  await s2.start(); await x2.time.advance(3 * 60 * 1000, 250);
  assert.equal(s2.state.phase, 'playing');
  assert.equal(x.fetch.requests.length, n);
  s2.stop(); await x2.time.advance(1000);
});

test('session: a missing or broken pack is a clear error, not a crash; bad station ids are refused without any request', async () => {
  _clearCaches();
  let x = env({ fetch: fakeFetch({ missing: ['stations/pirate-1400.json', 'content/stations/pirate-1400.json'] }) });
  let s = createCannedSession(station('pirate-1400'), x.e);
  await s.start();
  assert.equal(s.state.phase, 'error'); assert.match(s.state.error.message, /could not be loaded/);
  _clearCaches();
  const broken = JSON.parse(disk('content/stations/tape-hiss-fm.json')); broken.segments[0].lines = [];
  x = env({ fetch: fakeFetch({ extra: { 'stations/tape-hiss-fm.json': JSON.stringify(broken) } }) });
  s = createCannedSession(station('tape-hiss-fm'), x.e);
  await s.start();
  assert.equal(s.state.phase, 'error');
  _clearCaches();
  for (const id of ['../x', 'a/b', 'A', '', 'x'.repeat(100), 'a.json']) {
    assert.equal(validStationId(id), false, id);
    x = env(); s = createCannedSession(station(id), x.e);
    await s.start();
    assert.equal(s.state.phase, 'error'); assert.equal(x.fetch.requests.length, 0, id);
  }
  assert.deepEqual((await loadStationPack('../x', { fetchFn: async () => { throw new Error('no'); }, baseUrl: BASE })).ok, false);
  assert.throws(() => createCannedSession(station('x'), { }), /aiHost/);
});

test('session: the index is cached; junk indexes give an empty list, not an exception', async () => {
  _clearCaches();
  const f = fakeFetch();
  assert.equal((await loadStationsIndex({ fetchFn: f, baseUrl: BASE })).length, 6);
  assert.equal((await loadStationsIndex({ fetchFn: f, baseUrl: BASE })).length, 6);
  assert.equal(f.requests.length, 1);
  _clearCaches();
  assert.deepEqual(await loadStationsIndex({ fetchFn: fakeFetch({ index: '{"v":2}' }), baseUrl: BASE }), []);
  assert.deepEqual(await loadStationsIndex({ fetchFn: async () => { throw new Error('x'); }, baseUrl: BASE }), []);
});

test('session: with an audio pack in the index the manifest is fetched from the app origin and recordings are used; absent, nothing is requested', async () => {
  _clearCaches();
  const pack = JSON.parse(disk('content/stations/tape-hiss-fm.json'));
  const idx = JSON.parse(disk('content/stations/index.json')); idx.stations.find((s) => s.id === 'tape-hiss-fm').audio = true;
  const segs = pack.segments.filter((s) => !s.usesSlots.length).map((s) => ({ id: s.id, kind: s.kind, file: `${s.id}.opus`, durationSec: Math.max(2, s.estSec * 0.9), sha256: 'x', bytes: 1, lufs: -19 }));
  const f = fakeFetch({ index: JSON.stringify(idx), extra: { 'audio/tape-hiss-fm/manifest.json': JSON.stringify({ v: 1, station: 'tape-hiss-fm', codec: 'opus', segments: segs }) } });
  const x = env({ fetch: f });
  const audio = fakeAudioBackend(x.time);
  const s = createCannedSession(station('tape-hiss-fm'), { ...x.e, audio });
  await s.start(); await x.time.advance(12 * 60 * 1000, 250);
  assert.ok(f.requests.includes('http://localhost:8123/audio/tape-hiss-fm/manifest.json'));
  assert.equal(s.getView().recordings, true);
  assert.ok(s.runner.aired.length >= 2 && s.runner.aired.every((a) => a.source === 'audio'));
  assert.match(audio.calls[0].candidates[0].url, /^audio\/tape-hiss-fm\//);
  s.stop(); await x.time.advance(1000);
  // not in the index: the manifest is never requested (no 404 noise in a build without recordings)
  _clearCaches();
  const f2 = fakeFetch();
  const y = env({ fetch: f2 });
  const s2 = createCannedSession(station('tape-hiss-fm'), { ...y.e, audio: fakeAudioBackend(y.time) });
  await s2.start(); await y.time.advance(2000, 100);
  assert.equal(f2.requests.some((u) => /audio\//.test(u)), false);
  s2.stop(); await y.time.advance(1000);
});

test('session: per-host voice choices persist per station and change the next line\'s voice', async () => {
  _clearCaches();
  const x = env();
  const s = createCannedSession(station('tape-hiss-fm'), x.e);
  await s.start(); await x.time.advance(1500, 100);
  const first = s.pack.hostList[0].id;
  s.setHostVoice(first, 'karen');
  assert.equal(s.voiceAssignment().byHost[first].voiceId, 'karen');
  assert.deepEqual(JSON.parse(x.storage.getItem('runout.radio.canned.voices.v1')).byStation['tape-hiss-fm'], { [first]: 'karen' });
  s.resetVoices();
  assert.notEqual(s.voiceAssignment().byHost[first].voiceId, undefined);
  assert.deepEqual(s.voicePrefs(), {});
  s.stop(); await x.time.advance(1000);
});

test('NO NETWORK: a whole canned show with the global fetch, XHR, WebSocket, EventSource and beacons all booby-trapped (only the injected same-origin loader is used, once)', async () => {
  _clearCaches();
  const hits = [];
  const trap = (name) => function trapped() { hits.push(name); throw new Error(`network used: ${name}`); };
  const saved = {};
  const names = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'RTCPeerConnection'];
  for (const n of names) { saved[n] = globalThis[n]; globalThis[n] = trap(n); }
  const hadNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { sendBeacon: trap('sendBeacon'), onLine: false, connection: undefined }, configurable: true });
  try {
    const x = env({ e: { net: createFakeNet(false) } });
    const s = createCannedSession(station('pirate-1400'), x.e);
    await s.start();
    await x.time.advance(20 * 60 * 1000, 250);
    assert.equal(s.state.phase, 'playing'); assert.ok(s.runner.aired.length > 3);
    s.skip(); await x.time.advance(3000, 100);
    s.signOff(); await x.time.advance(60 * 1000, 250);
    assert.equal(s.state.phase, 'idle');
    assert.ok(x.fetch.requests.every((u) => u.startsWith('http://localhost:8123/stations/')), x.fetch.requests.join());
  } finally {
    for (const n of names) { if (saved[n] === undefined) delete globalThis[n]; else globalThis[n] = saved[n]; }
    if (hadNav) Object.defineProperty(globalThis, 'navigator', hadNav); else delete globalThis.navigator;
  }
  assert.deepEqual(hits, [], 'something touched the network');
});
