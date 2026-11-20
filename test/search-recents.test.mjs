import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECENTS_KEY, MAX_RECENTS, MAX_LEN, parseRecents, serializeRecents, addRecent, removeRecent, loadRecents, saveRecents, clearRecents } from '../src/search/recents.js';
import { createSearchActions, ACTION_NAMES, searchActions, bindSearchActions } from '../src/search/actions.js';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

test('addRecent: newest first, dedupes case/diacritics, trims, caps, ignores short and empty', () => {
  let l = [];
  l = addRecent(l, '  Björk  '); l = addRecent(l, 'queen'); l = addRecent(l, 'BJORK');
  assert.deepEqual(l, ['BJORK', 'queen']);
  l = addRecent(l, 'a'); l = addRecent(l, ''); l = addRecent(l, null); l = addRecent(l, 42);
  assert.deepEqual(l, ['BJORK', 'queen']);
  for (let i = 0; i < 20; i++) l = addRecent(l, 'song ' + i);
  assert.equal(l.length, MAX_RECENTS); assert.equal(l[0], 'song 19');
  assert.equal(addRecent([], 'x'.repeat(500))[0].length, MAX_LEN);
  assert.deepEqual(addRecent([], 'a\u0000b\nc'), ['a b c']);
});
test("'don't remember searches': remember:false never adds", () => {
  assert.deepEqual(addRecent(['old one'], 'new one', { remember: false }), ['old one']);
});
test('removeRecent', () => assert.deepEqual(removeRecent(['a b', 'c d'], 'A  B'.replace('  ', ' ')), ['c d']));
test('storage round trip is versioned; garbage, wrong version and hostile blobs read as empty', () => {
  const st = mem();
  assert.equal(saveRecents(st, ['one', 'two']), true);
  assert.equal(JSON.parse(st.m.get(RECENTS_KEY)).v, 1);
  assert.deepEqual(loadRecents(st), ['one', 'two']);
  for (const bad of ['{', '[]', '{"v":2,"items":["x y"]}', '{"v":1,"items":"no"}', 'x'.repeat(50000), '{"v":1,"items":[1,null,{},"ok"]}']) {
    st.setItem(RECENTS_KEY, bad);
    const r = loadRecents(st); assert.ok(Array.isArray(r) && r.length <= MAX_RECENTS);
  }
  st.setItem(RECENTS_KEY, '{"v":1,"items":[1,null,{},"ok"]}'); assert.deepEqual(loadRecents(st), ['ok']);
  clearRecents(st); assert.deepEqual(loadRecents(st), []);
});
test('storage that throws or is missing never throws', () => {
  const boom = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
  assert.deepEqual(loadRecents(boom), []); assert.equal(saveRecents(boom, ['ab']), false); assert.equal(clearRecents(boom), false);
  assert.deepEqual(loadRecents(null), []); assert.equal(saveRecents(null, ['ab']), false);
  assert.deepEqual(parseRecents(serializeRecents(['ab', 'cd'])), ['ab', 'cd']);
});

test('searchActions: unbound seams answer false; bound ones are awaited; throwing ones answer false; has() tells the UI', async () => {
  const a = createSearchActions();
  for (const n of ACTION_NAMES) { assert.equal(a.has(n), false); assert.equal(await a[n]('x'), false); }
  const calls = [];
  a.bind({ playTrack: async (id) => { calls.push(['t', id]); }, openAlbum: () => { throw new Error('boom'); }, playStation: (s) => { calls.push(['s', s]); return false; }, junk: 1 });
  assert.equal(await a.playTrack('t1'), true); assert.equal(await a.openAlbum('A'), false); assert.equal(await a.playStation('x|y'), false);
  assert.deepEqual(calls, [['t', 't1'], ['s', 'x|y']]);
  assert.ok(a.has('playTrack') && !a.has('addToMixtape'));
  assert.deepEqual([...ACTION_NAMES], ['playTrack', 'openAlbum', 'openArtist', 'openMixtape', 'playStation', 'addToMixtape', 'playTracks']);
  assert.equal(searchActions.has('playTrack'), false); bindSearchActions({ playTrack: () => true }); assert.equal(await searchActions.playTrack('z'), true);
});
