import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptLibrary, adaptMixtapes, adaptStations, buildSearchData } from '../src/search/adapters.js';
import { buildIndex, query } from '../src/search/index.js';
import { cannedStation, parseStationsIndex } from '../src/radio/canned/catalog.js';
import { emptyModel, toggleFavourite, recordPlayed } from '../src/radio-store.js';
import { createMixtape } from '../src/mixtape.js';

const TR = (id, title, artist, album, extra = {}) => ({ id, title, artist, album, file: {}, ...extra });
const t1 = TR('t1', 'Army of Me', 'Björk', 'Post'), t2 = TR('t2', 'Hyperballad', 'Björk', 'Post'), t3 = TR('t3', 'Under Pressure', 'Queen', 'Hot Space CD1'), t4 = TR('t4', 'Loose', 'Unknown Artist', '', { relink: true });
// the LibraryManager shape today: .tracks array + .albums() shelf items {id, kind, album, artist, tracks}
const lib = { tracks: [t1, t2, t3, t4], albums: () => [{ id: 'A1', kind: 'vinyl', album: 'Post', artist: 'Björk', genre: 'Art pop', tracks: [t1, t2] }, { id: 'A2', kind: 'cd', album: 'Hot Space', artist: 'Queen', tracks: [t3] }] };
const INDEX = { v: 1, stations: [
  { id: 'kilo-hertz-rock-102-7', name: 'Kilo-Hertz Rock 102.7', dial: '102.7', tagline: 'Loud enough.', hosts: [{ id: 'danny', name: 'Big Danny Sparks', role: 'host' }], daypart: ['morning'], segments: 5, minutes: 5 },
  { id: 'meridian-91-5', name: 'Meridian 91.5', dial: '91.5', tagline: 'After dark.', hosts: [], daypart: ['night'] },
] };

