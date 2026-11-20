import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LibraryManager } from '../src/library.js';
import { libraryPrefs } from '../src/library-prefs.js';
import { filterDeviceTracks, folderMatches, mergeSources, deriveArtists, deriveGenres, contentKey } from '../src/library-model.js';
import { createDeviceSource } from '../src/device/source.js';
import { createDeviceLibrary, installDeviceLibrary } from '../src/device/index.js';
import { createMemoryStore } from '../src/device/store.js';
import { mapRow } from '../src/device/records.js';
import { createFakeNative, makeRow } from './support/fake-device-native.mjs';

const T = (over) => mapRow(makeRow(over.i ?? 0, over));
const folderTrack = (o) => ({ id: `t1-${o.title}`, title: 'F', artist: 'A', album: 'B', path: 'X/B/f.mp3', size: 0, file: { name: 'f' }, hue: 0, color: '#112233', ...o });
const reset = () => libraryPrefs.reset();

test('folderMatches: case-insensitive, whole-segment, multi-segment', () => {
  assert.equal(folderMatches('Music/WhatsApp Audio/', 'whatsapp audio'), true);
  assert.equal(folderMatches('Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Audio/', 'Android/media/com.whatsapp'), true);
  assert.equal(folderMatches('Music/My Recordings Collection/', 'Recordings'), false, 'a segment, not a substring');
  assert.equal(folderMatches('Music/', ''), false);
});

test('filters: min duration, system-sound flags, exclude and include-only folders', () => {
  const tracks = [
    T({ i: 1, durationMs: 200000, relativePath: 'Music/A/' }),
    T({ i: 2, durationMs: 12000, relativePath: 'Music/A/' }),                          // 12 s clip
    T({ i: 3, durationMs: 200000, relativePath: 'Ringtones/' }),
    T({ i: 4, durationMs: 200000, relativePath: 'Music/A/', isRingtone: true }),       // flagged
    T({ i: 5, durationMs: 200000, relativePath: 'Music/WhatsApp Audio/' }),
    T({ i: 6, durationMs: 0, relativePath: 'Music/B/' }),                              // unknown duration: kept
    T({ i: 7, durationMs: 200000, relativePath: 'Sounds/Voice Recorder/' }),
  ];
  const ids = (p) => filterDeviceTracks(tracks, p).map((t) => t.mediaId - 1000);
  const defaults = { minDurationSec: 30, excludeFolders: ['WhatsApp Audio', 'Ringtones', 'Voice Recorder'], includeFolders: [] };
  assert.deepEqual(ids(defaults), [1, 6]);
  assert.deepEqual(ids({ ...defaults, minDurationSec: 10 }), [1, 2, 6]);
  assert.deepEqual(ids({ ...defaults, minDurationSec: 0 }), [1, 2, 6]);
  assert.deepEqual(ids({ ...defaults, excludeFolders: [] }), [1, 3, 5, 6, 7]);
  assert.deepEqual(ids({ ...defaults, includeFolders: ['Music/B'] }), [6]);
  assert.deepEqual(ids({}), [1, 2, 3, 5, 6, 7], 'no prefs = only the system-sound flags apply');
});

test('mergeSources: device beats a folder copy of the same song; real duplicates inside a source stay', () => {
  const d1 = T({ i: 1, title: 'Song', artist: 'Band', album: 'LP', size: 777 });
  const d1b = T({ i: 2, title: 'Song', artist: 'Band', album: 'LP', size: 777 });          // a second device copy: kept
  const f1 = folderTrack({ id: 'folder-1', title: 'Song', artist: 'Band', album: 'LP', size: 777 });
  const f2 = folderTrack({ id: 'folder-2', title: 'Other', size: 5 });
  const f3 = folderTrack({ id: 'folder-3', title: 'Other', size: 5 });                    // folder dupes of each other: kept
  const out = mergeSources([[d1, d1b]], [f1, f2, f3]);
  assert.deepEqual(out.map((t) => t.id), [d1.id, d1b.id, 'folder-2', 'folder-3']);
  assert.equal(mergeSources([[d1], [d1]], []).length, 1, 'same id across sources collapses');
  assert.equal(mergeSources([], [f1]).length, 1);
  assert.equal(contentKey(f1), contentKey({ ...f1, id: 'z' }));
  const noSize = folderTrack({ id: 'n1', title: 'Song', artist: 'Band', album: 'LP', size: 0 });
  assert.equal(mergeSources([[d1]], [noSize]).length, 2, 'no size = no content evidence');
});

test('LibraryManager: folder behaviour is untouched when no source is registered', () => {
  reset();
  const lib = new LibraryManager();
  const a = folderTrack({ id: 'x1', title: 'one' }), b = folderTrack({ id: 'x1', title: 'one' });   // same id twice: both stay (as before)
  lib.tracks = [a, b];
  assert.equal(lib.tracks.length, 2); assert.equal(lib.isEmpty, false);
  assert.equal(lib.albums().length, 1); assert.equal(lib.getTracks().length, 2);
  assert.deepEqual(lib.linkSummary, { linked: 2, needsRelink: 0 });
});

