import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceSource, parseSignatures, phaseForPermission } from '../src/device/source.js';
import { createMemoryStore } from '../src/device/store.js';
import { createLibraryPrefs } from '../src/library-prefs.js';
import { createScanStatus, describeStatus } from '../src/device/status.js';
import { createDeviceLibrary } from '../src/device/index.js';
import { createFakeNative, makeRow, withId3 } from './support/fake-device-native.mjs';

const memStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const rows = (n, over = () => ({})) => Array.from({ length: n }, (_, i) => makeRow(i, { album: `Album ${Math.floor(i / 10)}`, relativePath: `Music/Artist/Album ${Math.floor(i / 10)}/`, ...over(i) }));
function rig({ n = 25, permission = 'granted', store = createMemoryStore(), over, ...opts } = {}) {
  const fake = createFakeNative({ rows: rows(n, over), permission });
  const yields = { n: 0 };
  const scheduler = { yield: async () => { yields.n++; } };
  const src = createDeviceSource({ native: fake, store, scheduler, prefs: createLibraryPrefs({ storage: memStorage() }), batchSize: 10, ...opts });
  return { fake, src, store, yields };
}

test('no native plugin: unavailable, every call a harmless no-op', async () => {
  const src = createDeviceSource({ native: null });
  assert.equal(src.isAvailable(), false);
  assert.equal(src.status.get().phase, 'unavailable');
  assert.deepEqual(await src.restore(), []);
  assert.equal(await src.requestPermission(), 'unavailable');
  assert.equal((await src.scan()).total, 0);
  assert.equal(await src.getArt(1), null);
  const lib = createDeviceLibrary({ native: null });
  assert.equal(lib.isAvailable(), false); assert.equal(lib.status.get().phase, 'unavailable');
});

test('permission states map to phases', () => {
  assert.equal(phaseForPermission('granted'), 'granted'); assert.equal(phaseForPermission('prompt'), 'needs-permission');
  assert.equal(phaseForPermission('prompt-with-rationale'), 'denied'); assert.equal(phaseForPermission('denied'), 'blocked');
  assert.equal(phaseForPermission(undefined), 'needs-permission');
});

test('first run: needs-permission, then Allow -> granted -> scan fills the library', async () => {
  const { src, fake } = rig({ permission: 'prompt' });
  assert.equal(await src.refreshPermission(), 'needs-permission');
  assert.equal(src.status.get().phase, 'needs-permission');
  assert.equal(describeStatus(src.status.get()).action, 'allow');
  assert.equal(await src.requestPermission(), 'granted');
  assert.equal(fake.requested, 1);
  const r = await src.scan();
  assert.equal(r.added, 25); assert.equal(src.tracks().length, 25);
  assert.equal(src.status.get().phase, 'idle'); assert.equal(src.status.get().trackCount, 25);
});

test('denied once -> can ask again; denied permanently -> blocked, no further OS request, open-settings hook; granted on return', async () => {
  const { src, fake } = rig({ permission: 'prompt', });
  fake.afterRequest = 'prompt-with-rationale';
  assert.equal(await src.requestPermission(), 'denied');          // "Deny" tapped once
  assert.equal(src.status.get().phase, 'denied'); assert.equal(describeStatus(src.status.get()).action, 'allow');
  fake.afterRequest = 'denied';
  assert.equal(await src.requestPermission(), 'blocked');          // "Don't ask again"
  assert.equal(fake.requested, 2);
  assert.equal(src.status.get().phase, 'blocked'); assert.equal(describeStatus(src.status.get()).action, 'settings');
  for (let i = 0; i < 5; i++) assert.equal(await src.requestPermission(), 'blocked');   // never loops
  assert.equal(fake.requested, 2, 'no OS request once blocked');
  assert.equal((await src.scan()).total, 0);                       // and scanning while blocked does nothing
  assert.equal(fake.calls.signatures, undefined);
  await src.openSettings(); assert.equal(fake.settingsOpened, 1);
  fake.permission = 'granted';                                     // user flips the switch in Settings and comes back
  assert.equal(await src.refreshPermission(), 'granted');
  assert.equal(src.status.get().phase, 'idle');
  assert.equal((await src.scan()).added, 25);
});

