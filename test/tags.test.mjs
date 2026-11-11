// tags.test.mjs — tag parsing against generated fixtures (test/support/tagfix.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBytesTags, parseNumberPair } from '../src/tags.js';
import { makeMp3, makeFlac, makeOgg, makeM4a, JPEG, cat } from './support/tagfix.mjs';

const T = { title: 'Song', artist: 'Band', albumArtist: 'Various', album: 'Hits', track: '3/12', disc: '2/2', genre: 'Rock' };

test('parseNumberPair', () => {
  assert.deepEqual(parseNumberPair('3/12'), { n: 3, total: 12 });
  assert.deepEqual(parseNumberPair(' 07 '), { n: 7, total: undefined });
  assert.deepEqual(parseNumberPair('1 of 2'), { n: 1, total: 2 });
  assert.equal(parseNumberPair('0'), null);
  assert.equal(parseNumberPair('abc'), null);
  assert.equal(parseNumberPair(undefined), null);
});

for (const ver of [2, 3, 4]) {
  for (const encoding of ver === 2 ? [0, 1] : [0, 1, 2, 3]) {
    test(`id3v2.${ver} enc ${encoding}: all fields + cover`, async () => {
      const r = await readBytesTags(makeMp3({ ...T, title: encoding === 0 ? 'Song' : 'Sóng ♪', cover: JPEG }, { ver, encoding }));
      assert.equal(r.title, encoding === 0 ? 'Song' : 'Sóng ♪');
      assert.equal(r.artist, 'Band');
      assert.equal(r.albumArtist, 'Various');
      assert.equal(r.album, 'Hits');
      assert.equal(r.genre, 'Rock');
      assert.equal(r.trackNo, 3); assert.equal(r.trackTotal, 12);
      assert.equal(r.discNo, 2); assert.equal(r.discTotal, 2);
      assert.equal(r.cover.mime, 'image/jpeg');
      assert.deepEqual([...r.cover.data], [...JPEG]);
    });
  }
}

test('id3: numeric genre, bare track number, no disc, unsync tag', async () => {
  const r = await readBytesTags(makeMp3({ title: 'A', track: '07', genre: '(17)Whatever' }));
  assert.equal(r.trackNo, 7); assert.equal(r.trackTotal, undefined); assert.equal(r.discNo, undefined);
  assert.equal(r.genre, 'Whatever');
  assert.equal((await readBytesTags(makeMp3({ genre: '(17)' }))).genre, 'Rock');
  const u = await readBytesTags(makeMp3({ title: 'Tÿx', album: 'Al' }, { unsync: true }));
  assert.equal(u.album, 'Al');
});

test('flac: vorbis comments, duration, cover, case-insensitive keys, TRACKTOTAL', async () => {
  const r = await readBytesTags(makeFlac([
    ['title', 'F'], ['ARTIST', 'Fa'], ['Album', 'Fal'], ['ALBUMARTIST', 'AA'], ['TRACKNUMBER', '4'],
    ['TRACKTOTAL', '9'], ['DISCNUMBER', '1/3'], ['GENRE', 'Jazz'], ['DATE', '1999-05-01'],
  ], { durationSec: 123.5, cover: JPEG }));
  assert.equal(r.title, 'F'); assert.equal(r.artist, 'Fa'); assert.equal(r.album, 'Fal'); assert.equal(r.albumArtist, 'AA');
  assert.equal(r.trackNo, 4); assert.equal(r.trackTotal, 9); assert.equal(r.discNo, 1); assert.equal(r.discTotal, 3);
  assert.equal(r.genre, 'Jazz'); assert.equal(r.year, 1999);
  assert.ok(Math.abs(r.durationSec - 123.5) < 0.001);
  assert.deepEqual([...r.cover.data], [...JPEG]);
});

test('ogg vorbis and opus', async () => {
  for (const opus of [false, true]) {
    const r = await readBytesTags(makeOgg([['TITLE', 'O'], ['ARTIST', 'Oa'], ['ALBUM', 'Oal'], ['TRACKNUMBER', '2'], ['DISCNUMBER', '2']], { opus }));
    assert.equal(r.title, 'O'); assert.equal(r.artist, 'Oa'); assert.equal(r.album, 'Oal');
    assert.equal(r.trackNo, 2); assert.equal(r.discNo, 2);
  }
});

test('m4a: ilst atoms, moov before and after mdat, duration, cover', async () => {
  for (const moovFirst of [true, false]) {
    const r = await readBytesTags(makeM4a({ title: 'M', artist: 'Ma', albumArtist: 'MA', album: 'Mal', genre: 'Pop', track: [5, 10], disc: [2, 2] },
      { durationSec: 200, moovFirst, cover: JPEG }));
    assert.equal(r.title, 'M'); assert.equal(r.artist, 'Ma'); assert.equal(r.albumArtist, 'MA'); assert.equal(r.album, 'Mal');
    assert.equal(r.genre, 'Pop');
    assert.equal(r.trackNo, 5); assert.equal(r.trackTotal, 10); assert.equal(r.discNo, 2); assert.equal(r.discTotal, 2);
    assert.equal(r.durationSec, 200);
    assert.equal(r.cover.mime, 'image/jpeg');
  }
});

test('never throws: empty, unknown, truncated, garbage', async () => {
  assert.deepEqual(await readBytesTags(new Uint8Array(0)), {});
  assert.deepEqual(await readBytesTags(Uint8Array.from([1, 2, 3, 4, 5])), {});
  const full = makeMp3(T, { ver: 4, encoding: 3, cover: JPEG });
  for (const n of [4, 9, 12, 30, 60, full.length >> 1]) await readBytesTags(full.subarray(0, n)); // must not throw
  const flac = makeFlac([['TITLE', 'x']]);
  for (const n of [4, 6, 20, 40]) await readBytesTags(flac.subarray(0, n));
  const m4a = makeM4a({ title: 't' });
  for (const n of [8, 20, 60, 100]) await readBytesTags(m4a.subarray(0, n));
  // random garbage after a valid magic
  const g = cat(Uint8Array.of(0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 40), Uint8Array.from({ length: 60 }, (_, i) => (i * 37) & 255));
  await readBytesTags(g);
});