test('LibraryManager + device source: merged tracks, filtered by prefs live, onChange, read model', async () => {
  reset();
  const fake = createFakeNative({ permission: 'granted', rows: [
    makeRow(0, { title: 'Alpha', artist: 'Band', album: 'First', genre: 'Rock', relativePath: 'Music/Band/First/' }),
    makeRow(1, { title: 'Beta', artist: 'Band', album: 'First', genre: 'Rock', relativePath: 'Music/Band/First/' }),
    makeRow(2, { title: 'Gamma', artist: 'Solo', album: 'Disc Set CD1', genre: 'Jazz', relativePath: 'Music/Solo/Disc Set CD1/' }),
    makeRow(3, { title: 'Clip', artist: 'Band', album: 'First', durationMs: 5000, relativePath: 'Music/Band/First/' }),
    makeRow(4, { title: 'Voice', artist: 'Me', album: 'Notes', relativePath: 'WhatsApp Audio/' }),
  ] });
  const dev = createDeviceLibrary({ native: fake, store: createMemoryStore(), scheduler: { yield: async () => {} } });
  const lib = new LibraryManager();
  const folder = folderTrack({ id: 'f-1', title: 'Folder Song', artist: 'Zed', album: 'Zed LP' });
  lib.tracks = [folder];
  let changes = 0; lib.onChange(() => changes++);
  const handle = await installDeviceLibrary(lib, { adapter: dev });
  await dev.scan({ force: true });
  const titles = lib.getTracks().map((t) => t.title).sort();
  assert.deepEqual(titles, ['Alpha', 'Beta', 'Folder Song', 'Gamma']);        // Clip (5 s) and WhatsApp Audio filtered
  assert.ok(changes > 0);
  const albums = lib.getAlbums();
  assert.deepEqual(albums.map((a) => a.album).sort(), ['Disc Set', 'First', 'Zed LP'].sort().map((x) => (x === 'Disc Set' ? 'Disc Set' : x)));
  assert.equal(albums.find((a) => a.album === 'Disc Set').kind, 'cd');
  assert.ok(albums.find((a) => a.album === 'First').tracks.every((t) => t.file && typeof t.file.arrayBuffer === 'function'));
  const artists = lib.getArtists(); assert.deepEqual(artists.map((a) => a.name), ['Band', 'Solo', 'Zed']);
  assert.equal(artists.find((a) => a.name === 'Band').trackCount, 2);
  assert.deepEqual(lib.getGenres(), [{ name: 'Jazz', trackCount: 1, albumCount: 1 }, { name: 'Rock', trackCount: 2, albumCount: 1 }]);
  // prefs apply instantly, no rescan
  const records = fake.calls.records;
  libraryPrefs.set({ minDurationSec: 0 });
  assert.ok(lib.getTracks().some((t) => t.title === 'Clip'));
  libraryPrefs.set({ excludeFolders: [] });
  assert.ok(lib.getTracks().some((t) => t.title === 'Voice'));
  libraryPrefs.set({ sources: { device: false } });
  assert.deepEqual(lib.getTracks().map((t) => t.title), ['Folder Song']);
  libraryPrefs.set({ sources: { device: true, folder: false } });
  assert.ok(!lib.getTracks().some((t) => t.title === 'Folder Song'));
  assert.equal(fake.calls.records, records, 'prefs changes never hit the native layer');
  handle.detach(); reset();
});

test('installDeviceLibrary is a no-op off Android and never asks for permission by itself', async () => {
  reset();
  const lib = new LibraryManager();
  assert.equal(await installDeviceLibrary(lib, { adapter: createDeviceLibrary({ native: null }) }), null);
  const fake = createFakeNative({ permission: 'prompt', rows: [makeRow(0)] });
  const dev = createDeviceLibrary({ native: fake, store: createMemoryStore() });
  const h = await installDeviceLibrary(lib, { adapter: dev });
  assert.equal(fake.requested, 0, 'only the Allow button asks'); assert.equal(dev.status.get().phase, 'needs-permission');
  assert.equal(lib.getTracks().length, 0);
  await dev.allowAndScan();
  assert.equal(fake.requested, 1); assert.equal(lib.getTracks().length, 1); assert.equal(fake.observing, true);
  h.detach(); reset();
});

test('persisted device tracks appear at boot before any scan, then the scan refines them', async () => {
  reset();
  const store = createMemoryStore();
  const fake = createFakeNative({ permission: 'granted', rows: Array.from({ length: 12 }, (_, i) => makeRow(i, { album: 'Persisted', relativePath: 'Music/P/' })) });
  const boot1 = createDeviceLibrary({ native: fake, store, scheduler: { yield: async () => {} } });
  await installDeviceLibrary(new LibraryManager(), { adapter: boot1 });
  await boot1.scan();
  const lib2 = new LibraryManager();
  const boot2 = createDeviceLibrary({ native: createFakeNative({ permission: 'granted', rows: fake.rows }), store, scheduler: { yield: async () => {} } });
  lib2.registerSource(boot2.source);
  await boot2.restore();
  assert.equal(lib2.getTracks().length, 12, 'first paint straight from IndexedDB');
  assert.equal(lib2.getAlbums().length, 1); reset();
});

test('the folder index save/restore ignores device tracks (they have their own store)', async () => {
  reset();
  const fake = createFakeNative({ permission: 'granted', rows: [makeRow(0)] });
  const dev = createDeviceLibrary({ native: fake, store: createMemoryStore(), scheduler: { yield: async () => {} } });
  const lib = new LibraryManager();
  await installDeviceLibrary(lib, { adapter: dev });
  await dev.scan();
  assert.equal(lib._folder.length, 0);
  assert.equal(lib.getTracks().length, 1); reset();
});

test('deriveArtists / deriveGenres handle odd input', () => {
  assert.deepEqual(deriveArtists([]), []); assert.deepEqual(deriveGenres([{ genre: '' }, {}]), []);
  assert.equal(deriveArtists([{ id: 'a', artist: '', tracks: [1, 2] }])[0].name, 'Unknown Artist');
});
