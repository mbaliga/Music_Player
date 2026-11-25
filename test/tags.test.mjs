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

// ── MP3 duration without a TLEN frame (Workstream I) ──
import { mp3Duration } from '../src/tags.js';
import { readBytesTags as readBytes2 } from '../src/tags.js';
test('mp3Duration: Xing frame count is exact, CBR is estimated from the audio bytes, junk is 0', () => {
  const hdr = (b2, mode = 0) => [0xff, 0xfb, b2, mode << 6];           // MPEG1 layer III, no CRC
  // 128 kbps / 44.1 kHz stereo CBR: 0x90 = bitrate index 9 (128), sample rate index 0
  const cbr = Uint8Array.from([...hdr(0x90), ...new Array(200).fill(0)]);
  const d = mp3Duration(cbr, 16000 * 30);                               // 30 s of 128 kbps = 480000 bytes
  assert.ok(Math.abs(mp3Duration(cbr, 480000) - 30) < 0.01, 'cbr 30 s: ' + d);
  // Xing at 4 + 32: 'Xing', flags=1 (frames), frames = 1000 -> 1000 * 1152 / 44100 = 26.12 s
  const x = new Uint8Array(200); x.set(hdr(0x90)); x.set([0x58, 0x69, 0x6e, 0x67], 36); x.set([0, 0, 0, 1], 40); x.set([0, 0, 0x03, 0xe8], 44);
  assert.ok(Math.abs(mp3Duration(x, 1) - 1000 * 1152 / 44100) < 1e-6);
  assert.equal(mp3Duration(new Uint8Array(64), 100), 0);
  assert.equal(mp3Duration(Uint8Array.from([0xff, 0xfb, 0xf0, 0]), 100), 0, 'bitrate index 15 is invalid');
});

test('readBytesTags: an ID3v2 MP3 without TLEN gets a duration from its first frame; duration:false skips it; the flag is set', async () => {
  const hdr = [0xff, 0xfb, 0x90, 0x00];                                   // MPEG1 L3 128 kbps 44.1 kHz stereo
  const audio = new Uint8Array(16000 * 12); audio.set(hdr);                // 12 s of 128 kbps
  const tag = new Uint8Array(10 + 40); tag.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 40]);                 // ID3v2.3, size 40
  const f = (id, text) => { const t = new TextEncoder().encode('\0' + text); const o = new Uint8Array(10 + t.length); o.set(new TextEncoder().encode(id)); o[7] = t.length; o.set(t, 10); return o; };
  const fr = f('TIT2', 'Hi'); tag.set(fr, 10);
  const bytes = new Uint8Array(tag.length + audio.length); bytes.set(tag); bytes.set(audio, tag.length);
  const m = await readBytes2(bytes);
  assert.equal(m.title, 'Hi');
  assert.ok(Math.abs(m.durationSec - 12) < 0.05, 'duration ' + m.durationSec);
  assert.equal(m.durationFromFrames, true);
});

test('ogg vorbis and opus durationSec come from the last page granule (rate from the id packet; opus 48 kHz minus pre-skip)', async () => {
  const v = await readBytesTags(makeOgg([['TITLE', 'V']], { seconds: 185.5, rate: 44100 }));
  assert.ok(Math.abs(v.durationSec - 185.5) < 0.01, 'vorbis ' + v.durationSec);
  const o = await readBytesTags(makeOgg([['TITLE', 'O']], { opus: true, seconds: 61.25 }));
  assert.ok(Math.abs(o.durationSec - 61.25) < 0.01, 'opus ' + o.durationSec);
  const none = await readBytesTags(makeOgg([['TITLE', 'N']]));
  assert.equal(none.durationSec, undefined);
});

test('m4a codec: mp4a is aac, alac is flagged (the WebView cannot decode ALAC), no stsd = unknown', async () => {
  assert.equal((await readBytesTags(makeM4a({ title: 'A' }, { durationSec: 5, codec: 'mp4a' }))).codec, 'aac');
  assert.equal((await readBytesTags(makeM4a({ title: 'L' }, { durationSec: 5, codec: 'alac' }))).codec, 'alac');
  assert.equal((await readBytesTags(makeM4a({ title: 'N' }, { durationSec: 5 }))).codec, undefined);
});