test('adaptLibrary: tracks, albums, artists, lookups from the LibraryManager shape', () => {
  const { data, lookup } = adaptLibrary(lib);
  assert.equal(data.tracks.length, 4); assert.equal(data.albums.length, 2);
  assert.equal(data.tracks[0].albumId, 'A1'); assert.equal(data.tracks[3].relink, true); assert.equal(data.tracks[3].artist, '');
  assert.deepEqual(data.albums.map((a) => [a.id, a.name, a.kind, a.trackCount]), [['A1', 'Post', 'vinyl', 2], ['A2', 'Hot Space', 'cd', 1]]);
  const bj = data.artists.find((a) => a.name === 'Björk'); assert.deepEqual([bj.albums, bj.tracks], [1, 2]);
  assert.equal(data.artists.length, 2);                              // 'Unknown Artist' is not an artist
  assert.ok(!('raw' in data.tracks[0]) && !('file' in data.tracks[0]));   // File objects never reach the index
  assert.deepEqual(lookup.albumTracks('A1').map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(lookup.artistTracks('BJORK').map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(lookup.artistAlbums('queen').map((a) => a.id), ['A2']);
  assert.equal(lookup.track('t3').title, 'Under Pressure'); assert.equal(lookup.track('nope'), null);
});
test('adaptLibrary: plain arrays, missing shelf (groups by artist+album), junk, null', () => {
  const r = adaptLibrary([t1, t2, null, 5, { title: 'x' }]);
  assert.equal(r.data.tracks.length, 3);
  assert.equal(r.data.albums.length, 1); assert.equal(r.data.albums[0].name, 'Post'); assert.equal(r.data.albums[0].trackCount, 2);
  for (const bad of [null, undefined, 3, 'x', {}, { tracks: 5 }, { tracks: () => { throw new Error('x'); } }, { tracks: [], albums: () => { throw new Error('y'); } }]) {
    const d = adaptLibrary(bad).data; assert.deepEqual([d.tracks.length, d.albums.length, d.artists.length], [0, 0, 0]);
  }
  assert.equal(adaptLibrary({ getTracks: () => [t1] }).data.tracks.length, 1);   // a likely shape of the device library model
});
test('adaptLibrary + index: songs, albums, artists are searchable end to end', () => {
  const { data } = adaptLibrary(lib);
  const r = query(buildIndex(data), 'bjork');
  assert.equal(r.counts.artists, 1); assert.equal(r.counts.songs, 2); assert.equal(r.counts.albums, 1);
  assert.equal(r.songs[0].albumId, 'A1');
});

test('adaptMixtapes reads the v4 model (flat tracks A then B) and v1-style lists', () => {
  const m = createMixtape({ id: 'm1', name: 'Road Trip', author: 'Sam', tracks: [{ title: 'Hyperballad', artist: 'Björk' }, { title: 'Highway Star', artist: 'Deep Purple' }] });
  const out = adaptMixtapes([m, null, 4, { id: 'x', name: 'Bare' }]);
  assert.equal(out.length, 2); assert.equal(out[0].tracks.length, 2); assert.equal(out[0].author, 'Sam');
  const r = query(buildIndex({ mixtapes: out }), 'highway');
  assert.equal(r.mixtapes[0].id, 'm1'); assert.deepEqual(adaptMixtapes('nope'), []);
});

test('adaptStations: canned shows always, favourites and recents from the store, no AI rows while the flag is off', () => {
  const idx = parseStationsIndex(INDEX);
  let model = emptyModel();
  const jazz = { type: 'radio-browser', id: 'rb:1', name: 'Jazz FM', streamUrl: 'https://x.example/j', country: 'UK', tags: ['jazz', 'lounge'] };
  model = toggleFavourite(model, jazz, 1000);
  model = recordPlayed(model, { type: 'radio-browser', id: 'rb:2', name: 'Rock Radio', streamUrl: 'https://x.example/r', tags: ['rock'] }, 2000);
  model = recordPlayed(model, cannedStation(idx[0]), 3000);
  model = recordPlayed(model, { type: 'ai-you', id: 'you', name: 'You Radio', tags: ['ai'] }, 4000);
  const out = adaptStations({ radioModel: model, cannedIndex: idx, aiOn: false });
  const names = out.map((s) => s.name);
  assert.deepEqual(names.slice(0, 2), ['Kilo-Hertz Rock 102.7', 'Meridian 91.5']);
  assert.ok(names.includes('Jazz FM') && names.includes('Rock Radio'));
  assert.ok(!names.includes('You Radio'));
  assert.equal(out.filter((s) => s.key === 'canned|kilo-hertz-rock-102-7').length, 1);      // a played canned station is not listed twice
  assert.equal(out[0].lastPlayed, 3000); assert.equal(out.find((s) => s.name === 'Jazz FM').fav, true);
  assert.equal(out[0].station.type, 'canned'); assert.equal(out.find((s) => s.name === 'Jazz FM').station.streamUrl, 'https://x.example/j');
  assert.ok(out.every((s) => !s.disabled));
});
test('adaptStations: You Radio + AI style cards only when the flag is on; style cards are disabled "coming soon"', () => {
  const idx = parseStationsIndex(INDEX);
  const on = adaptStations({ cannedIndex: idx, aiOn: true });
  const you = on.find((s) => s.source === 'you'); assert.ok(you); assert.equal(you.disabled, undefined); assert.equal(you.station.type, 'ai-you');
  const styles = on.filter((s) => s.source === 'style');
  assert.ok(styles.length >= 3); assert.ok(styles.every((s) => s.disabled && s.note === 'Coming soon' && !s.station));
  const r = query(buildIndex({ stations: on }), 'you radio');
  assert.equal(r.stations[0].source, 'you');
  assert.equal(adaptStations({ cannedIndex: idx, aiOn: false }).filter((s) => s.source === 'style' || s.source === 'you').length, 0);
});
test('adaptStations tolerates absence and garbage', () => {
  assert.deepEqual(adaptStations(), []); assert.deepEqual(adaptStations({ radioModel: 5, cannedIndex: 'not json' }), []);
  assert.deepEqual(adaptStations({ radioModel: { favs: [null, { k: 'x|y', snap: null }], recents: 'x', last: 4 } }).length, 0);
  assert.equal(adaptStations({ cannedIndex: JSON.stringify(INDEX) }).length, 2);
});
test('radio rows are found by name, dial, tag and host', () => {
  const ix = buildIndex({ stations: adaptStations({ cannedIndex: parseStationsIndex(INDEX) }) });
  for (const q of ['kilo', '102.7', 'danny', 'meridian']) assert.equal(query(ix, q).counts.stations, 1, q);
});
test('buildSearchData wires every part and the data JSON-serialises (no File handles, no DOM)', () => {
  const { data, lookup } = buildSearchData({ library: lib, mixtapes: [createMixtape({ id: 'm', name: 'Tape' })], radioModel: emptyModel(), cannedIndex: parseStationsIndex(INDEX), aiOn: false });
  assert.deepEqual(Object.keys(data).sort(), ['albums', 'artists', 'mixtapes', 'stations', 'tracks']);
  assert.ok(JSON.stringify(data).length > 100); assert.ok(lookup.track('t1'));
  const empty = buildSearchData();
  assert.deepEqual(Object.values(empty.data).map((a) => a.length), [0, 0, 0, 0, 0]);
});