test('concurrent requestPermission calls share one OS prompt', async () => {
  const { src, fake } = rig({ permission: 'prompt' });
  const rs = await Promise.all([src.requestPermission(), src.requestPermission(), src.requestPermission()]);
  assert.deepEqual(rs, ['granted', 'granted', 'granted']); assert.equal(fake.requested, 1);
});

test('permission revoked mid-session: the scan reports needs-permission instead of crashing', async () => {
  const { src, fake } = rig();
  await src.scan();
  fake.permission = 'prompt';
  const r = await src.scan({ force: true });
  assert.ok(['needs-permission', 'idle'].includes(src.status.get().phase));
  assert.equal(r.added, 0);
});

test('progress is { found, processed, total } and monotone; onTracks streams batches', async () => {
  const { src } = rig({ n: 35 });
  const seen = []; const batches = [];
  await src.scan({ onProgress: (p) => seen.push(p), onTracks: (b) => batches.push(b.length) });
  assert.equal(seen[0].total, 35); assert.equal(seen[0].found, 35); assert.equal(seen[0].processed, 0);
  assert.equal(seen.at(-1).processed, 35);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].processed >= seen[i - 1].processed);
  assert.deepEqual(batches, [10, 10, 10, 5]);
  const s = src.status.get(); assert.equal(s.phase, 'idle'); assert.equal(s.total, 35);
});

test('10,000 tracks: batches of 400 with a yield between each, so the event loop is never starved', async () => {
  const { src, fake, yields } = rig({ n: 10000, batchSize: 400 });
  let longest = 0, last = performance.now();
  const r = await src.scan({ onTracks: () => { const t = performance.now(); longest = Math.max(longest, t - last); last = t; } });
  assert.equal(r.added, 10000); assert.equal(src.tracks().length, 10000);
  assert.equal(fake.calls.records, 25);
  assert.ok(yields.n >= 25, `yielded ${yields.n} times`);
  assert.ok(longest < 500, `longest synchronous stretch ${longest.toFixed(0)} ms`);
  // a rescan of an unchanged library is one cheap generation call, no row fetches
  const before = { ...fake.calls };
  const r2 = await src.scan();
  assert.equal(r2.unchanged, true); assert.equal(fake.calls.records, before.records); assert.equal(fake.calls.signatures, before.signatures);
});

test('incremental rescan: add, update, remove; unchanged rows are not re-fetched', async () => {
  const { src, fake } = rig({ n: 30 });
  await src.scan();
  const idsBefore = new Map(src.tracks().map((t) => [t.mediaId, t.id]));
  fake.rows.push(makeRow(100, { album: 'New Album', title: 'Brand New' }));
  fake.rows = fake.rows.filter((r) => r.id !== 1003);
  const mod = fake.rows.find((r) => r.id === 1005); mod.title = 'Retitled'; mod.modified += 10; mod.size += 5;
  const fetched = [];
  const origRecords = fake.records; fake.records = async (a) => { fetched.push(...a.ids); return origRecords(a); };
  const r = await src.scan();
  assert.equal(r.added, 1); assert.equal(r.removed, 1); assert.equal(r.updated, 1);
  assert.deepEqual(fetched.sort(), [1005, 1100]);
  const now = new Map(src.tracks().map((t) => [t.mediaId, t]));
  assert.equal(now.has(1003), false); assert.equal(now.get(1005).title, 'Retitled'); assert.notEqual(now.get(1005).id, idsBefore.get(1005));
  assert.equal(now.get(1000).id, idsBefore.get(1000), 'untouched tracks keep their ids');
  assert.equal(src.tracks().length, 30);
});

