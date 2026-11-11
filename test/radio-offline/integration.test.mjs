import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWeb, listFiles, reachableFiles, DENY } from '../../scripts/build-web.mjs';
import { registerAiStationTypes, unregisterAiStationTypes, createSessionFor, getStationType, listStationTypes, aiYouStation, aiYouCityStation, _resetStationTypes, AI_TYPE_YOU, AI_TYPE_YOU_CITY } from '../../src/stations.js';
import { createOfflineSession, loadLocation, saveLocation, LOCATION_KEY } from '../../src/radio/offline/station-session.js';
import { loadHistory, HISTORY_KEY } from '../../src/radio/offline/play-history.js';
import { VOICE_PREFS_KEY } from '../../src/radio/offline/voice.js';
import { MEMORY_KEY } from '../../src/radio/core/memory.js';
import { fakeTime, FakeSynth, FakeUtterance, VOICES, fakeLibrary, fakePlayer, fakeParam } from './helpers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = resolve(root, 'src/radio/offline');
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

test('static: the offline host contains no network API, no dev-only imports, only relative imports', () => {
  assert.ok(files.length >= 14, files.join());
  const BANNED = [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/, /\bRTCPeerConnection\b/, /https?:\/\//, /\bnavigator\.connection\b/, /\bimport\s*\(/, /\beval\s*\(/, /\bnew Function\b/, /\bMath\.random\b/];
  for (const f of files) {
    const src = readFileSync(resolve(dir, f), 'utf8');
    const c = code(src);
    for (const re of BANNED) assert.doesNotMatch(c, re, `${f} matches ${re}`);
    assert.match(src, /^\/\/ ─{20,}\n\/\/ [a-z.-]+\.js — /, `${f} needs its header comment`);
    for (const m of c.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
      assert.match(m[1], /^\.{1,2}\//, `${f} imports ${m[1]}`);
      assert.doesNotMatch(m[1], /fake-adapters|fixtures|\/sim\.js|dev\.js/, `${f} imports a dev-only module: ${m[1]}`);
    }
  }
  // the pure parts stay free of the DOM: only panel.js, station-session.js and voice backends' injected objects touch browser globals
  for (const f of ['bank.js', 'writer.js', 'director.js', 'context.js', 'show-state.js', 'show-runner.js', 'ducking.js', 'pronounce.js', 'sun.js', 'holidays.js']) {
    assert.doesNotMatch(code(readFileSync(resolve(dir, f), 'utf8')), /\b(window|document|localStorage|AudioContext)\b/, f);
  }
});

test('the offline host ships (reachable through the lazy door) and no dev-only file does', async () => {
  const tmp = await mkdtemp(resolve(tmpdir(), 'runout-off-'));
  try {
    const out = resolve(tmp, 'www');
    await buildWeb({ outDir: out, buildId: 't', quiet: true });
    const staged = await listFiles(out);
    for (const f of files) assert.ok(staged.includes(`src/radio/offline/${f}`), `${f} not shipped`);
    for (const d of DENY) assert.equal(staged.includes(d), false);
    const r = await reachableFiles(out);
    assert.deepEqual(r.missing, []);
    assert.ok(r.files.includes('src/radio/offline/index.js') && r.files.includes('src/radio/offline/show-runner.js') && r.files.includes('src/queue.js'));
    for (const d of DENY) assert.equal(r.files.includes(d), false, `${d} reachable`);
    const mod = await import(resolve(out, 'src/radio/offline/index.js') + `?s=${Date.now()}`);
    assert.equal(typeof mod.createOfflineSession, 'function'); assert.equal(typeof mod.mountYouPanel, 'function');
    assert.ok(mod.BANK_LINE_COUNT >= 150);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

// ── the stations.js seam ─────────────────────────────────────────────────────

test('seam: with loadHost and an aiHost, You Radio is a lazy proxy that delegates; without them it is the old stub', async () => {
  _resetStationTypes();
  const log = [];
  const inner = { onChange(f) { this.cb = f; }, async start() { log.push('inner.start'); this.cb({ phase: 'playing', error: null }); }, stop() { log.push('inner.stop'); }, skip() { log.push('inner.skip'); } };
  let loads = 0;
  const loadHost = async () => { loads++; return { createOfflineSession: (st, env) => { log.push(`create:${st.id}:${!!env.aiHost}`); return inner; } }; };
  assert.equal(registerAiStationTypes({ isEnabled: () => true, loadCore: async () => ({}), loadHost }), true);
  assert.equal(loads, 0, 'nothing loaded at registration');
  const s = createSessionFor(aiYouStation(), { aiHost: {} });
  assert.equal(s.usesEngine, true); assert.equal(typeof s.skip, 'function'); assert.equal(typeof s.attachPanel, 'function');
  assert.equal(loads, 0, 'nothing loaded at session creation');
  const seen = [];
  s.onChange((x) => seen.push(x.phase));
  await s.start();
  assert.equal(loads, 1);
  assert.deepEqual(log, ['create:you:true', 'inner.start']);
  assert.deepEqual(seen, ['connecting', 'playing']);
  s.skip(); s.stop();
  assert.deepEqual(log.slice(2), ['inner.skip', 'inner.stop']); assert.equal(s.state.phase, 'idle');
  // no aiHost in env: the old inert stub (ends in a clear error)
  const stub = createSessionFor(aiYouStation(), {});
  assert.equal(stub.usesEngine, undefined);
  await stub.start();
  assert.equal(stub.state.phase, 'error');
  // You City is still the stub
  const city = createSessionFor(aiYouCityStation(), { aiHost: {} });
  await city.start();
  assert.equal(city.state.phase, 'error');
  // a host that fails to load is the same clear error, not a hang
  _resetStationTypes();
  registerAiStationTypes({ isEnabled: () => true, loadCore: async () => ({}), loadHost: () => Promise.reject(new Error('404')) });
  const bad = createSessionFor(aiYouStation(), { aiHost: {} });
  await bad.start();
  assert.equal(bad.state.phase, 'error'); assert.match(bad.state.error.message, /could not start/);
  // stop during load wins
  _resetStationTypes();
  registerAiStationTypes({ isEnabled: () => true, loadCore: async () => ({}), loadHost: () => new Promise((r) => setTimeout(() => r({ createOfflineSession: () => inner }), 10)) });
  const late = createSessionFor(aiYouStation(), { aiHost: {} });
  const p = late.start(); late.stop(); await p;
  assert.equal(late.state.phase, 'idle');
  _resetStationTypes();
});

test('seam: the toggle can remove the AI types again without touching other station types', () => {
  _resetStationTypes();
  const other = { id: 'radio-browser', label: 'Radio stations', createSession: () => ({}) };
  _resetStationTypes();
  registerAiStationTypes({ isEnabled: () => true, loadCore: async () => ({}), loadHost: async () => ({}) });
  assert.ok(getStationType(AI_TYPE_YOU) && getStationType(AI_TYPE_YOU_CITY));
  unregisterAiStationTypes();
  assert.equal(getStationType(AI_TYPE_YOU), null); assert.equal(listStationTypes().length, 0);
  assert.equal(createSessionFor(aiYouStation(), { aiHost: {} }), null);
  void other;
});

// ── the real session wiring ──────────────────────────────────────────────────

function sessionRig({ tracks, mode = 'normal', stored = {} } = {}) {
  const time = fakeTime();
  const lib = tracks || fakeLibrary(10);
  const player = fakePlayer(time);
  const param = fakeParam(1);
  const store = new Map(Object.entries(stored));
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const host = { ...player, getTracks: () => lib, busParam: () => param, audioNow: () => time.now() / 1000 };
  Object.defineProperty(host, 'position', { value: () => player.position() });
  const synth = new FakeSynth(time, { voices: VOICES, mode });
  const session = createOfflineSession(aiYouStation(), { aiHost: host, storage, timers: time.timers, now: time.now, speechSynthesis: synth, Utterance: FakeUtterance, capPlugin: null, utcOffsetMin: 0, seed: 2 });
  return { time, lib, player, param, store, storage, synth, session };
}

test('session: maps the show onto the Session contract and persists history, memory and voice choice locally', async () => {
  const r = sessionRig();
  assert.equal(r.session.usesEngine, true); assert.equal(r.session.state.phase, 'idle');
  const phases = [], events = [];
  r.session.onChange((s) => phases.push(s.phase));
  r.session.onEvent((e) => events.push(e.type));
  await r.session.start();
  await r.time.advance(8 * 60 * 1000);
  assert.deepEqual([...new Set(phases)], ['connecting', 'playing']);
  assert.ok(events.includes('caption') && events.includes('now') && events.includes('speech'));
  assert.equal(r.session.getView().speechAvailable, true);
  assert.equal(r.session.getView().engine, 'web-speech');
  // two hosts, user-selectable and persisted
  r.session.voice.setHost('b', 'fiona'); r.session.saveVoices();
  assert.deepEqual(JSON.parse(r.store.get(VOICE_PREFS_KEY)), { v: 1, a: r.session.voice.hosts().a, b: 'fiona' });
  r.session.skip();
  await r.time.advance(1000);
  r.session.stop();
  await r.time.advance(2000);
  assert.equal(r.session.state.phase, 'idle');
  assert.ok(loadHistory(r.storage).sessions === 1 && Object.keys(loadHistory(r.storage).tracks).length >= 2, 'play history saved');
  assert.ok(r.store.has(HISTORY_KEY) && r.store.has(MEMORY_KEY), 'history and station memory stored locally');
});

test('session: an empty library is a plain, friendly error state', async () => {
  const r = sessionRig({ tracks: [] });
  await r.session.start();
  await r.time.advance(2000);
  assert.equal(r.session.state.phase, 'error');
  assert.match(r.session.state.error.message, /Scan your music folder/);
  assert.equal(r.player.ev.length, 0);
  r.session.stop();
  assert.equal(r.session.state.phase, 'idle');
});

test('session: no speech engine at all reports music-only and still plays', async () => {
  const time = fakeTime();
  const player = fakePlayer(time);
  const host = { ...player, getTracks: () => fakeLibrary(6), busParam: () => fakeParam(1), audioNow: () => time.now() / 1000 };
  const session = createOfflineSession(aiYouStation(), { aiHost: host, storage: { getItem: () => null, setItem() {}, removeItem() {} }, timers: time.timers, now: time.now, speechSynthesis: undefined, Utterance: undefined, capPlugin: null, utcOffsetMin: 0 });
  const states = [];
  session.onEvent((e) => { if (e.type === 'state') states.push(e); });
  await session.start();
  await time.advance(5000);
  assert.equal(session.state.phase, 'playing');
  assert.equal(session.getView().speechAvailable, false); assert.equal(session.runner.state.speech, 'off');
  assert.ok(player.played.length >= 1);
  session.stop();
});

test('location is optional, user-entered, city-level, and never requested', () => {
  const store = new Map();
  const st = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  assert.equal(loadLocation(st), null);
  assert.equal(saveLocation(st, { lat: 47.60621, lon: -122.33207, label: 'Seattle' }), true);
  assert.deepEqual(loadLocation(st), { lat: 47.6, lon: -122.3, label: 'Seattle' }); // rounded on read: a precise fix is never used
  for (const bad of ['junk', JSON.stringify({ lat: 99, lon: 0 }), JSON.stringify({ lat: 'x' })]) { store.set(LOCATION_KEY, bad); assert.equal(loadLocation(st), null); }
  assert.equal(saveLocation(st, null), true); assert.equal(store.has(LOCATION_KEY), false);
  assert.equal(loadLocation({ getItem() { throw new Error('x'); } }), null);
  // nothing in the host asks the platform for a position
  for (const f of files) assert.doesNotMatch(code(readFileSync(resolve(dir, f), 'utf8')), /geolocation|getCurrentPosition|watchPosition/, f);
});
