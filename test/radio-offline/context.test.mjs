import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfflineContext, daypartFor, localParts, localISO, energyFromGenre, makeTrackFact } from '../../src/radio/offline/context.js';
import { sunTimes, season, clockText } from '../../src/radio/offline/sun.js';
import { holidayOn, FIXED_HOLIDAYS } from '../../src/radio/offline/holidays.js';
import { emptyHistory, recordPlay, parseHistory, serializeHistory, loadHistory, saveHistory, mostPlayed, lastPlayedAgoSec, MAX_TRACKS, RECENT_MAX, HISTORY_KEY, recordSession, totalPlays } from '../../src/radio/offline/play-history.js';
import { validateContextSnapshot } from '../../src/radio/core/schemas.js';
import { verifyScript, forbiddenTopics } from '../../src/radio/core/grounding.js';
import { fakeLibrary } from './helpers.mjs';

const T = (iso) => Date.parse(iso);

test('daypart boundaries (local hour)', () => {
  const m = { 3: 'late_night', 4: 'early_morning', 6: 'early_morning', 7: 'morning', 10: 'morning', 11: 'midday', 13: 'midday', 14: 'afternoon', 17: 'afternoon', 18: 'evening', 21: 'evening', 22: 'late_night', 23: 'late_night', 0: 'late_night' };
  for (const [h, d] of Object.entries(m)) assert.equal(daypartFor(Number(h)), d, `hour ${h}`);
  assert.equal(daypartFor(24), 'late_night'); assert.equal(daypartFor(-1), 'late_night'); assert.equal(daypartFor(5.9), 'early_morning');
});

test('local parts and ISO honour the zone offset, across midnight and the year', () => {
  const p = localParts(T('2026-12-31T23:30:00Z'), 60);
  assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute], [2027, 1, 1, 0, 30]);
  assert.equal(p.weekday, 'Friday');
  assert.equal(localISO(T('2026-11-04T18:05:00Z'), -480), '2026-11-04T10:05:00-08:00');
  assert.equal(localISO(T('2026-11-04T18:05:00Z'), 330), '2026-11-04T23:35:00+05:30');
  assert.equal(localParts(T('2026-11-04T23:59:59Z'), 0).secondsToMidnight, 60); // floor of 60
});

test('sun times: normal latitudes match known values; polar day / night; no location degrades', () => {
  const sea = sunTimes({ lat: 47.6, lon: -122.3, year: 2026, month: 11, day: 4, utcOffsetMin: -480 });
  assert.equal(sea.kind, 'normal');
  assert.ok(Math.abs(sea.sunriseMin - (6 * 60 + 56)) <= 3, clockText(sea.sunriseMin));
  assert.ok(Math.abs(sea.sunsetMin - (16 * 60 + 49)) <= 3, clockText(sea.sunsetMin));
  const lon = sunTimes({ lat: 51.5, lon: -0.12, year: 2026, month: 3, day: 21, utcOffsetMin: 0 });
  assert.ok(Math.abs(lon.sunriseMin - 363) <= 4 && Math.abs(lon.sunsetMin - 1093) <= 4);
  assert.equal(sunTimes({ lat: 78.2, lon: 15.6, year: 2026, month: 6, day: 21 }).kind, 'polar_day');
  assert.equal(sunTimes({ lat: 78.2, lon: 15.6, year: 2026, month: 12, day: 21 }).kind, 'polar_night');
  assert.equal(sunTimes({ lat: -78, lon: 0, year: 2026, month: 12, day: 21 }).kind, 'polar_day'); // southern summer
  assert.equal(sunTimes({ lat: 0, lon: 0, year: 2026, month: 3, day: 20, utcOffsetMin: 0 }).kind, 'normal');
  for (const bad of [undefined, {}, { lat: 'x', lon: 1, year: 2026, month: 1, day: 1 }, { lat: 91, lon: 0, year: 2026, month: 1, day: 1 }, { lat: 0, lon: 181, year: 2026, month: 1, day: 1 }, { lat: 0, lon: 0, year: 2026, month: 13, day: 1 }, { lat: NaN, lon: 0, year: 2026, month: 1, day: 1 }]) {
    assert.equal(sunTimes(bad).kind, 'none');
  }
  assert.equal(clockText(0), '12:00 am'); assert.equal(clockText(12 * 60), '12:00 pm'); assert.equal(clockText(16 * 60 + 49), '4:49 pm');
});

