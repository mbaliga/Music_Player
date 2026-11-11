import test from 'node:test';
import assert from 'node:assert/strict';
import { pickTrack, planSongs, resolveRequest } from '../../src/radio/core/song-select.js';
import { repairRundown, rundownProblems, horizonOf, STANDALONE_TALK } from '../../src/radio/core/director-client.js';
import { validateRundown } from '../../src/radio/core/schemas.js';
import { snapshotFixture, goldenRundown, makeLibrary, FIXTURE_NOW_MS } from '../../src/radio/core/fixtures.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const lib = makeLibrary(20);
const songs = (n) => Array.from({ length: n }, (_, i) => ({ slotId: `s${i}`, kind: 'song', targetSec: 200, song: { constraints: { energy: 0.5 } } }));
const codes = (r) => r.repairs.map((x) => x.code);

test('song selection is deterministic for a seed and varies across seeds', () => {
  const a = planSongs(songs(10), lib, { seed: 42 });
  const b = planSongs(songs(10), lib, { seed: 42 });
  assert.deepEqual([...a.picks], [...b.picks]);
  const c = planSongs(songs(10), lib, { seed: 43 });
  assert.notDeepEqual([...a.picks.values()], [...c.picks.values()]);
});

test('no repeats within a show, exclusions honoured, exhaustion reported', () => {
  const small = makeLibrary(5, 3);
  const { picks } = planSongs(songs(8), small, { seed: 1, state: { excludeIds: ['t001'] } });
  const ids = [...picks.values()].filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!ids.includes('t001'));
  assert.equal(ids.length, 4);
  assert.equal(picks.get('s7'), null);
  assert.equal(pickTrack({ candidates: [], seed: 1 }).reason, 'empty');
  assert.equal(pickTrack({ candidates: small, state: { playedIds: small.map((t) => t.trackId) } }).reason, 'exhausted');
});

test('constraints steer the choice; a valid hint wins; an invented hint is ignored', () => {
  const r = pickTrack({ candidates: lib, constraints: { artistsAnyOf: ['Mara Quill'] }, seed: 9, slotKey: 'x' });
  assert.equal(lib.find((t) => t.trackId === r.trackId).artist, 'Mara Quill');
  assert.deepEqual(pickTrack({ candidates: lib, hint: 't007', seed: 1 }), { trackId: 't007', reason: 'hint' });
  const bad = pickTrack({ candidates: lib, hint: 'does-not-exist', seed: 1 });
  assert.ok(lib.some((t) => t.trackId === bad.trackId));
  assert.equal(bad.reason, 'scored');
  // never the same artist back to back when avoidable
  const { picks } = planSongs(songs(6), lib, { seed: 5 });
  const artists = [...picks.values()].map((id) => lib.find((t) => t.trackId === id).artist);
  artists.forEach((a, i) => { if (i) assert.notEqual(a, artists[i - 1]); });
});

test('requests resolve only against the library', () => {
  const l = [{ trackId: 'a', title: 'Slow Harbor', artist: 'Mara Quill' }, { trackId: 'b', title: 'Copper Window', artist: 'June Parlor' }];
  assert.deepEqual(resolveRequest('slow harbor', l), { trackId: 'a', confidence: 'exact' });
  assert.deepEqual(resolveRequest('can you play Copper Window please', l), { trackId: 'b', confidence: 'title' });
  assert.deepEqual(resolveRequest('something by june parlor', l), { trackId: 'b', confidence: 'artist' });
  assert.equal(resolveRequest('stairway to heaven', l), null);
  assert.equal(resolveRequest('', l), null);
  assert.equal(resolveRequest('slow harbor', l, { excludeIds: ['a'] }), null);
});

test('golden rundown passes every property and repairs to itself', () => {
  const snap = snapshotFixture();
  const g = goldenRundown();
  assert.deepEqual(rundownProblems(g, snap), []);
  const r = repairRundown(g, { snapshot: snap, atMs: FIXTURE_NOW_MS });
  assert.equal(r.ok, true);
  assert.deepEqual(r.repairs, []);
  assert.deepEqual(r.rundown.slots.map((s) => [s.slotId, s.kind, s.targetSec]), g.slots.map((s) => [s.slotId, s.kind, s.targetSec]));
  assert.equal(r.rundown.horizonSec, g.horizonSec);
});

test('repair: unknown/repeated hints dropped, durations from tracks, arithmetic recomputed', () => {
  const snap = snapshotFixture();
  const raw = goldenRundown();
  raw.horizonSec = 99999;
  raw.slots[1].song.trackIdHint = 'invented-track';
  raw.slots[3].song = { constraints: {}, trackIdHint: 't002' };
  raw.slots[5].song = { constraints: {}, trackIdHint: 't002' }; // repeat
  raw.slots[6].targetSec = -5; raw.slots[6].song.trackIdHint = null;
  raw.slots[4].targetSec = 'ten';
  const r = repairRundown(raw, { snapshot: snap, atMs: FIXTURE_NOW_MS });
  assert.equal(r.ok, true);
  assert.equal(r.rundown.slots[1].song.trackIdHint, null);
  assert.equal(r.rundown.slots[5].song.trackIdHint, null);
  const t2 = lib.find((t) => t.trackId === 't002');
  assert.equal(r.rundown.slots[3].targetSec, t2.durationSec);
  assert.equal(r.rundown.slots[6].targetSec, 60);
  assert.equal(r.rundown.horizonSec, horizonOf(r.rundown.slots));
  assert.notEqual(r.rundown.horizonSec, 99999);
  for (const c of ['drop_unknown_hint', 'drop_repeat_hint', 'fix_horizon', 'song_duration_from_track', 'clamp_duration']) assert.ok(codes(r).includes(c), c);
  assert.deepEqual(rundownProblems(r.rundown, snap), []);
  assert.deepEqual(clone(raw).slots[1].song.trackIdHint, 'invented-track'); // input untouched
});

