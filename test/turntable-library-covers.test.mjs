// turntable-library-covers.test.mjs — covers.js: seeds, painted styles, cover-art URLs, the canvas cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashSeed, coverSpec, specForAlbum, paintCover, drawImageCover, coverPixelSize, fitSize, sniffImageMime,
  coverBlobUrl, revokeCoverUrl, revokeAllCoverUrls, isTrackedCoverUrl, trackedCoverUrlCount, createCoverCache, COVER_STYLE_COUNT,
} from '../src/turntable/covers.js';

/** A recording 2d context: every call and every property assignment is logged. */
function recCtx() {
  const log = [];
  const g = new Proxy({}, {
    get(t, k) {
      if (k === '__log') return log;
      if (k === 'measureText') return (s) => ({ width: String(s).length * 7 });
      if (k === 'createLinearGradient') return (...a) => { log.push(['createLinearGradient', ...a]); return { addColorStop: (...b) => log.push(['stop', ...b]) }; };
      if (k in t) return t[k];
      return (...a) => { log.push([k, ...a]); };
    },
    set(t, k, v) { t[k] = v; log.push(['set', k, typeof v === 'object' ? '[gradient]' : v]); return true; },
  });
  return g;
}

test('hashSeed: stable FNV-1a, 32-bit unsigned', () => {
  assert.equal(hashSeed(''), 0x811c9dc5);
  assert.equal(hashSeed('a'), 0xe40c292c);
  assert.equal(hashSeed('foobar'), 0xbf9cf968);
  assert.equal(hashSeed('Ann\u0000Blue'), hashSeed('Ann\u0000Blue'));
  assert.notEqual(hashSeed('Ann\u0000Blue'), hashSeed('Ann\u0000Blu'));
  assert.equal(hashSeed(undefined), hashSeed(''));
  for (const s of ['日本語', '☂', 'x'.repeat(5000)]) { const h = hashSeed(s); assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff); }
});

test('coverSpec: deterministic, in range, all five styles reachable', () => {
  const styles = new Set();
  for (let i = 0; i < 400; i++) {
    const s = coverSpec(hashSeed('album ' + i), 't', 'a');
    assert.deepEqual(s, coverSpec(hashSeed('album ' + i), 't', 'a'));
    assert.ok(s.hue[0] >= 0 && s.hue[0] < 360 && s.hue[1] >= 0 && s.hue[1] < 360);
    assert.ok(s.style >= 0 && s.style < COVER_STYLE_COUNT && s.idx >= 0 && s.idx < 5);
    styles.add(s.style);
  }
  assert.equal(styles.size, COVER_STYLE_COUNT);
  assert.deepEqual(coverSpec(0).hue.length, 2);
});

test('specForAlbum honours a coverSpec override (prototype hues), else derives from the seed', () => {
  const a = { coverSeed: 7, title: 'T', artist: 'A' };
  assert.deepEqual(specForAlbum(a), coverSpec(7, 'T', 'A'));
  const s = specForAlbum({ ...a, coverSpec: { hue: [18, 48], style: 2 } });
  assert.deepEqual(s.hue, [18, 48]); assert.equal(s.style, 2); assert.equal(s.name, 'T');
  assert.equal(specForAlbum({ ...a, coverSpec: { hue: [1, 2], style: -1 } }).style, 4);
});

test('paintCover: each style paints, deterministically, without throwing', () => {
  const logs = [];
  for (let style = 0; style < COVER_STYLE_COUNT; style++) {
    const spec = { hue: [200, 300], style, idx: 3, name: 'Slow Tide', footer: 'Runout' };
    const g1 = recCtx(), g2 = recCtx();
    paintCover(g1, 360, spec); paintCover(g2, 360, spec);
    assert.deepEqual(g1.__log, g2.__log);
    assert.ok(g1.__log.length > 10);
    assert.equal(g1.__log[0][0], 'createLinearGradient');
    const texts = g1.__log.filter((e) => e[0] === 'fillText').map((e) => e[1]);
    assert.deepEqual(texts, ['SLOW', 'TIDE', 'RUNOUT']);
    logs.push(JSON.stringify(g1.__log));
  }
  assert.equal(new Set(logs).size, COVER_STYLE_COUNT, 'five distinct motifs');
  paintCover(null, 100, {});   // no context (canvas unavailable): a no-op
});