test('season depends on hemisphere and is null near the equator or without a latitude', () => {
  assert.equal(season({ lat: 47, month: 7, day: 1 }), 'summer'); assert.equal(season({ lat: -33, month: 7, day: 1 }), 'winter');
  assert.equal(season({ lat: 47, month: 12, day: 21 }), 'winter'); assert.equal(season({ lat: 47, month: 12, day: 20 }), 'autumn');
  assert.equal(season({ lat: 47, month: 3, day: 20 }), 'spring'); assert.equal(season({ lat: 47, month: 3, day: 19 }), 'winter');
  assert.equal(season({ lat: 5, month: 7, day: 1 }), null); assert.equal(season({ month: 7, day: 1 }), null); assert.equal(season({ lat: 40, month: 0 }), null);
});

test('holidays: fixed table only, other days are null', () => {
  assert.equal(holidayOn(12, 25).name, 'Christmas Day'); assert.equal(holidayOn(10, 31).greeting, 'Happy Halloween'); assert.equal(holidayOn(1, 1).name, "New Year's Day");
  assert.equal(holidayOn(7, 4), null); assert.equal(holidayOn(2, 29), null); assert.equal(holidayOn(0, 0), null);
  assert.ok(FIXED_HOLIDAYS.length >= 5);
});

const NOW = T('2026-11-04T18:05:00Z');
const mk = (o = {}) => createOfflineContext({ getTracks: () => fakeLibrary(12), utcOffsetMin: -480, tzName: 'America/Los_Angeles', ...o });

test('snapshot is valid, offline-only, and forbids weather / traffic talk', async () => {
  const s = await mk().getSnapshot({ nowMs: NOW });
  assert.deepEqual(validateContextSnapshot(s), { ok: true, errors: [] });
  assert.equal(s.time.daypart, 'morning'); assert.equal(s.time.weekday, 'Wednesday'); assert.equal(s.time.tz, 'America/Los_Angeles');
  assert.deepEqual(s.serviceStatus, { weather: 'down', traffic: 'down', place: 'down' });
  assert.deepEqual(forbiddenTopics(s), ['place', 'traffic', 'weather']);
  assert.equal(s.facts.some((f) => ['weather', 'forecast', 'traffic', 'place'].includes(f.kind)), false);
  assert.equal(s.place, null);
  // weather talk is rejected by the verifier
  const bad = { schemaVersion: 1, slotId: 'x', utterances: [{ id: 'u', text: 'It is raining out there.', style: { emotion: 'warm', energy: 0.5, pace: 1 }, factRefs: [] }] };
  assert.equal(verifyScript(bad, s, { atMs: NOW }).ok, false);
});

test('no location: no sun, season or place facts, and nothing is requested', async () => {
  let asked = 0;
  const s = await mk({ getLocation: () => { asked++; return null; } }).getSnapshot({ nowMs: NOW });
  assert.equal(asked, 1);
  assert.deepEqual(s.facts.filter((f) => ['sun', 'custom'].includes(f.kind) && f.id !== 'time.weekday'), []);
  assert.equal(s.facts.some((f) => f.id.startsWith('sun.') || f.id === 'season.now'), false);
});

test('with a user-entered city: sun facts, season, tense follows the clock; polar days handled', async () => {
  const loc = { lat: 47.6, lon: -122.3, label: 'Seattle' };
  const morning = await mk({ getLocation: () => loc }).getSnapshot({ nowMs: NOW }); // 10:05 local
  const ids = (s) => Object.fromEntries(s.facts.map((f) => [f.id, f]));
  assert.match(ids(morning)['sun.rise'].say, /^sunrise was at 6:5\d am today$/);
  assert.match(ids(morning)['sun.set'].say, /^sunset is at 4:4\d pm today$/);
  assert.equal(ids(morning)['season.now'].value.season, 'autumn');
  assert.equal(morning.place.label, 'Seattle');
  const night = await mk({ getLocation: () => loc }).getSnapshot({ nowMs: T('2026-11-05T05:30:00Z') }); // 21:30 local
  assert.match(ids(night)['sun.set'].say, /^sunset was at/);
  const arctic = await mk({ getLocation: () => ({ lat: 78.2, lon: 15.6 }), utcOffsetMin: 120 }).getSnapshot({ nowMs: T('2026-06-21T10:00:00Z') });
  assert.equal(ids(arctic)['sun.polar'].say, 'the sun does not set today');
  assert.equal(ids(arctic)['sun.rise'], undefined);
  const dark = await mk({ getLocation: () => ({ lat: 78.2, lon: 15.6 }), utcOffsetMin: 60 }).getSnapshot({ nowMs: T('2026-12-21T10:00:00Z') });
  assert.equal(ids(dark)['sun.polar'].say, 'the sun does not rise today');
  for (const s of [morning, night, arctic, dark]) assert.deepEqual(validateContextSnapshot(s), { ok: true, errors: [] });
  // a malformed location is ignored, never thrown on
  const odd = await mk({ getLocation: () => ({ lat: 'x', lon: null }) }).getSnapshot({ nowMs: NOW });
  assert.equal(odd.facts.some((f) => f.id.startsWith('sun.')), false);
  const thrower = await mk({ getLocation: () => { throw new Error('boom'); } }).getSnapshot({ nowMs: NOW });
  assert.ok(thrower.facts.length);
});

