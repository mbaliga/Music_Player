import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepActive, debounceMs, librarySignature, cleanRanges, segments, limitsFor, isSearchShortcut, CHIPS, DEBOUNCE_MAX } from '../src/search/view.js';

test('stepActive wraps, starts sensibly, ignores other keys, handles empty lists', () => {
  assert.equal(stepActive(-1, 'ArrowDown', 3), 0); assert.equal(stepActive(2, 'ArrowDown', 3), 0);
  assert.equal(stepActive(-1, 'ArrowUp', 3), 2); assert.equal(stepActive(0, 'ArrowUp', 3), 2);
  assert.equal(stepActive(1, 'Home', 3), 0); assert.equal(stepActive(1, 'End', 3), 2);
  assert.equal(stepActive(1, 'x', 3), 1); assert.equal(stepActive(0, 'ArrowDown', 0), -1);
});
test('debounce: instant for small libraries, at most 60 ms for big ones', () => {
  assert.equal(debounceMs(100), 0); assert.equal(debounceMs(2999), 0); assert.equal(debounceMs(20000), DEBOUNCE_MAX); assert.ok(DEBOUNCE_MAX <= 60);
});
test('librarySignature changes on add/remove/relink and never throws', () => {
  const a = [{ id: '1' }, { id: '2' }, { id: '3' }];
  const s = librarySignature(a);
  assert.notEqual(s, librarySignature([...a, { id: '4' }])); assert.notEqual(s, librarySignature(a.slice(1)));
  assert.notEqual(s, librarySignature([{ id: '1', relink: true }, { id: '2' }, { id: '3' }]));
  assert.equal(s, librarySignature([...a]));
  for (const bad of [null, undefined, 5, 'x', [null, undefined], { length: 3 }]) assert.equal(typeof librarySignature(bad), 'string');
  assert.equal(librarySignature([]), '0');
});
test('cleanRanges: clamps, sorts, merges, drops junk', () => {
  assert.deepEqual(cleanRanges([[5, 9], [0, 3], [2, 4], [-5, 1], [8, 8], null, 'x', [100, 200]], 10), [[0, 4], [5, 9]]);
  assert.deepEqual(cleanRanges(null, 5), []);
});
test('segments: marked and plain pieces re-join to the original text, hostile text stays text', () => {
  const t = '<b>x</b> Björk';
  const segs = segments(t, [[0, 3], [9, 14]]);
  assert.equal(segs.map((s) => s.t).join(''), t); assert.deepEqual(segs.map((s) => s.mark), [true, false, true]);
  assert.deepEqual(segments('abc', []), [{ t: 'abc', mark: false }]); assert.deepEqual(segments(null, [[0, 2]]), []);
});
test('limitsFor / CHIPS', () => {
  assert.deepEqual(limitsFor('all'), { songs: 5, albums: 5, artists: 5, mixtapes: 5, stations: 5 });
  assert.deepEqual(limitsFor('songs'), { songs: 50, albums: 1, artists: 1, mixtapes: 1, stations: 1 });
  assert.deepEqual(CHIPS.map((c) => c.id), ['all', 'songs', 'albums', 'artists', 'mixtapes', 'stations']);
  assert.equal(CHIPS.find((c) => c.id === 'stations').label, 'Radio');
});
test('shortcuts: Ctrl/Cmd+K anywhere; "/" only when not typing', () => {
  const k = (o) => ({ key: '', ...o });
  assert.equal(isSearchShortcut(k({ key: 'k', ctrlKey: true }), { tagName: 'INPUT' }), true);
  assert.equal(isSearchShortcut(k({ key: 'K', metaKey: true }), null), true);
  assert.equal(isSearchShortcut(k({ key: '/' }), { tagName: 'DIV' }), true);
  assert.equal(isSearchShortcut(k({ key: '/' }), { tagName: 'INPUT' }), false);
  assert.equal(isSearchShortcut(k({ key: '/' }), { tagName: 'DIV', isContentEditable: true }), false);
  assert.equal(isSearchShortcut(k({ key: '/', ctrlKey: true }), null), false);
  assert.equal(isSearchShortcut(k({ key: 'k', ctrlKey: true, defaultPrevented: true }), null), false);
  assert.equal(isSearchShortcut(null, null), false); assert.equal(isSearchShortcut(k({ key: 'a' }), null), false);
});