test('paintCover: huge / odd titles stay bounded; markup is just text', () => {
  const g = recCtx();
  paintCover(g, 360, { hue: [1, 2], style: 0, idx: 0, name: '<img src=x onerror=alert(1)> ' + 'word '.repeat(2000), footer: 'F'.repeat(5000) });
  const texts = g.__log.filter((e) => e[0] === 'fillText').map((e) => e[1]);
  assert.ok(texts.length <= 8);
  assert.ok(texts.every((t) => t.length <= Math.ceil(360 * .86 / 7) + 2), 'each line was fitted to the cover width');
  assert.equal(texts[0], '<IMG');
  const h = recCtx(); paintCover(h, 360, { hue: [1, 2], style: 1, name: '', footer: '' });
  assert.equal(h.__log.filter((e) => e[0] === 'fillText').map((e) => e[1]).pop(), 'BALIGA');
});

test('drawImageCover centre-crops to a square', () => {
  const g = recCtx();
  assert.equal(drawImageCover(g, 256, { naturalWidth: 400, naturalHeight: 200 }), true);
  assert.deepEqual(g.__log[0], ['drawImage', { naturalWidth: 400, naturalHeight: 200 }, 100, 0, 200, 200, 0, 0, 256, 256]);
  assert.equal(drawImageCover(g, 256, { width: 0, height: 0 }), false);
});

test('coverPixelSize: multiple of 64, 128..512, dpr counted up to 2', () => {
  assert.equal(coverPixelSize(247, 1), 256);
  assert.equal(coverPixelSize(247, 2), 512);
  assert.equal(coverPixelSize(223, 2.5), 448);   // dpr counts up to 2: 446 px -> 448
  assert.equal(coverPixelSize(40, 1), 128);
  assert.equal(coverPixelSize(2000, 3), 512);
  assert.equal(coverPixelSize(300, 1, 256), 256);
});

test('fitSize: downscale only, keeps aspect, max 512', () => {
  assert.deepEqual(fitSize(3000, 1500), { w: 512, h: 256, scale: 512 / 3000 });
  assert.deepEqual(fitSize(300, 300), { w: 300, h: 300, scale: 1 });
  assert.deepEqual(fitSize(0, 10), { w: 0, h: 0, scale: 1 });
  assert.equal(fitSize(1, 5000).h, 512); assert.equal(fitSize(1, 5000).w, 1);
});

test('sniffImageMime from magic bytes', () => {
  assert.equal(sniffImageMime(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(sniffImageMime(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 13)), 'image/png');
  assert.equal(sniffImageMime(Uint8Array.of(0x47, 0x49, 0x46, 0x38)), 'image/gif');
  assert.equal(sniffImageMime(Uint8Array.from([...'RIFF....WEBP'].map((c) => c.charCodeAt(0)))), 'image/webp');
  assert.equal(sniffImageMime(Uint8Array.of(1, 2, 3, 4)), null);
  assert.equal(sniffImageMime(null), null);
  assert.equal(sniffImageMime(Uint8Array.of(1)), null);
});

function fakeUrlApi() {
  let n = 0; const live = new Set(); const blobs = [];
  class FBlob { constructor(parts, o) { this.parts = parts; this.type = o.type; } }
  return { live, blobs, Blob: FBlob, create: (b) => { blobs.push(b); const u = 'blob:fake/' + (++n); live.add(u); return u; }, revoke: (u) => live.delete(u) };
}

test('coverBlobUrl: tracked object URLs, mime sniffed, revocation', () => {
  const api = fakeUrlApi();
  const jpg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2);
  const u1 = coverBlobUrl(jpg, 'image/png', api);              // the tag said png but the bytes are jpeg
  const u2 = coverBlobUrl(Uint8Array.of(9, 9, 9, 9), 'image/webp', api);
  const u3 = coverBlobUrl(Uint8Array.of(9, 9, 9, 9), 'text/html', api);   // never trust a non-image mime
  assert.equal(api.blobs[0].type, 'image/jpeg'); assert.equal(api.blobs[1].type, 'image/webp'); assert.equal(api.blobs[2].type, 'image/jpeg');
  assert.ok(isTrackedCoverUrl(u1) && isTrackedCoverUrl(u2));
  assert.equal(trackedCoverUrlCount(), 3);
  assert.equal(revokeCoverUrl(u1), true); assert.equal(api.live.has(u1), false);
  assert.equal(revokeCoverUrl(u1), false, 'idempotent');
  assert.equal(revokeCoverUrl('blob:not-ours'), false);
  revokeAllCoverUrls();
  assert.equal(trackedCoverUrlCount(), 0); assert.equal(api.live.size, 0);
  assert.equal(coverBlobUrl(null, 'image/jpeg', api), null);
  assert.equal(coverBlobUrl(new Uint8Array(0), 'image/jpeg', api), null);
  assert.equal(coverBlobUrl(jpg, 'image/jpeg', { create() { throw new Error('x'); }, revoke() {}, Blob: api.Blob }), null);
});

