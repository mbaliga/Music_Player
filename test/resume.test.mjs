import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, resolve, isMeaningful, createSaver, load, save, RESUME_KEY } from '../src/resume.js';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
const shelf = [
  { id: 'a1', tracks: [{ id: 'd2-1', file: {}, durationSec: 100 }, { id: 'd2-2', file: {}, durationSec: 200 }, { id: 'd2-3', durationSec: 50 }] },
  { id: 'a2', tracks: [{ id: 'x', file: {} }] },
];

test('sanitize drops junk and clamps', () => {
  assert.equal(sanitize(null), null);
  assert.equal(sanitize({ albumId: 5 }), null);
  assert.equal(sanitize({ albumId: '' }), null);
  const r = sanitize({ albumId: 'a', trackId: 'd2-9', index: -3, t: -4, view: 'weird' });
  assert.deepEqual([r.index, r.t, r.view], [0, 0, 'vinyl']);
  assert.equal(sanitize({ albumId: 'a', t: NaN }).t, 0);
});

test('resolve finds the track by its stable id, not its index', () => {
  const r = resolve({ albumId: 'a1', trackId: 'd2-2', index: 0, t: 61.26 }, shelf);
  assert.deepEqual(r, { shelfIndex: 0, trackIndex: 1, t: 61.3 });
});

test('resolve: missing album, track, file or unsupported format -> null (quiet first-run fallback)', () => {
  assert.equal(resolve({ albumId: 'zz', trackId: 'd2-1', t: 5 }, shelf), null);
  assert.equal(resolve({ albumId: 'a1', trackId: 'd2-99', t: 5 }, shelf), null);
  assert.equal(resolve({ albumId: 'a1', trackId: 'd2-3', t: 5 }, shelf), null);               // no file
  assert.equal(resolve({ albumId: 'a1', trackId: 'd2-1', t: 5 }, shelf, () => false), null);   // unsupported
  assert.equal(resolve('garbage', shelf), null);
  assert.equal(resolve({ albumId: 'a1', trackId: 'd2-1' }, null), null);
});

test('resolve: no ids in the record -> the index; and a position at the very end restarts the track', () => {
  assert.equal(resolve({ albumId: 'a1', index: 1, t: 3 }, shelf).trackIndex, 1);
  assert.equal(resolve({ albumId: 'a1', index: 9, t: 3 }, shelf), null);
  assert.equal(resolve({ albumId: 'a1', trackId: 'd2-1', t: 99 }, shelf).t, 0);
});

test('isMeaningful', () => {
  assert.equal(isMeaningful(null), false);
  assert.equal(isMeaningful({ trackIndex: 0, t: 1 }), false);
  assert.equal(isMeaningful({ trackIndex: 0, t: 2 }), true);
  assert.equal(isMeaningful({ trackIndex: 2, t: 0 }), true);
});

test('saver: throttled while playing, forced on flush, skips identical and null snapshots', () => {
  let clock = 0, snap = { albumId: 'a', trackId: 't', index: 0, t: 1, view: 'vinyl' }; const writes = [];
  const s = createSaver({ snapshot: () => snap, write: (r) => writes.push(r), now: () => clock, minGapMs: 4000 });
  assert.equal(s.tick(), true);                       // first write
  snap = { ...snap, t: 2 }; clock = 1000; assert.equal(s.tick(), false);   // too soon
  clock = 5000; assert.equal(s.tick(), true);
  assert.equal(s.tick(), false);                      // identical
  snap = { ...snap, t: 9 }; clock = 5100; assert.equal(s.flush(), true);   // pause: forced
  snap = null; clock = 99999; assert.equal(s.flush(), false);               // nothing resumable (demo / tape): stored record untouched
  assert.deepEqual(writes.map((w) => w.t), [1, 2, 9]);
  assert.equal(writes[2].at, 5100);
});

test('load / save round trip and a throwing storage', () => {
  const st = mem();
  assert.equal(load(st), null);
  save(st, sanitize({ albumId: 'a', trackId: 'd2-1', t: 5 }));
  assert.equal(load(st).trackId, 'd2-1');
  st.setItem(RESUME_KEY, '{bad'); assert.equal(load(st), null);
  const bad = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
  assert.equal(load(bad), null); assert.equal(save(bad, { albumId: 'a' }), false);
  save(st, null); assert.equal(st.m.has(RESUME_KEY), false);
});
