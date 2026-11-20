import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryPrefs, normalizePrefs, DEFAULT_PREFS, PREFS_KEY, clearLibraryCache, registerCacheClearer } from '../src/library-prefs.js';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

test('defaults: 30 s minimum, the system-sound folders excluded, both sources on', () => {
  const p = createLibraryPrefs({ storage: mem() }).get();
  assert.equal(p.minDurationSec, 30); assert.equal(p.rescanOnResume, true); assert.equal(p.sources.device, true); assert.equal(p.sources.folder, true);
  for (const f of ['WhatsApp Audio', 'Ringtones', 'Notifications', 'Alarms', 'Recordings']) assert.ok(p.excludeFolders.includes(f), f);
  assert.deepEqual([...p.includeFolders], []);
});

test('set() merges, validates, persists in a versioned envelope, and notifies once with the changed keys', () => {
  const st = mem(); const p = createLibraryPrefs({ storage: st });
  const seen = []; p.subscribe((s, keys) => seen.push(keys));
  p.set({ minDurationSec: 45, sources: { device: false } });
  assert.equal(p.get().minDurationSec, 45); assert.equal(p.get().sources.device, false); assert.equal(p.get().sources.folder, true);
  assert.deepEqual(seen, [['sources', 'minDurationSec']].map((k) => k[0] && ['sources', 'minDurationSec']));
  const env = JSON.parse(st.m.get(PREFS_KEY)); assert.equal(env.v, 1); assert.equal(env.prefs.minDurationSec, 45);
  p.set({ minDurationSec: 45 }); assert.equal(seen.length, 1, 'no-op set does not notify');
  assert.equal(createLibraryPrefs({ storage: st }).get().minDurationSec, 45, 'survives a reload');
});

test('invalid values are repaired field by field, never thrown', () => {
  const p = createLibraryPrefs({ storage: mem() });
  p.set({ minDurationSec: -5, rescanOnResume: 'yes', excludeFolders: ['  a/b\\ ', '', 5, 'A/B', null], includeFolders: 'nope', sources: { device: 'x' } });
  const s = p.get();
  assert.equal(s.minDurationSec, 30); assert.equal(s.rescanOnResume, true); assert.equal(s.sources.device, true);
  assert.deepEqual([...s.excludeFolders], ['a/b']); assert.deepEqual([...s.includeFolders], []);
  assert.doesNotThrow(() => p.set(null)); assert.doesNotThrow(() => p.set('x'));
});

test('corrupt JSON, a future version, and throwing / missing storage all fall back to defaults', () => {
  for (const raw of ['{not json', JSON.stringify({ v: 99, prefs: { minDurationSec: 1 } }), JSON.stringify([1]), 'null']) {
    const st = mem(); st.m.set(PREFS_KEY, raw);
    assert.equal(createLibraryPrefs({ storage: st }).get().minDurationSec, 30, raw);
  }
  const boom = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const p = createLibraryPrefs({ storage: boom });
  assert.equal(p.get().minDurationSec, 30);
  assert.doesNotThrow(() => p.set({ minDurationSec: 60 }));
  assert.equal(p.get().minDurationSec, 60, 'still works in memory');
  assert.doesNotThrow(() => p.reset());
  assert.equal(createLibraryPrefs({ storage: null }).get().minDurationSec, 30);
});

test('a throwing subscriber does not break the others; unsubscribe works; reset restores defaults', () => {
  const p = createLibraryPrefs({ storage: mem() });
  let n = 0; p.subscribe(() => { throw new Error('x'); }); const off = p.subscribe(() => n++);
  p.set({ minDurationSec: 10 }); assert.equal(n, 1);
  off(); p.set({ minDurationSec: 11 }); assert.equal(n, 1);
  p.reset(); assert.equal(p.get().minDurationSec, 30);
});

test('normalizePrefs ignores unknown keys; limits list length', () => {
  const s = normalizePrefs({ evil: 1, excludeFolders: Array.from({ length: 500 }, (_, i) => `f${i}`) });
  assert.equal('evil' in s, false); assert.equal(s.excludeFolders.length, 200);
  assert.equal(normalizePrefs(undefined).minDurationSec, DEFAULT_PREFS.minDurationSec);
});

test('clearLibraryCache runs every registered clearer, survives a failing one, and does not touch prefs', async () => {
  const calls = []; const off1 = registerCacheClearer(() => calls.push('a')); const off2 = registerCacheClearer(() => { throw new Error('x'); });
  const ok = await clearLibraryCache({ clearFolderIndex: async () => calls.push('folder') });
  assert.deepEqual(calls.sort(), ['a', 'folder']); assert.equal(ok, 2);
  off1(); off2();
  assert.equal(await clearLibraryCache({ clearFolderIndex: null }), 0);
});
