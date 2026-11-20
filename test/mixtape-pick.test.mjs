// mixtape-pick.test.mjs — the picker's search core: diacritics, grouping by album, 5k tracks, virtual window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, createPicker, flattenGroups, virtualWindow, tapeKeys, isOnTape, defaultSearch, identOf } from '../src/mixtape-pick.js';
import { createMixtape, addTrack } from '../src/mixtape.js';

const lib = [
  { id: 't1', title: 'Hoppípolla', artist: 'Sigur Rós', album: 'Takk...', trackNo: 1, durationSec: 268 },
  { id: 't2', title: 'Glósóli', artist: 'Sigur Rós', album: 'Takk...', trackNo: 2, durationSec: 375 },
  { id: 't3', title: 'Café del Mar', artist: 'Energy 52', album: 'Ibiza Nights', trackNo: 1 },
  { id: 't4', title: 'Rós', artist: 'Björk', album: 'Homogenic', trackNo: 1 },
  { id: 't5', title: 'Jóga', artist: 'Björk', album: 'Homogenic', trackNo: 2 },
  { id: 't6', title: 'Straße', artist: 'Die Ärzte', album: 'Jazz ist anders', trackNo: 1 },
];

test('fold: diacritics, case, punctuation', () => {
  assert.equal(fold('Sigur Rós'), 'sigur ros'); assert.equal(fold('  Café—del  Mar! '), 'cafe del mar');
  assert.equal(fold('Straße'), 'strasse'); assert.equal(fold('Björk'), 'bjork'); assert.equal(fold(null), '');
});

test('search is diacritic- and case-insensitive over title, artist and album, tokens ANDed', () => {
  const p = createPicker(lib);
  assert.deepEqual(p.query('ros').groups.map((g) => g.album.title), ['Homogenic', 'Takk...']);   // the track Rós (title prefix) outranks the artist Sigur Rós
  assert.equal(p.query('SIGUR').total, 2);
  assert.equal(p.query('cafe mar').total, 1);
  assert.equal(p.query('hoppipolla takk').total, 1);
  assert.equal(p.query('bjork homogenic joga').total, 1);
  assert.equal(p.query('strasse').groups[0].tracks[0].id, 't6');
  assert.equal(p.query('nothing like this').total, 0); assert.deepEqual(p.query('zzz').groups, []);
});

test('results are grouped by album, in album order; empty query browses everything', () => {
  const p = createPicker(lib);
  const r = p.query('sigur');
  assert.equal(r.groups.length, 1); assert.deepEqual(r.groups[0].tracks.map((t) => t.id), ['t1', 't2']);
  assert.equal(r.groups[0].album.artist, 'Sigur Rós'); assert.equal(r.groups[0].album.count, 2);
  const all = p.query('  ');
  assert.equal(all.empty, true); assert.equal(all.groups.length, 4); assert.equal(all.total, 6);

  const rows = flattenGroups(r.groups);
  assert.deepEqual(rows.map((x) => x.kind), ['head', 'track', 'track']);
});

test('title prefix ranks an album group above a weaker match', () => {
  const p = createPicker([{ id: 'a', title: 'Alpha Song', artist: 'Zed', album: 'Z1' }, { id: 'b', title: 'Other', artist: 'Alpha Band', album: 'A1' }]);
  assert.equal(p.query('alpha').groups[0].tracks[0].id, 'a');
});

test('already-on-tape markers by id or by artist/album/title', () => {
  let m = createMixtape({ id: 'x' });
  m = addTrack(m, lib[0]); m = addTrack(m, { title: 'Jóga', artist: 'Björk', album: 'Homogenic' });
  const keys = tapeKeys(m);
  assert.equal(isOnTape(keys, lib[0]), true); assert.equal(isOnTape(keys, lib[4]), true); assert.equal(isOnTape(keys, lib[1]), false);
  assert.equal(identOf(lib[0]), 't1');
});

test('5,000 tracks: index + query are fast and results are capped for the UI', () => {
  const big = [];
  for (let i = 0; i < 5000; i++) big.push({ id: 'g' + i, title: `Song ${i} ${i % 7 ? 'Night' : 'Dáy'}`, artist: `Artist ${i % 90}`, album: `Album ${i % 400}`, trackNo: (i % 12) + 1, durationSec: 200 });
  const t0 = performance.now();
  const p = createPicker(big);
  const tIdx = performance.now() - t0;
  const t1 = performance.now();
  const r = p.query('night artist 4');
  const r2 = p.query('day');                 // matches "Dáy"
  const tq = performance.now() - t1;
  assert.equal(p.size, 5000);
  assert.ok(r.total > 0 && r2.total > 0);
  assert.ok(r.groups.reduce((n, g) => n + g.tracks.length, 0) <= 400);
  assert.equal(r2.truncated, r2.total > 400);
  assert.ok(tIdx < 2000, 'index ' + tIdx); assert.ok(tq < 400, 'query ' + tq);
  assert.equal(p.browse().length, 3600);   // (artist, album) pairs
});

test('virtual window: only visible rows plus overscan, clamped', () => {
  assert.deepEqual(virtualWindow({ count: 5000, rowH: 56, scrollTop: 0, viewH: 560 }), { from: 0, to: 16, totalH: 280000 });
  const w = virtualWindow({ count: 5000, rowH: 56, scrollTop: 56 * 1000, viewH: 560 });
  assert.equal(w.from, 994); assert.equal(w.to, 1016);
  assert.deepEqual(virtualWindow({ count: 3, rowH: 56, scrollTop: 9999, viewH: 560 }).to, 3);
  assert.equal(defaultSearch.buildIndex([]).size, 0);
});
