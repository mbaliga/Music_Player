// libindex.test.mjs — persisted library index: ids, snapshot/restore, merge, safety.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  trackId, snapshotTrack, restoreTrack, serializeIndex, parseIndex, mergeScanned, linkSummary, INDEX_VERSION,
} from '../src/libindex.js';

const base = { title: 'Song', artist: 'Band', album: 'LP', trackNo: 2, discNo: 1, size: 4000000, durationSec: 201.2 };

test('trackId: stable, normalised, sensitive to tags/size/duration', () => {
  const id = trackId(base);
  assert.match(id, /^t1-[0-9a-f]{16}$/);
  assert.equal(trackId({ ...base }), id);
  assert.equal(trackId({ ...base, title: '  SONG ', artist: 'band' }), id);
  assert.equal(trackId({ ...base, durationSec: 200.9 }), id); // rounded to the second
  for (const change of [{ title: 'Other' }, { album: 'X' }, { trackNo: 3 }, { discNo: 2 }, { size: 4000001 }, { durationSec: 205 }])
    assert.notEqual(trackId({ ...base, ...change }), id);
  assert.equal(typeof trackId({}), 'string');
});

test('snapshot -> restore: metadata kept, audio/file/cover dropped, marked relink', () => {
  const live = { ...base, albumArtist: 'AA', path: '/m/LP/02.mp3', genre: 'Rock', hue: 120.4, color: '#1a2b3c',
    file: { huge: true }, coverUrl: 'blob:x', id: trackId(base) };
  const rec = snapshotTrack(live);
  assert.equal(rec.file, undefined); assert.equal(rec.coverUrl, undefined);
  assert.equal(rec.hue, 120);
  const back = restoreTrack(rec);
  assert.equal(back.relink, true); assert.equal(back.file, null); assert.equal(back.coverUrl, null);
  assert.equal(back.title, 'Song'); assert.equal(back.trackNo, 2); assert.equal(back.id, live.id);
});

test('serialize/parse round-trip survives JSON, drops junk rows, dedupes ids', () => {
  const tracks = [{ ...base }, { ...base, title: 'Two', trackNo: 3 }, { ...base }];
  const doc = serializeIndex(tracks, 123);
  assert.equal(doc.version, INDEX_VERSION);
  const viaJson = JSON.parse(JSON.stringify(doc));
  viaJson.tracks.push(null, { title: '' }, 5, { nope: 1 });
  const out = parseIndex(viaJson);
  assert.equal(out.length, 2); // dup + junk dropped
  assert.ok(out.every((t) => t.relink && t.file === null));
  assert.deepEqual(parseIndex(JSON.stringify(doc)).map((t) => t.title), ['Song', 'Two']);
});

test('parseIndex never throws on garbage or other versions', () => {
  for (const g of [undefined, null, 0, '', '{', '[]', {}, { version: 1 }, { version: 2, tracks: [] }, { version: 'x', tracks: [] },
    { version: 1, tracks: 'no' }, { version: 1, tracks: [{ title: 'x', hue: 'bad', color: 5, trackNo: -3 }] }]) {
    const r = parseIndex(g);
    assert.ok(Array.isArray(r));
  }
  const odd = parseIndex({ version: 1, tracks: [{ title: 'x', hue: 'bad', color: 5, trackNo: -3 }] })[0];
  assert.equal(odd.hue, 0); assert.equal(odd.trackNo, undefined); assert.match(odd.color, /^#/);
});

test('mergeScanned: a scan replaces the needs-re-link entry with the same id; others append', () => {
  const persisted = parseIndex(serializeIndex([{ ...base }, { ...base, title: 'Gone' }]));
  const scannedSame = { ...base, id: trackId(base), file: { name: 'a' } };
  const scannedNew = { ...base, title: 'New', id: trackId({ ...base, title: 'New' }), file: {} };
  const merged = mergeScanned(persisted, [scannedSame, scannedNew]);
  assert.equal(merged.length, 3);
  assert.equal(merged[0], scannedSame);
  assert.equal(merged[1].relink, true);
  assert.deepEqual(linkSummary(merged), { linked: 2, needsRelink: 1 });
  // a second copy of an already-live file is a duplicate, not a replacement
  assert.equal(mergeScanned(merged, [{ ...scannedSame }]).length, 4);
  assert.equal(persisted.length, 2); // input untouched
});
