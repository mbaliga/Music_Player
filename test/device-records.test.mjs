import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapRow, applyTags, deviceTrackId, mediaIdOfDeviceId, trackAndDisc, relativeFromData, folderOf, isAudioRow, isUnknown, toStored, fromStored, UNKNOWN_ARTIST } from '../src/device/records.js';
import { groupTracks, shelfItems } from '../src/albums.js';
import { makeRow } from './support/fake-device-native.mjs';
import { deriveArtists } from '../src/library-model.js';

test('a fully tagged row maps to the library track shape', () => {
  const t = mapRow(makeRow(0, { title: 'Heat Wave', artist: 'Martha & The Vandellas', album: 'Heat Wave', albumArtist: 'Martha', genre: 'Soul', track: 3, year: 1963, durationMs: 150500, size: 12345, modified: 99 }));
  assert.equal(t.source, 'device');
  assert.equal(t.title, 'Heat Wave'); assert.equal(t.artist, 'Martha & The Vandellas'); assert.equal(t.albumArtist, 'Martha'); assert.equal(t.album, 'Heat Wave');
  assert.equal(t.genre, 'Soul'); assert.equal(t.trackNo, 3); assert.equal(t.year, 1963); assert.equal(t.durationSec, 150.5); assert.equal(t.size, 12345);
  assert.equal(t.mediaId, 1000); assert.equal(t.uri, 'content://media/external/audio/media/1000');
  assert.equal(t.path, 'Music/Artist/Album/Track 0.mp3'); assert.equal(t.folder, 'Music/Artist/Album/');
  assert.equal(t.needsTags, false); assert.equal(t.file, null); assert.match(t.color, /^#[0-9a-f]{6}$/);
});

test('stable id: from the MediaStore _id alone; size / date_modified (a re-tag) do not move it', () => {
  const a = deviceTrackId({ id: 5, size: 100, modified: 7 });
  assert.equal(a, deviceTrackId({ id: 5, size: 100, modified: 7 }));
  assert.equal(a, deviceTrackId({ id: 5, size: 101, modified: 7 }));
  assert.equal(a, deviceTrackId({ id: 5, size: 100, modified: 8 }));
  assert.notEqual(a, deviceTrackId({ id: 6, size: 100, modified: 7 }));
  assert.ok(a.length <= 64 && a.startsWith('d2-'));
  // the change signature stays on the track
  const t = mapRow(makeRow(3, { size: 111, modified: 22 })); assert.equal(t.size, 111); assert.equal(t.modified, 22);
});

test('old d1-<id>-<size>-<mtime> ids: the media id is readable from both formats and stored rows migrate', () => {
  assert.equal(mediaIdOfDeviceId('d1-' + (1234).toString(36) + '-abc-def'), 1234);
  assert.equal(mediaIdOfDeviceId(deviceTrackId({ id: 77 })), 77);
  assert.equal(mediaIdOfDeviceId('f1-xyz'), null); assert.equal(mediaIdOfDeviceId(''), null);
  const t = mapRow(makeRow(4, {}));
  const old = { ...toStored(t), id: 'd1-' + (t.mediaId).toString(36) + '-5-9' };
  const back = fromStored(old);
  assert.equal(back.id, deviceTrackId({ id: t.mediaId })); assert.equal(back.mediaId, t.mediaId);
  assert.equal(fromStored(toStored(t)).id, t.id, 'a current id is left alone');
});

test('MediaStore blanks: "<unknown>" artist/album, file-name title, folder grouping, needsTags', () => {
  const t = mapRow(makeRow(1, { title: '', artist: '<unknown>', album: '<unknown>', name: '01 Intro.mp3', genre: '<unknown>' }));
  assert.equal(t.title, '01 Intro'); assert.equal(t.artist, UNKNOWN_ARTIST); assert.equal(t.album, ''); assert.equal(t.genre, '');
  assert.equal(t.needsTags, true);
  assert.equal(mapRow(makeRow(2, { artist: '<unknown>', album: 'Real Album' })).needsTags, false);
  assert.equal(isUnknown('<unknown>'), true); assert.equal(isUnknown('  '), true); assert.equal(isUnknown('Unknown Artist'), false);
});

test('a numeric ID3v1 genre index is dropped, not shown', () => {
  assert.equal(mapRow(makeRow(0, { genre: '(13)' })).genre, '');
  assert.equal(mapRow(makeRow(0, { genre: '17' })).genre, '');
  assert.equal(mapRow(makeRow(0, { genre: 'Rock' })).genre, 'Rock');
});

test('track/disc: packed DTTT, CD_TRACK_NUMBER and DISC_NUMBER strings', () => {
  assert.deepEqual(trackAndDisc({ track: 7 }), { trackNo: 7, discNo: undefined });
  assert.deepEqual(trackAndDisc({ track: 2003 }), { trackNo: 3, discNo: 2 });
  assert.deepEqual(trackAndDisc({ track: 1003, cdTrack: '9/12', disc: '1/2' }), { trackNo: 9, discNo: 1 });
  assert.deepEqual(trackAndDisc({ track: 0, cdTrack: '', disc: '' }), { trackNo: undefined, discNo: undefined });
  assert.deepEqual(trackAndDisc({ track: -4 }), { trackNo: undefined, discNo: undefined });
});

test('relative path: RELATIVE_PATH wins; API<29 derives it from _data for primary and SD volumes', () => {
  assert.equal(relativeFromData('/storage/emulated/0/Music/A/B/x.mp3'), 'Music/A/B/');
  assert.equal(relativeFromData('/storage/1234-ABCD/Music/Album CD2/x.mp3'), 'Music/Album CD2/');
  assert.equal(relativeFromData('/sdcard/Download/x.mp3'), 'Download/');
  assert.equal(relativeFromData(''), '');
  assert.equal(folderOf({ relativePath: 'Music/X', data: '/storage/emulated/0/Other/y.mp3' }), 'Music/X/');
  assert.equal(folderOf({ relativePath: '', data: '/storage/emulated/0/Other/y.mp3' }), 'Other/');
});

test('audio filter: audio/* and audio-ish containers pass, non-music mime is ignored', () => {
  assert.equal(isAudioRow({ mime: 'audio/flac', name: 'x.flac' }), true);
  assert.equal(isAudioRow({ mime: 'application/ogg', name: 'x.ogg' }), true);
  assert.equal(isAudioRow({ mime: 'video/mp4', name: 'song.m4a' }), true);
  assert.equal(isAudioRow({ mime: 'application/octet-stream', name: 'song.mp3' }), true);
  assert.equal(isAudioRow({ mime: 'image/jpeg', name: 'cover.jpg' }), false);
  assert.equal(isAudioRow({ mime: '', name: 'notes.txt' }), false);
});

test('the CD1/CD2/Disc N rule works from device folder names (albums.js unchanged)', () => {
  const mk = (i, over) => mapRow(makeRow(i, { artist: 'Band', album: '', ...over }));
  const tracks = [
    mk(0, { title: 'a1', name: '01 a1.mp3', relativePath: 'Music/Band/Greatest Hits CD1/', track: 1 }),
    mk(1, { title: 'a2', name: '02 a2.mp3', relativePath: 'Music/Band/Greatest Hits CD1/', track: 2 }),
    mk(2, { title: 'b1', name: '01 b1.mp3', relativePath: 'Music/Band/Greatest Hits CD2/', track: 1 }),
    mk(3, { title: 'v1', name: '01 v1.mp3', relativePath: 'Music/Band/Solo LP/', track: 1 }),
    mk(4, { title: 'd1', name: '01 d1.mp3', relativePath: 'Music/Band/Box/Disc 2/', album: 'Box Set', track: 1 }),
  ];
  const items = shelfItems(groupTracks(tracks));
  const byLabel = Object.fromEntries(items.map((i) => [i.label, i]));
  assert.equal(byLabel['Greatest Hits · CD 1'].kind, 'cd');
  assert.equal(byLabel['Greatest Hits · CD 2'].tracks.length, 1);
  assert.equal(byLabel['Solo LP'].kind, 'vinyl');
  assert.equal(items.find((i) => i.label.startsWith('Box Set')).kind, 'cd');
});

test('untagged files group by folder; an unknown artist lands in one bucket', () => {
  const tracks = ['x', 'y'].map((n, i) => mapRow(makeRow(i, { title: '', artist: '<unknown>', album: '<unknown>', name: `${n}.mp3`, relativePath: 'Download/Mixed Bag/' })));
  const [item] = shelfItems(groupTracks(tracks));
  assert.equal(item.label, 'Mixed Bag'); assert.equal(item.album.artist, 'Unknown Artist'); assert.equal(item.tracks.length, 2);
});

test('untagged files in Download/ gather in "Unsorted (Download)", sort last and stay out of the artist list', () => {
  const real = ['a', 'b'].map((n, i) => mapRow(makeRow(i, { title: `T${n}`, artist: 'Zed', album: 'Zed Album', name: `${n}.mp3`, relativePath: 'Music/Zed/' })));
  const raw = ['x', 'y'].map((n, i) => mapRow(makeRow(10 + i, { title: '', artist: '<unknown>', album: '<unknown>', name: `${n}.mp3`, relativePath: 'Download/' })));
  const albums = groupTracks([...raw, ...real]);
  assert.equal(albums[albums.length - 1].title, 'Unsorted (Download)'); assert.equal(albums[albums.length - 1].unsorted, true); assert.equal(albums[0].title, 'Zed Album');
  assert.equal(deriveArtists(shelfItems(albums).map((i) => ({ id: i.id, artist: i.album.artist, unsorted: i.album.unsorted, tracks: i.tracks }))).map((a) => a.name).join(), 'Zed');
});

test('applyTags fills only what MediaStore left blank and re-keys the colour', () => {
  const t = mapRow(makeRow(3, { title: '', artist: '<unknown>', album: '<unknown>', name: 'raw.mp3', durationMs: 0 }));
  const u = applyTags(t, { title: 'Real Title', artist: 'Real Artist', album: 'Real Album', trackNo: 4, genre: 'Jazz', durationSec: 200 });
  assert.equal(u.title, 'Real Title'); assert.equal(u.artist, 'Real Artist'); assert.equal(u.album, 'Real Album'); assert.equal(u.trackNo, 4); assert.equal(u.durationSec, 200);
  assert.equal(u.needsTags, false); assert.equal(u.tagged, true);
  const keep = applyTags(mapRow(makeRow(4, { title: 'Mine', artist: 'Me', album: 'My Album' })), { title: 'Other', artist: 'Other', album: 'Other' });
  assert.equal(keep.title, 'Mine'); assert.equal(keep.artist, 'Me'); assert.equal(keep.album, 'My Album');
  assert.equal(applyTags(t, {}).needsTags, false);   // an empty tag read still ends the retry loop
});

test('stored form round-trips, strips File/blob URLs, and rejects junk', () => {
  const t = { ...mapRow(makeRow(5)), file: { x: 1 }, coverUrl: 'blob:abc' };
  const s = toStored(t);
  assert.equal('file' in s, false); assert.equal('coverUrl' in s, false);
  const made = [];
  const back = fromStored(JSON.parse(JSON.stringify(s)), { makeFile: (x) => { made.push(x.mediaId); return { f: true }; } });
  assert.equal(back.title, t.title); assert.deepEqual(back.file, { f: true }); assert.deepEqual(made, [1005]);
  assert.equal(fromStored(null), null); assert.equal(fromStored({ id: 'x' }), null); assert.equal(fromStored({ id: 'x', mediaId: 'no', title: 't' }), null);
});

test('hostile / odd rows never throw', () => {
  for (const row of [{}, { id: 1 }, { id: 2, title: 5, artist: null, durationMs: 'x', size: -3 }, { id: 3, name: 'a'.repeat(5000) + '.mp3', title: 'x'.repeat(5000) }]) {
    const t = mapRow(row);
    assert.equal(typeof t.title, 'string'); assert.ok(t.title.length <= 300);
  }
});

test('mapRow keeps mime and volume (a trailing comment once swallowed them) and DeviceFile gets a type', () => {
  const t = mapRow(makeRow(3, { mime: 'audio/flac', volume: 'external_primary', name: 'x.flac' }), { makeFile: (tr) => ({ type: tr.mime }) });
  assert.equal(t.mime, 'audio/flac'); assert.equal(t.volume, 'external_primary'); assert.equal(t.file.type, 'audio/flac');
  assert.equal(mapRow({ id: 1, name: 'a.mp3' }).mime, ''); assert.equal(mapRow({ id: 1, name: 'a.mp3' }).volume, '');
});