test('createCoverCache: LRU cap, painted once, resized on a size change, freed on evict', async () => {
  const made = [];
  const mk = () => { const c = { width: 0, height: 0, getContext: () => recCtx() }; made.push(c); return c; };
  const cache = createCoverCache({ max: 3, makeCanvas: mk, loadImage: () => Promise.reject(new Error('none')) });
  const al = (i) => ({ id: 'a' + i, title: 'T' + i, artist: 'A', coverSeed: i });
  const A = [0, 1, 2, 3, 4].map(al);
  const c0 = cache.get(A[0], 256);
  assert.equal(c0.width, 256);
  assert.equal(cache.get(A[0], 256), c0, 'cached canvas is reused');
  cache.get(A[1], 256); cache.get(A[2], 256);
  cache.get(A[0], 256);                                      // touch a0: a1 becomes the oldest
  cache.get(A[3], 256);
  assert.equal(cache.size, 3);
  assert.equal(made[1].width, 0, 'evicted canvas is shrunk to free its bitmap');
  assert.equal(made[0].width, 256);
  assert.equal(made.length, 4);
  cache.get(A[0], 512); assert.equal(c0.width, 512);
  cache.clear(); assert.equal(cache.size, 0); assert.equal(c0.width, 0);
  assert.equal(cache.get(null, 256), null);
  cache.destroy(); assert.equal(cache.get(A[0], 256), null);
});

test('createCoverCache: embedded artwork is drawn over the painted cover once loaded; stale loads are ignored', async () => {
  const draws = []; const changed = [];
  const mkCtx = (tag) => { const g = recCtx(); return new Proxy({}, { get: (t, k) => (k === 'drawImage' ? (...a) => draws.push([tag, ...a]) : g[k]), set: (t, k, v) => { g[k] = v; return true; } }); };
  let n = 0;
  const mk = () => { const tag = 'c' + n++; const c = { width: 0, height: 0 }; const ctx = mkCtx(tag); c.getContext = () => ctx; return c; };
  const pending = [];
  const cache = createCoverCache({ max: 2, makeCanvas: mk, onChange: (id) => changed.push(id), loadImage: (u) => new Promise((res) => pending.push([u, res])) });
  const a = { id: 'x', title: 'X', artist: 'A', coverSeed: 1, coverUrl: 'blob:1' };
  cache.get(a, 128);
  assert.equal(pending.length, 1);
  pending[0][1]({ naturalWidth: 10, naturalHeight: 10 });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(draws.length, 1); assert.deepEqual(changed, ['x']);
  // a repaint (size change) starts a new load; the first one resolving late must not draw
  cache.get(a, 256);
  assert.equal(pending.length, 2);
  pending[1][1]({ naturalWidth: 10, naturalHeight: 10 });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(draws.length, 2);
  // an evicted album's late image is dropped
  cache.get({ id: 'y', title: 'Y', artist: 'A', coverSeed: 2, coverUrl: 'blob:2' }, 128);
  cache.get({ id: 'z', title: 'Z', artist: 'A', coverSeed: 3 }, 128);
  cache.get({ id: 'w', title: 'W', artist: 'A', coverSeed: 4 }, 128);   // evicts x then y
  const before = draws.length;
  pending[2][1]({ naturalWidth: 10, naturalHeight: 10 });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(draws.length, before);
});
