// mixtape-search.test.mjs — the picker running on the global search core through the thin adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPicker } from '../src/mixtape-pick.js';
import { globalSearch } from '../src/mixtape-search.js';

const lib = [
  { id: 't1', title: 'Hoppípolla', artist: 'Sigur Rós', album: 'Takk...', trackNo: 1, durationSec: 268 },
  { id: 't2', title: 'Glósóli', artist: 'Sigur Rós', album: 'Takk...', trackNo: 2, durationSec: 375 },
  { id: 't3', title: 'Café del Mar', artist: 'Energy 52', album: 'Ibiza Nights', trackNo: 1 },
  { id: 't4', title: 'Rós', artist: 'Björk', album: 'Homogenic', trackNo: 1 },
  { id: 't5', title: 'Jóga', artist: 'Björk', album: 'Homogenic', trackNo: 2 },
  { id: 't6', title: 'Straße', artist: 'Die Ärzte', album: 'Jazz ist anders', trackNo: 1 },
  { title: 'No id at all', artist: 'Nobody', album: 'Loose' },
];

test('through the global search: diacritics, AND tokens, grouped by album, tracks in album order', () => {
  const p = createPicker(lib, { search: globalSearch });
  assert.equal(p.size, 7);
  assert.deepEqual(p.query('sigur ros').groups.map((g) => g.album.title), ['Takk...']);
  assert.deepEqual(p.query('sigur ros').groups[0].tracks.map((t) => t.id), ['t1', 't2']);
  assert.equal(p.query('cafe mar').total, 1);
  assert.equal(p.query('bjork homogenic joga').groups[0].tracks[0].id, 't5');
  assert.equal(p.query('no id').groups[0].tracks[0].title, 'No id at all');
  assert.equal(p.query('zzzz nothing').total, 0);
  assert.equal(p.query('ros').groups[0].album.title, 'Homogenic');     // the title match ranks its album first
});

test('empty query browses all albums; a typo still finds the song (the global core is fuzzy)', () => {
  const p = createPicker(lib, { search: globalSearch });
  const all = p.query('  ');
  assert.equal(all.empty, true); assert.equal(all.groups.length, 5);
  assert.equal(p.query('hoppipola').total >= 1, true);
});

test('5,000 tracks stay fast and capped through the adapter', () => {
  const big = [];
  for (let i = 0; i < 5000; i++) big.push({ id: 'g' + i, title: `Song ${i} ${i % 7 ? 'Night' : 'Dáy'}`, artist: `Artist ${i % 90}`, album: `Album ${i % 400}`, trackNo: (i % 12) + 1, durationSec: 200 });
  const t0 = performance.now();
  const p = createPicker(big, { search: globalSearch });
  const tIdx = performance.now() - t0;
  const t1 = performance.now();
  const r = p.query('night artist 4'), r2 = p.query('day');
  const tq = performance.now() - t1;
  assert.ok(r.total > 0 && r2.total > 0);
  assert.ok(r.groups.reduce((n, g) => n + g.tracks.length, 0) <= 200);
  assert.ok(tIdx < 3000, 'index ' + tIdx); assert.ok(tq < 500, 'query ' + tq);
});

test('hostile text never throws; a broken global core falls back to the built-in search', () => {
  const p = createPicker([{ title: '<img onerror=alert(1)>', artist: '"><script>', album: 'x'.repeat(5000) }, null, 5], { search: globalSearch });
  assert.doesNotThrow(() => p.query('<img'));
  assert.doesNotThrow(() => p.query('x'.repeat(1000)));
  const broken = { ...globalSearch, buildIndex: (t) => ({ ...globalSearch.buildIndex(t), ix: { docs: null } }) };
  const q = createPicker(lib, { search: broken });
  assert.equal(q.query('sigur').total, 2);        // fell back
});
