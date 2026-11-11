// radio.test.mjs — Radio Browser parsing/selection/fallback (fixtures, fake fetch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FALLBACK_SERVERS, parseServerList, buildServerList, buildSearchUrl, parseStations,
  describeStation, searchStations, discoverServers, classifyPlaybackFailure, reduceSession,
} from '../src/radio.js';
import { registerStationType, getStationType, listStationTypes, createSessionFor, _resetStationTypes } from '../src/stations.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const jazz = fx('radio-search-jazz.json');
const raw = (o = {}) => ({ stationuuid: 'u1', name: 'Good FM', url: 'https://a/x', url_resolved: 'https://a/x', lastcheckok: 1, votes: 5, codec: 'mp3', bitrate: 128, tags: 'jazz,lounge', country: 'Germany', hls: 0, ...o });

test('parseServerList: dedupes IPs of one host, rejects foreign hosts', () => {
  assert.deepEqual(parseServerList(fx('radio-servers.json')), ['de1.api.radio-browser.info']);
  assert.deepEqual(parseServerList([{ name: 'evil.example.com' }, { name: 'x.radio-browser.info.evil.com' }, null, { name: 'FI1.api.radio-browser.info' }]), ['fi1.api.radio-browser.info']);
  assert.deepEqual(parseServerList('nope'), []);
});

test('buildServerList: discovered first, fallbacks appended, never empty, rand shuffles', () => {
  assert.deepEqual(buildServerList([], () => 0), [...FALLBACK_SERVERS]);
  const l = buildServerList(['b.api.radio-browser.info', 'a.api.radio-browser.info'], () => 0);
  assert.equal(new Set(l).size, l.length);
  assert.ok(l.slice(0, 2).every((s) => /^[ab]\./.test(s)));
  assert.ok(FALLBACK_SERVERS.every((s) => l.includes(s)));
  assert.equal(l[0], 'a.api.radio-browser.info'); // rand=0 swaps to a first
});

test('buildSearchUrl: encodes, clamps, always hides broken + orders by votes', () => {
  const u = new URL(buildSearchUrl('de1.api.radio-browser.info', { name: ' lo fi & chill ', tag: 'jazz', countrycode: 'de', limit: 9999, offset: 20 }));
  assert.equal(u.origin, 'https://de1.api.radio-browser.info');
  assert.equal(u.pathname, '/json/stations/search');
  assert.equal(u.searchParams.get('name'), 'lo fi & chill');
  assert.equal(u.searchParams.get('countrycode'), 'DE');
  assert.equal(u.searchParams.get('limit'), '100');
  assert.equal(u.searchParams.get('offset'), '20');
  assert.equal(u.searchParams.get('hidebroken'), 'true');
  assert.equal(u.searchParams.get('order'), 'votes');
  const bare = new URL(buildSearchUrl('h', { countrycode: 'deu' }));
  assert.equal(bare.searchParams.get('countrycode'), null);
  assert.equal(bare.searchParams.get('name'), null);
});

test('parseStations: live fixture parses to usable https stations sorted by votes', () => {
  const { stations } = parseStations(jazz);
  assert.ok(stations.length > 0);
  for (const s of stations) {
    assert.equal(s.type, 'radio-browser');
    assert.match(s.streamUrl, /^https:/);
    assert.ok(s.name && !/^\s|\s$/.test(s.name));
    assert.ok(s.id.startsWith('rb:'));
  }
  for (let i = 1; i < stations.length; i++) assert.ok(stations[i - 1].votes >= stations[i].votes);
});

test('parseStations: filters broken, hls, http, nameless, duplicate; keeps good', () => {
  const { stations, skipped } = parseStations([
    raw(),
    raw({ stationuuid: 'u2', lastcheckok: 0 }),
    raw({ stationuuid: 'u3', hls: 1 }),
    raw({ stationuuid: 'u4', url_resolved: 'http://a/x', url: 'http://a/x' }),
    raw({ stationuuid: 'u5', name: '   ' }),
    raw({ stationuuid: 'u6' }), // same name+url as u1
    raw({ stationuuid: 'u7', url_resolved: 'https://a/pl.m3u8' }),
    raw({ stationuuid: '' }),
    null, 'x', {},
    raw({ stationuuid: 'u8', name: 'Second', url_resolved: '', url: 'https://b/y', votes: 50 }),
  ]);
  assert.deepEqual(stations.map((s) => s.name), ['Second', 'Good FM']); // votes order; url fallback used
  assert.equal(skipped, 10);
  assert.equal(parseStations([raw({ url_resolved: 'http://a/x', url: 'http://a/x' })], { httpsOnly: false }).stations.length, 1);
  assert.equal(parseStations([raw({ hls: 1 })], { allowHls: true }).stations.length, 1);
  assert.deepEqual(parseStations({ not: 'array' }), { stations: [], skipped: 0 });
});

test('describeStation formats compactly', () => {
  const s = parseStations([raw()]).stations[0];
  assert.equal(describeStation(s), 'Germany · MP3 128k · jazz, lounge');
  assert.equal(describeStation({ country: '', codec: '', bitrate: 0, tags: [] }), '');
});

