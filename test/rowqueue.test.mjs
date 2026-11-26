import test from 'node:test';
import assert from 'node:assert/strict';
import { queueMatchesRow } from '../src/rowqueue.js';

const f = (n) => ({ name: n });
const mk = (files) => files.map((file) => ({ file }));
test('queueMatchesRow: same album, same files, same positions -> shortcut allowed', () => {
  const [a, b, c] = [f('a'), f('b'), f('c')];
  assert.equal(queueMatchesRow({ albumId: 'x', items: mk([a, b, c]) }, { id: 'x', tracks: mk([a, b, c]) }, 1), true);
});
test('queueMatchesRow: a rescan inserted a track -> rows shifted, shortcut refused (the wrong song would play)', () => {
  const [a, b, c, n] = [f('a'), f('b'), f('c'), f('new')];
  const q = { albumId: 'x', items: mk([a, b, c]) };
  assert.equal(queueMatchesRow(q, { id: 'x', tracks: mk([a, n, b, c]) }, 1), false, 'count changed');
  assert.equal(queueMatchesRow(q, { id: 'x', tracks: mk([a, c, b]) }, 1), false, 'same count, reordered');
});
test('queueMatchesRow: no queue, other album, or a track without a file -> refused', () => {
  const a = f('a');
  assert.equal(queueMatchesRow(null, { id: 'x', tracks: mk([a]) }, 0), false);
  assert.equal(queueMatchesRow({ albumId: 'y', items: mk([a]) }, { id: 'x', tracks: mk([a]) }, 0), false);
  assert.equal(queueMatchesRow({ albumId: 'x', items: [{ file: null }] }, { id: 'x', tracks: [{ file: null }] }, 0), false);
});
