import test from 'node:test';
import assert from 'node:assert/strict';
import { createArtwork, scaleToFit, stripDataUrl } from '../src/artwork.js';

test('scaleToFit keeps the aspect ratio, never upscales, rejects nonsense', () => {
  assert.deepEqual(scaleToFit(1000, 500, 512), { w: 512, h: 256 });
  assert.deepEqual(scaleToFit(200, 100, 512), { w: 200, h: 100 });
  assert.deepEqual(scaleToFit(300, 3000, 512), { w: 51, h: 512 });
  assert.equal(scaleToFit(0, 10), null); assert.equal(scaleToFit(NaN, 10), null);
});

test('stripDataUrl takes jpeg / png base64 only', () => {
  assert.equal(stripDataUrl('data:image/jpeg;base64,QUJD'), 'QUJD');
  assert.equal(stripDataUrl('data:image/png;base64,QUJD'), 'QUJD');
  assert.equal(stripDataUrl('data:text/html;base64,QUJD'), null);
  assert.equal(stripDataUrl('blob:abc'), null); assert.equal(stripDataUrl(''), null); assert.equal(stripDataUrl(null), null);
  assert.equal(stripDataUrl('data:image/jpeg;base64,' + 'A'.repeat(1_600_000)), null);
});

function rig(over = {}) {
  const r = { fetched: [], draws: [], canvases: [] };
  r.art = createArtwork({
    fetchBlob: async (u) => { r.fetched.push(u); if (u.includes('bad')) throw new Error('404'); return { u }; },
    decode: async () => ({ width: 1200, height: 900, draw: (ctx, w, h) => r.draws.push([w, h]), close() {} }),
    makeCanvas: (w, h) => { r.canvases.push([w, h]); return { getContext: () => ({ fillRect() {}, set fillStyle(v) {} }), toDataURL: () => 'data:image/jpeg;base64,QUJDRA==' }; },
    ...over,
  });
  return r;
}

test('converts once, scaled to 512 px, and answers from the cache afterwards (peek is synchronous)', async () => {
  const r = rig();
  assert.equal(r.art.peek('blob:a'), undefined);
  assert.equal(await r.art.get('blob:a'), 'QUJDRA==');
  assert.deepEqual(r.canvases[0], [512, 384]); assert.deepEqual(r.draws[0], [512, 384]);
  assert.equal(r.art.peek('blob:a'), 'QUJDRA==');
  assert.equal(await r.art.get('blob:a'), 'QUJDRA=='); assert.equal(r.fetched.length, 1);
  const [x, y] = await Promise.all([r.art.get('blob:b'), r.art.get('blob:b')]); assert.equal(x, y); assert.equal(r.fetched.length, 2, 'concurrent asks share one conversion');
});

test('a failure resolves null (never rejects) and is remembered', async () => {
  const r = rig();
  assert.equal(await r.art.get('blob:bad'), null); assert.equal(r.art.peek('blob:bad'), null);
  assert.equal(await r.art.get('blob:bad'), null); assert.equal(r.fetched.length, 1);
  assert.equal(await r.art.get(''), null); assert.equal(await r.art.get(undefined), null);
});

test('the cache holds a handful of albums only', async () => {
  const r = rig();
  for (let i = 0; i < 9; i++) await r.art.get('blob:' + i);
  assert.equal(r.art.peek('blob:0'), undefined); assert.equal(r.art.peek('blob:8'), 'QUJDRA==');
});
