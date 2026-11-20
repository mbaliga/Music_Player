// library-fields.test.mjs — year / added / genre / exact durations reach the tracks both library sources produce, so the suggested tapes
// ('Fresh Finds', 'The 1990s', genre tapes) and the search adapters work on real data, not only on test fixtures (Workstream I).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapRow, fromStored, toStored } from '../src/device/records.js';
import { snapshotTrack, restoreTrack, serializeIndex, parseIndex } from '../src/libindex.js';
import { folderTrackFields, yearOf, addedMs } from '../src/library-model.js';
import { suggestTapes } from '../src/mixtape-suggest.js';
import { buildIndex as searchBuild } from '../src/search/index.js';
import { adaptLibrary } from '../src/search/adapters.js';

const T0 = Date.UTC(2026, 5, 1);
const deviceRows = (n, base = 0) => Array.from({ length: n }, (_, i) => ({ id: base + i + 1, name: `t${i}.mp3`, title: `Dev ${base + i}`, artist: 'Dev Artist', album: 'Dev Album', genre: 'Jazz', year: 1994,
  durationMs: 201500 + i, size: 4_000_000 + i, modified: Math.floor(T0 / 1000) + i * 60, relativePath: 'Music/Dev/' }));
const folderTracks = (n) => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, title: `Fold ${i}`, artist: 'Fold Artist', album: 'Fold Album', genre: 'Rock', trackNo: i + 1, durationSec: 180 + i,
  file: { lastModified: T0 - i * 3600_000 }, ...folderTrackFields({ year: 1996 }, { lastModified: T0 - i * 3600_000 }) }));

test('helpers: year and added are validated, units explicit', () => {
  assert.equal(yearOf('1994'), 1994); assert.equal(yearOf(0), 0); assert.equal(yearOf(99999), 0); assert.equal(yearOf(undefined), 0);
  assert.equal(addedMs(1700000000, 's'), 1700000000000); assert.equal(addedMs(1700000000000), 1700000000000); assert.equal(addedMs(-1), 0); assert.equal(addedMs('x'), 0);
  assert.deepEqual(folderTrackFields({ year: 2001 }, { lastModified: 5000 }), { year: 2001, added: 5000 });
  assert.deepEqual(folderTrackFields(null, null), { year: 0, added: 0 });
});

test('device rows carry year, genre, exact duration and added (ms) in the same shape as folder tracks', () => {
  const t = mapRow(deviceRows(1)[0]);
  assert.equal(t.year, 1994); assert.equal(t.genre, 'Jazz'); assert.equal(t.durationSec, 201.5);
  assert.equal(t.added, (Math.floor(T0 / 1000)) * 1000);
  const back = fromStored(JSON.parse(JSON.stringify(toStored(t))));
  assert.equal(back.added, t.added); assert.equal(back.year, 1994);
  const old = fromStored({ ...JSON.parse(JSON.stringify(toStored(t))), added: undefined });
  assert.equal(old.added, t.added, 'rows stored before `added` existed get it from modified');
});

test('folder tracks keep year / added / genre / duration through the persisted index', () => {
  const live = folderTracks(3);
  const doc = JSON.parse(JSON.stringify(serializeIndex(live, 1)));
  const back = parseIndex(doc);
  assert.equal(back.length, 3);
  assert.equal(back[0].year, 1996); assert.equal(back[0].added, T0); assert.equal(back[1].added, T0 - 3600_000); assert.equal(back[0].genre, 'Rock'); assert.equal(back[2].durationSec, 182);
  const rec = snapshotTrack({ ...live[0], year: 'x', added: -3 });
  assert.equal(rec.year, undefined); assert.equal(rec.added, undefined);
  assert.equal(restoreTrack(snapshotTrack({ ...live[0], year: undefined })).year, undefined);
});

for (const [name, mk] of [['device-shaped', () => deviceRows(12).map((r) => mapRow(r))], ['folder-shaped', () => folderTracks(12)],
  ['restored folder (no File, from the index)', () => parseIndex(JSON.parse(JSON.stringify(serializeIndex(folderTracks(12), 1))))]]) {
  test(`suggested tapes work on ${name} tracks: Fresh Finds (newest first) and the decade tape`, () => {
    const lib = mk();
    const s = suggestTapes(lib, {});
    const kinds = s.map((d) => d.kind);
    assert.ok(kinds.includes('recent'), 'Fresh Finds exists: ' + kinds);
    assert.ok(kinds.includes('decade'), 'decade tape exists: ' + kinds);
    assert.ok(kinds.includes('genre'), 'genre tape exists: ' + kinds);
    const recent = s.find((d) => d.kind === 'recent');
    const addedOf = (t) => Number(t.added) || Number(t.file && t.file.lastModified) || 0;
    const a = recent.tracks.map(addedOf); assert.deepEqual(a, a.slice().sort((x, y) => y - x), 'newest first');
    assert.match(s.find((d) => d.kind === 'decade').name, /The 199\d?0s|The 1990s/);
  });
}

test('a library with no dates / years offers no Fresh Finds or decade tape (never throws)', () => {
  const lib = deviceRows(12).map((r) => ({ ...r, modified: 0, year: 0 })).map((r) => mapRow(r));
  const kinds = suggestTapes(lib, {}).map((d) => d.kind);
  assert.ok(!kinds.includes('recent') && !kinds.includes('decade'));
});

test('the search adapter reads the very same track objects (raw kept: year / added / duration reachable), genre searchable for both sources', () => {
  const lib = [...deviceRows(4).map((r) => mapRow(r)), ...folderTracks(4)];
  const { data, lookup } = adaptLibrary({ tracks: lib });
  assert.equal(data.tracks.length, 8);
  assert.ok(data.tracks.every((r, i) => lookup.track(r.id) && lookup.track(r.id).raw === lib[i]), 'the lookup answers with the library track objects');
  assert.deepEqual([...new Set(data.tracks.map((r) => r.genre))].sort(), ['Jazz', 'Rock']);
  const r0 = lookup.track(data.tracks[0].id).raw, r4 = lookup.track(data.tracks[4].id).raw;
  assert.ok(r0.year === 1994 && r4.year === 1996 && r0.added > 0 && r4.added > 0 && r0.durationSec > 200);
  const ix = searchBuild(data);
  assert.ok(ix);
});