test('repair: adjacent talk breaks split or dropped; callers exempt', () => {
  const snap = snapshotFixture();
  const talk = (id, extra = {}) => ({ slotId: id, kind: 'talk_break', targetSec: 20, talk: { factIds: [], budgetSec: 20 }, ...extra });
  const raw = { schemaVersion: 1, rundownId: 'r', snapshotId: snap.snapshotId, horizonSec: 0, slots: [
    { slotId: 'a', kind: 'song', targetSec: 200 }, talk('b'), talk('c'), talk('d', { skippable: true }),
    { slotId: 'e', kind: 'caller_open', targetSec: 40 }, { slotId: 'f', kind: 'weather_hit', targetSec: 20, talk: { factIds: ['wx.now'] } },
  ] };
  const r = repairRundown(raw, { snapshot: snap, atMs: FIXTURE_NOW_MS });
  assert.equal(r.ok, true);
  const kinds = r.rundown.slots.map((s) => s.kind);
  assert.deepEqual(kinds, ['song', 'talk_break', 'song', 'talk_break', 'caller_open', 'weather_hit']);
  assert.ok(codes(r).includes('insert_song_between_talk') && codes(r).includes('drop_adjacent_talk'));
  assert.deepEqual(rundownProblems(r.rundown, snap), []);
});

test('repair: first slot must be music or a station ID; overlays must precede a song', () => {
  const snap = snapshotFixture();
  const mk = (slots) => ({ schemaVersion: 1, rundownId: 'r', snapshotId: snap.snapshotId, horizonSec: 0, slots });
  let r = repairRundown(mk([{ slotId: 'a', kind: 'talk_break', targetSec: 20 }, { slotId: 'b', kind: 'song', targetSec: 200 }]), { snapshot: snap });
  assert.equal(r.rundown.slots[0].kind, 'station_id');
  assert.notEqual(r.rundown.slots[1].kind, 'talk_break');
  r = repairRundown(mk([{ slotId: 'a', kind: 'song', targetSec: 200 }, { slotId: 'o', kind: 'talk_over_intro', targetSec: 10 }, { slotId: 'x', kind: 'sign_off', targetSec: 10 }]), { snapshot: snap });
  assert.ok(codes(r).includes('overlay_without_song'));
  assert.equal(r.rundown.slots[1].kind, 'talk_break');
  r = repairRundown(mk([{ slotId: 'o', kind: 'talk_over_intro', targetSec: 10 }, { slotId: 'b', kind: 'song', targetSec: 200 }]), { snapshot: snap });
  assert.deepEqual(r.rundown.slots.map((s) => s.kind), ['station_id', 'talk_over_intro', 'song']);
  assert.equal(r.rundown.horizonSec, 6 + 200); // overlay takes no time
});

test('repair: services down turn *_hit into chat; unusable facts are stripped', () => {
  const snap = snapshotFixture('weather-down');
  const raw = { schemaVersion: 1, rundownId: 'r', snapshotId: snap.snapshotId, horizonSec: 0, slots: [
    { slotId: 'a', kind: 'song', targetSec: 200 },
    { slotId: 'w', kind: 'weather_hit', targetSec: 20, talk: { factIds: ['wx.now', 'sun.set', 'ghost'] } },
  ] };
  const r = repairRundown(raw, { snapshot: snap, atMs: FIXTURE_NOW_MS });
  assert.equal(r.rundown.slots[1].kind, 'talk_break');
  assert.deepEqual(r.rundown.slots[1].talk.factIds, ['sun.set']);
  assert.ok(codes(r).includes('service_down_to_chat'));
});

test('repair: hostile or malformed rundowns never throw and fail closed', () => {
  const snap = snapshotFixture();
  const cyc = {}; cyc.self = cyc;
  for (const bad of [null, 5, 'x', [], {}, { schemaVersion: 2, slots: [] }, { schemaVersion: 1, slots: 'no' }, { schemaVersion: 1, slots: [] }, { schemaVersion: 1, slots: [null, 3, { kind: 'rm -rf' }] }, cyc]) {
    const r = repairRundown(bad, { snapshot: snap });
    assert.equal(r.ok, false);
    assert.equal(r.rundown, null);
    assert.ok(r.errors.length > 0);
  }
  const big = { schemaVersion: 1, rundownId: 'r', snapshotId: 's', horizonSec: 1, slots: Array.from({ length: 30 }, (_, i) => ({ slotId: `s${i}`, kind: 'song', targetSec: 100 })) };
  const r = repairRundown(big, { snapshot: snap });
  assert.equal(r.rundown.slots.length, 12);
  assert.equal(validateRundown(r.rundown).ok, true);
  assert.equal(STANDALONE_TALK.includes('caller_open'), false);
});