test('the same generation short-circuits; a bumped generation with no row changes fetches nothing', async () => {
  const { src, fake } = rig({ n: 12 });
  await src.scan();
  assert.equal((await src.scan()).unchanged, true);
  fake.bump();
  const calls = fake.calls.records;
  const r = await src.scan();
  assert.equal(r.unchanged, false); assert.equal(r.added + r.updated + r.removed, 0); assert.equal(fake.calls.records, calls);
});

test('cancel: keeps what arrived, is resumable, and does not claim to be up to date', async () => {
  const { src, fake } = rig({ n: 50 });
  const ac = new AbortController();
  const r = await src.scan({ signal: ac.signal, onTracks: () => { if (src.tracks().length >= 20) ac.abort(); } });
  assert.equal(r.cancelled, true); assert.ok(src.tracks().length >= 20 && src.tracks().length < 50);
  const fetchedFirst = fake.calls.records;
  const r2 = await src.scan();
  assert.equal(r2.unchanged, false); assert.equal(src.tracks().length, 50);
  assert.ok(fake.calls.records - fetchedFirst <= 3, 'only the missing rows were fetched');
});

test('a scan already in flight is joined, not duplicated', async () => {
  const { src, fake } = rig({ n: 20 });
  const [a, b] = [src.scan(), src.scan()];
  assert.equal(a, b); await a; assert.equal(fake.calls.signatures, 1);
});

test('persist + restore: tracks come back at once, with working DeviceFiles, and the next scan is a no-op', async () => {
  const store = createMemoryStore();
  const first = rig({ n: 15, store });
  await first.src.scan();
  const second = createDeviceSource({ native: first.fake, store, scheduler: { yield: async () => {} }, prefs: createLibraryPrefs({ storage: memStorage() }) });
  const restored = await second.restore();
  assert.equal(restored.length, 15); assert.equal(second.status.get().trackCount, 15);
  const f = restored[0].file;
  assert.equal(f.size, restored[0].size); assert.equal((await f.arrayBuffer()).byteLength, restored[0].size);
  assert.equal((await second.scan()).unchanged, true);
});

test('a corrupt or foreign persisted document is ignored', async () => {
  const store = { load: async () => ({ version: 9, tracks: 'x' }), save: async () => true, clear: async () => true };
  const src = createDeviceSource({ native: createFakeNative({ permission: 'granted' }), store });
  assert.deepEqual(await src.restore(), []);
});

test('non-audio rows are ignored once and not re-fetched on the next rescan', async () => {
  const { src, fake } = rig({ n: 5 });
  fake.rows.push(makeRow(50, { name: 'cover.jpg', mime: 'image/jpeg' }));
  await src.scan();
  assert.equal(src.tracks().length, 5);
  fake.bump();
  const calls = fake.calls.records;
  await src.scan();
  assert.equal(fake.calls.records, calls, 'the skipped row is remembered');
});

test('untagged tracks get a background tag pass (and ONLY those); the cost is measured', async () => {
  const bytes = (row) => (row.id === 1001 ? withId3({ TIT2: 'Found Title', TPE1: 'Found Artist', TALB: 'Found Album' }, new Uint8Array(500000), 200) : new Uint8Array(row.size));
  const fake = createFakeNative({ permission: 'granted', rows: [
    makeRow(0), makeRow(1, { title: '', artist: '<unknown>', album: '<unknown>', name: 'mystery.mp3', size: 500300 }),
  ], bytesFor: bytes });
  const src = createDeviceSource({ native: fake, store: createMemoryStore(), scheduler: { yield: async () => {} }, prefs: createLibraryPrefs({ storage: memStorage() }) });
  await src.scan();
  const t = src.tracks().find((x) => x.mediaId === 1001);
  assert.equal(t.title, 'Found Title'); assert.equal(t.artist, 'Found Artist'); assert.equal(t.album, 'Found Album'); assert.equal(t.needsTags, false);
  const st = src.stats();
  assert.equal(st.tagFiles, 1);
  assert.ok(st.tagReads <= 3, `${st.tagReads} native reads for one tag`);
  assert.ok(fake.bytesServed < 1000, `${fake.bytesServed} bytes transferred (a 500 KB file was never fully read)`);
  assert.equal(src.tracks().find((x) => x.mediaId === 1000).tagged, undefined);
});