test('holiday and midnight edge cases', async () => {
  const xmas = await mk().getSnapshot({ nowMs: T('2026-12-25T20:00:00Z') });
  assert.equal(xmas.time.holiday, 'Christmas Day');
  const f = xmas.facts.find((x) => x.id === 'holiday.today');
  assert.equal(f.kind, 'holiday'); assert.ok(f.ttlSec <= 86400 && f.ttlSec >= 60);
  const eve = await mk({ utcOffsetMin: 0 }).getSnapshot({ nowMs: T('2026-12-31T23:59:30Z') });
  assert.equal(eve.time.holiday, "New Year's Eve");
  assert.equal(eve.facts.find((x) => x.id === 'time.weekday').ttlSec, 60); // expires right at midnight
  assert.equal(eve.time.daypart, 'late_night');
  const none = await mk().getSnapshot({ nowMs: NOW });
  assert.equal(none.time.holiday, null); assert.equal(none.facts.some((x) => x.id === 'holiday.today'), false);
});

test('library facts come from the owner’s own metadata; relink-only tracks are never candidates', async () => {
  const tracks = [...fakeLibrary(14), { id: 'gone', title: 'Needs relink', artist: 'X', album: 'Y', relink: true, file: null }];
  const s = await mk({ getTracks: () => tracks }).getSnapshot({ nowMs: NOW });
  const f = Object.fromEntries(s.facts.map((x) => [x.id, x]));
  assert.equal(f['lib.counts'].value.tracks, 14);
  assert.equal(f['lib.counts'].value.albums, new Set(tracks.filter((t) => t.file).map((t) => `${t.artist}|${t.album}`)).size); // albums counted by artist+album
  assert.equal(f['lib.counts'].value.artists, 5);
  assert.ok(f['lib.recent']); assert.ok(f['lib.artist'] && f['lib.artist'].value.tracks >= 3); assert.ok(f['lib.genre']);
  assert.equal(s.libraryDigest.candidates.some((c) => c.trackId === 'gone'), false);
  assert.equal(s.libraryDigest.candidates.length, 14);
  for (const c of s.libraryDigest.candidates) { assert.ok(c.title && c.artist); assert.ok(c.title.length <= 120); }
  // facts are mentionable and carry every field
  for (const x of s.facts) { assert.equal(x.mentionable, true); assert.ok(x.say && x.source && x.asOf && Number.isInteger(x.ttlSec)); }
});

test('shortlist: at most 60, seeded and stable, excludes played tracks, handles empty / hostile libraries', async () => {
  const big = fakeLibrary(300);
  const c = mk({ getTracks: () => big });
  const a = await c.getSnapshot({ nowMs: NOW, seed: 5 }), b = await c.getSnapshot({ nowMs: NOW, seed: 5 }), d = await c.getSnapshot({ nowMs: NOW, seed: 6 });
  assert.equal(a.libraryDigest.candidates.length, 60);
  assert.deepEqual(a.libraryDigest.candidates.map((x) => x.trackId), b.libraryDigest.candidates.map((x) => x.trackId));
  assert.notDeepEqual(a.libraryDigest.candidates.map((x) => x.trackId), d.libraryDigest.candidates.map((x) => x.trackId));
  const ex = a.libraryDigest.candidates.slice(0, 10).map((x) => x.trackId);
  const e = await c.getSnapshot({ nowMs: NOW, seed: 5, excludeTrackIds: ex });
  assert.equal(e.libraryDigest.candidates.some((x) => ex.includes(x.trackId)), false);
  assert.deepEqual(e.libraryDigest.excludeTrackIds, ex);
  const empty = await mk({ getTracks: () => [] }).getSnapshot({ nowMs: NOW });
  assert.deepEqual(empty.libraryDigest.candidates, []); assert.equal(empty.facts.some((x) => x.id.startsWith('lib.')), false);
  assert.deepEqual(validateContextSnapshot(empty), { ok: true, errors: [] });
  const hostile = [{ id: 'h1', title: '<script>\u0000'.repeat(40), artist: 'a'.repeat(500), album: '', genre: '"; DROP', file: {} }, { id: 'h1', title: 'dup', artist: 'b', file: {} }, null, { id: '', title: 'x', file: {} }];
  const h = await mk({ getTracks: () => hostile }).getSnapshot({ nowMs: NOW });
  assert.deepEqual(validateContextSnapshot(h), { ok: true, errors: [] });
  assert.equal(h.libraryDigest.candidates.length, 1);
  const throwing = await mk({ getTracks: () => { throw new Error('x'); } }).getSnapshot({ nowMs: NOW });
  assert.deepEqual(throwing.libraryDigest.candidates, []);
});