const okRes = (json) => ({ ok: true, status: 200, json: async () => json });

test('searchStations: falls back through servers; reports which answered', async () => {
  const calls = [];
  const f = async (url) => {
    calls.push(new URL(url).host);
    if (calls.length === 1) throw new Error('ECONNREFUSED');
    if (calls.length === 2) return { ok: false, status: 503, json: async () => [] };
    return okRes([raw()]);
  };
  const r = await searchStations(f, ['s1.radio-browser.info', 's2.radio-browser.info', 's3.radio-browser.info'], { name: 'x' });
  assert.equal(r.ok, true);
  assert.equal(r.server, 's3.radio-browser.info');
  assert.equal(r.stations.length, 1);
  assert.deepEqual(calls, ['s1.radio-browser.info', 's2.radio-browser.info', 's3.radio-browser.info']);
});

test('searchStations: all dead -> unreachable w/ trail; offline short-circuits; bad shape fails over', async () => {
  const dead = async () => { throw new Error('boom'); };
  const r = await searchStations(dead, ['a', 'b'], {});
  assert.equal(r.ok, false); assert.equal(r.kind, 'unreachable'); assert.equal(r.tried.length, 2);
  let called = 0;
  const off = await searchStations(async () => { called++; return okRes([]); }, ['a'], {}, { isOnline: () => false });
  assert.equal(off.kind, 'offline'); assert.equal(called, 0);
  const shape = await searchStations(async () => okRes({ error: 1 }), ['a'], {});
  assert.equal(shape.ok, false);
});

test('searchStations: a hung server times out and the next is tried', async () => {
  let n = 0;
  const f = (url, { signal }) => (++n === 1
    ? new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    : Promise.resolve(okRes([raw()])));
  const r = await searchStations(f, ['slow', 'fast'], {}, { timeoutMs: 20 });
  assert.equal(r.ok, true); assert.equal(r.server, 'fast');
});

test('discoverServers: uses discovery, degrades to fallbacks on any failure', async () => {
  const good = await discoverServers(async () => okRes(fx('radio-servers.json')), { rand01: () => 0.5 });
  assert.equal(good[0], 'de1.api.radio-browser.info');
  assert.ok(FALLBACK_SERVERS.every((s) => good.includes(s)));
  assert.deepEqual(await discoverServers(async () => { throw new Error('x'); }, { rand01: () => 0 }), [...FALLBACK_SERVERS]);
  assert.deepEqual(await discoverServers(async () => ({ ok: false, status: 500 })), [...FALLBACK_SERVERS]);
});

test('classifyPlaybackFailure + reduceSession', () => {
  assert.equal(classifyPlaybackFailure({ online: false, mediaErrorCode: 2 }).kind, 'offline');
  assert.equal(classifyPlaybackFailure({ timedOut: true }).kind, 'timeout');
  assert.equal(classifyPlaybackFailure({ mediaErrorCode: 2 }).kind, 'dead');
  assert.equal(classifyPlaybackFailure({ mediaErrorCode: 4 }).kind, 'unsupported');
  assert.equal(classifyPlaybackFailure({ mediaErrorCode: 3 }).kind, 'decode');
  assert.equal(classifyPlaybackFailure().kind, 'unknown');
  let s = { phase: 'idle', error: null };
  s = reduceSession(s, { type: 'play' }); assert.equal(s.phase, 'connecting');
  s = reduceSession(s, { type: 'playing' }); assert.equal(s.phase, 'playing');
  s = reduceSession(s, { type: 'buffering' }); assert.equal(s.phase, 'buffering');
  s = reduceSession(s, { type: 'playing' }); assert.equal(s.phase, 'playing');
  const failure = classifyPlaybackFailure({ mediaErrorCode: 2 });
  s = reduceSession(s, { type: 'error', failure }); assert.deepEqual(s, { phase: 'error', error: failure });
  assert.equal(reduceSession(s, { type: 'playing' }).phase, 'error'); // late event can't resurrect an error
  assert.deepEqual(reduceSession(s, { type: 'stop' }), { phase: 'idle', error: null });
});

test('station-type registry: register, lookup, session creation, validation', () => {
  _resetStationTypes();
  assert.throws(() => registerStationType({ id: 'x' }));
  assert.throws(() => registerStationType(null));
  const made = [];
  registerStationType({ id: 'fake', label: 'Fake', createSession: (st, env) => { made.push([st, env]); return { start() {}, stop() {}, onChange() {} }; } });
  assert.equal(getStationType('fake').label, 'Fake');
  assert.equal(listStationTypes().length, 1);
  assert.ok(createSessionFor({ type: 'fake', id: 'f1', name: 'F' }, { e: 1 }));
  assert.equal(made[0][1].e, 1);
  assert.equal(createSessionFor({ type: 'nope' }, {}), null);
  assert.equal(createSessionFor(null, {}), null);
  _resetStationTypes();
});