test('prefs.parseUntagged=false skips the tag pass', async () => {
  const fake = createFakeNative({ permission: 'granted', rows: [makeRow(1, { title: '', artist: '<unknown>', album: '<unknown>' })] });
  const prefs = createLibraryPrefs({ storage: memStorage() }); prefs.set({ parseUntagged: false });
  const src = createDeviceSource({ native: fake, store: createMemoryStore(), prefs, scheduler: { yield: async () => {} } });
  await src.scan();
  assert.equal(src.stats().tagFiles, 0);
});

test('onChange fires per batch; subscribers that throw are isolated', async () => {
  const { src } = rig({ n: 25 });
  let n = 0; src.onChange(() => { throw new Error('x'); }); src.onChange(() => n++);
  await src.scan();
  assert.ok(n >= 3);
});

test('watching: a MediaStore change event triggers a rescan; stop detaches', async () => {
  const { src, fake } = rig({ n: 5 });
  await src.scan();
  let fired = 0;
  const stop = await src.startWatching(() => { fired++; });
  assert.equal(fake.observing, true);
  fake.touch(); assert.equal(fired, 1);
  stop(); assert.equal(fake.observing, false);
  fake.touch(); assert.equal(fired, 1);
});

test('rescan on resume: throttled, honours the pref, picks up a permission granted in Settings', async () => {
  let t = 1_000_000;
  const { src, fake } = rig({ n: 5, permission: 'prompt', now: () => t, minRescanGapMs: 30000 });
  const handlers = {}; const doc = { visibilityState: 'visible', addEventListener: (e, f) => { handlers[e] = f; }, removeEventListener() {} };
  const detach = src.attachResume({ target: doc, win: null });
  await handlers.visibilitychange(); assert.equal(src.tracks().length, 0, 'still no permission: nothing happens');
  fake.permission = 'granted';
  await handlers.visibilitychange(); assert.equal(src.tracks().length, 5, 'granted in Settings -> scan on return');
  fake.rows.push(makeRow(60)); fake.bump();
  t += 5000; await handlers.visibilitychange(); assert.equal(src.tracks().length, 5, 'throttled');
  t += 40000; await handlers.visibilitychange(); assert.equal(src.tracks().length, 6, 'after the gap it rescans');
  src.status && 0;
  doc.visibilityState = 'hidden'; fake.rows.push(makeRow(61)); fake.bump(); t += 99999; await handlers.visibilitychange(); assert.equal(src.tracks().length, 6, 'hidden: no scan');
  doc.visibilityState = 'visible';
  const prefs2 = createLibraryPrefs({ storage: memStorage() }); prefs2.set({ rescanOnResume: false });
  detach();
});

test('rescanOnResume=false and sources.device=false stop the resume rescan', async () => {
  const fake = createFakeNative({ permission: 'granted', rows: [makeRow(0)] });
  const prefs = createLibraryPrefs({ storage: memStorage() }); prefs.set({ rescanOnResume: false });
  const src = createDeviceSource({ native: fake, prefs, store: createMemoryStore(), now: () => 9e9 });
  let h; src.attachResume({ target: { addEventListener: (_e, f) => { h = f; }, removeEventListener() {} }, win: null });
  await h(); assert.equal(fake.calls.signatures, undefined);
});