test('genre -> energy heuristic is conservative', () => {
  assert.equal(energyFromGenre('Ambient'), 0.25); assert.equal(energyFromGenre('Hard Rock'), 0.8); assert.equal(energyFromGenre('Jazz'), 0.5);
  assert.equal(energyFromGenre(''), null); assert.equal(energyFromGenre('Podcast'), null); assert.equal(energyFromGenre(undefined), null);
});

test('track facts: cleaned names, never the raw file-name cruft', () => {
  const f = makeTrackFact('next', { id: 'x', title: '03 - Blue_Sky [Remastered].mp3', artist: 'Unknown Artist', album: '' }, '2026-11-04T18:05:00.000Z');
  assert.equal(f.id, 'trk.next'); assert.equal(f.value.title, 'Blue Sky'); assert.equal(f.value.artist, null); assert.equal(f.say, 'Blue Sky');
  const g = makeTrackFact('prev', { id: 'y', title: 'Track 04', artist: 'Mara Quill' }, '2026-11-04T18:05:00.000Z');
  assert.equal(g.value.title, null); assert.equal(g.say, 'a track by Mara Quill');
});

// ── play history ─────────────────────────────────────────────────────────────

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

test('history: records, counts, caps, versions, and never throws on bad data', () => {
  let h = emptyHistory();
  h = recordPlay(h, 'a', 1000); h = recordPlay(h, 'a', 2000); h = recordPlay(h, 'b', 3000);
  assert.equal(totalPlays(h), 3); assert.equal(h.tracks.a.n, 2); assert.equal(lastPlayedAgoSec(h, 'a', 5000), 3); assert.equal(lastPlayedAgoSec(h, 'zz', 5000), null);
  assert.deepEqual(mostPlayed(h, 3, 2), [{ id: 'a', n: 2 }]);
  assert.deepEqual(h.recent, ['a', 'a', 'b']);
  assert.equal(recordPlay(h, '', 1), h); assert.equal(recordPlay(h, 'x', NaN), h);
  // cap: least recently played evicted
  let big = emptyHistory();
  for (let i = 0; i < MAX_TRACKS + 25; i++) big = recordPlay(big, `id${i}`, i);
  assert.equal(Object.keys(big.tracks).length, MAX_TRACKS);
  assert.equal(big.tracks.id0, undefined); assert.ok(big.tracks[`id${MAX_TRACKS + 24}`]);
  assert.equal(big.recent.length, RECENT_MAX);
  // round trip
  assert.deepEqual(parseHistory(serializeHistory(h)), h);
  for (const junk of [null, undefined, '', 'not json', '{"v":2,"tracks":{}}', '{"v":1}', '{"v":1,"tracks":{"a":{"n":-1,"last":1}}}', '[]', '{"v":1,"tracks":{"a":{"n":1,"last":"x"}},"recent":[1,2]}', 42]) {
    const p = parseHistory(junk);
    assert.equal(p.v, 1); assert.equal(typeof p.tracks, 'object');
  }
  assert.equal(recordSession(h).sessions, 1);
});

test('history storage: versioned key, blocked storage means empty, never throws', () => {
  const s = mem();
  let h = recordPlay(emptyHistory(), 'a', 5);
  assert.equal(saveHistory(s, h), true);
  assert.ok(s.m.get(HISTORY_KEY));
  assert.deepEqual(loadHistory(s), h);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(saveHistory(blocked, h), false); assert.deepEqual(loadHistory(blocked), emptyHistory()); assert.deepEqual(loadHistory(null), emptyHistory());
});

test('history feeds "you" facts: first time, totals and most played', async () => {
  let h = emptyHistory();
  const lib = fakeLibrary(12);
  const c = mk({ getTracks: () => lib, getHistory: () => h });
  let s = await c.getSnapshot({ nowMs: NOW });
  assert.ok(s.facts.find((f) => f.id === 'hist.first'));
  for (let i = 0; i < 4; i++) h = recordPlay(h, 't003', NOW - 1000 * (10 - i));
  for (let i = 0; i < 7; i++) h = recordPlay(h, `t00${4 + (i % 4)}`, NOW - 1000 * i);
  s = await c.getSnapshot({ nowMs: NOW });
  const f = Object.fromEntries(s.facts.map((x) => [x.id, x]));
  assert.equal(f['hist.first'], undefined);
  assert.equal(f['hist.total'].value.plays, 11);
  assert.equal(f['hist.top'].value.plays, 4); assert.match(f['hist.top'].say, /^you have played Song Charlie 3 by .* 4 times$/);
  const cand = s.libraryDigest.candidates.find((x) => x.trackId === 't003');
  assert.equal(cand.playCount, 4); assert.ok(cand.lastPlayedAgoSec >= 0);
});