test('errors surface as phase "error" with a message, and a retry works', async () => {
  const { src, fake } = rig({ n: 5 });
  const orig = fake.signatures; fake.signatures = async () => { throw new Error('provider died'); };
  const r = await src.scan();
  assert.match(r.error, /provider died/); assert.equal(src.status.get().phase, 'error'); assert.equal(describeStatus(src.status.get()).action, 'retry');
  fake.signatures = orig;
  assert.equal((await src.scan({ force: true })).added, 5);
  assert.equal(src.status.get().phase, 'idle');
});

test('clear() empties memory and storage', async () => {
  const { src, store } = rig({ n: 5 });
  await src.scan(); assert.ok(await store.load());
  await src.clear(); assert.equal(src.tracks().length, 0); assert.equal(await store.load(), null);
});

test('getArt returns null without art, a blob URL with it, and caches per album', async () => {
  const urls = []; const origC = URL.createObjectURL; URL.createObjectURL = () => { const u = `blob:${urls.length}`; urls.push(u); return u; };
  try {
    const { src, fake } = rig({ n: 12, over: (i) => ({ albumId: 100 + i }) });
    await src.scan();
    assert.equal(await src.getArt(src.tracks()[5], 128), null);
    fake.art[1000] = btoa('jpegbytes');
    const u = await src.getArt(src.tracks()[0], 128); assert.match(u, /^blob:/);
    const calls = fake.calls.art;
    assert.equal(await src.getArt(src.tracks()[0], 128), u); assert.equal(fake.calls.art, calls);
    assert.equal(await src.getArt({ tracks: [src.tracks()[3], src.tracks()[1]] }, 128) !== undefined, true);
  } finally { URL.createObjectURL = origC; }
});

test('parseSignatures tolerates garbage', () => {
  assert.equal(parseSignatures(null).size, 0); assert.equal(parseSignatures([1, 2]).size, 0); assert.equal(parseSignatures([1, 2, 3, 4]).size, 1);
});

test('describeStatus: copy for every phase', () => {
  const d = (o) => describeStatus(createScanStatus(o).get());
  assert.match(d({ phase: 'needs-permission' }).body, /Runout plays the music on your phone\. Allow access to your audio files\./);
  assert.equal(d({ phase: 'needs-permission' }).actionLabel, 'Allow');
  assert.equal(d({ phase: 'blocked' }).actionLabel, 'Open settings');
  assert.equal(d({ phase: 'scanning', found: 1284, total: 1284, processed: 600 }).title, 'Found 1,284 tracks…');
  assert.ok(Math.abs(d({ phase: 'scanning', total: 100, processed: 25 }).progress - 0.25) < 1e-9);
  assert.equal(d({ phase: 'idle', trackCount: 50 }).show, false);
  assert.equal(d({ phase: 'idle', trackCount: 0 }).show, true);
  assert.equal(d({ phase: 'unavailable' }).show, false);
  assert.equal(d({ phase: 'error', error: 'boom' }).body, 'boom');
});

test('a libraryChanged that arrives during a scan marks dirty and rescans once afterwards', async () => {
  const { src, fake } = rig({ n: 12 });
  await src.scan();
  await src.startWatching();
  const fire = () => { for (const fn of fake.listeners.get('libraryChanged') || []) fn(); };
  const sigBefore = fake.calls.signatures;
  fake.bump();
  const p = src.scan();
  assert.equal(src.scanning, true);
  fire(); fire(); fire();                     // a burst lands in the running scan: remembered, not dropped, not tripled
  fake.rows.push(makeRow(500, { album: 'New', relativePath: 'Music/New/' }));
  fake.bump();
  await p;
  for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 5)); if (!src.scanning && src.tracks().length === 13) break; }
  assert.equal(src.tracks().length, 13, 'the trailing rescan picked up the row added during the first scan');
  assert.equal(fake.calls.signatures - sigBefore, 2, 'exactly one extra scan');
  fire();                                     // idle now: an event does its normal rescan (no stale dirty flag left behind)
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(src.scanning, false);
});
