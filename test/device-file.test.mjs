import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceFile, DeviceBlob, DeviceReadError, createReadLimiter, decodeBase64Into, MAX_CHUNK } from '../src/device/device-file.js';
import { readFileTags } from '../src/tags.js';
import { createFakeNative, makeRow, withId3 } from './support/fake-device-native.mjs';

const pattern = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 255);
function rig({ size = 5000, chunkBytes = 1024, limiter, bytes } = {}) {
  const data = bytes || pattern(size);
  const row = makeRow(0, { id: 1, size: data.length });
  const fake = createFakeNative({ rows: [row], bytesFor: () => data, permission: 'granted' });
  const file = new DeviceFile({ backend: fake, id: 1, name: 'a.mp3', size: data.length, type: 'audio/mpeg', lastModified: 5, chunkBytes: Math.max(16 * 1024, chunkBytes), limiter });
  return { data, fake, file };
}
const same = (buf, u8) => assert.deepEqual(new Uint8Array(buf), u8);

test('File-like surface: name, size, type, lastModified, and no stream()', () => {
  const { file } = rig();
  assert.equal(file.name, 'a.mp3'); assert.equal(file.size, 5000); assert.equal(file.type, 'audio/mpeg'); assert.equal(file.lastModified, 5);
  assert.equal(file.stream, undefined);
  assert.equal(Object.prototype.toString.call(file), '[object File]');
});

test('arrayBuffer() reassembles a multi-chunk file byte-for-byte, in order', async () => {
  const { file, data, fake } = rig({ size: 70000, chunkBytes: 16 * 1024 });
  same(await file.arrayBuffer(), data);
  assert.equal(fake.calls.read, 5);   // ceil(70000/16384)
});

test('slice(): offsets, negatives, clamping, nesting and empty windows match Blob', async () => {
  const { file, data } = rig({ size: 50000, chunkBytes: 16 * 1024 });
  const ref = new Blob([data]);
  // (Node 20's Blob.slice aborts the process on NaN / +-Infinity / null, so those are asserted by hand below, not against Blob)
  const cases = [[0, 10], [10], [20000, 40000], [-100], [-100, -50], [49990, 99999], [60000, 70000], [30, 20], [undefined, 5]];
  for (const [a, b] of cases) {
    const got = file.slice(a, b), want = ref.slice(a, b);
    assert.equal(got.size, want.size, `size slice(${a},${b})`);
    same(await got.arrayBuffer(), new Uint8Array(await want.arrayBuffer()));
  }
  assert.equal(file.slice(NaN, 4).size, 4);
  assert.equal(file.slice(null, 5).size, 5);
  assert.equal(file.slice(-Infinity, 3).size, 3);
  const nested = file.slice(1000, 40000).slice(500, -500).slice(10, 20);
  same(await nested.arrayBuffer(), data.subarray(1510, 1520));
  assert.ok(nested instanceof DeviceBlob);
  assert.equal(file.slice(0, Infinity).size, 50000);
  assert.equal(file.slice(5, 5).size, 0);
  assert.equal((await file.slice(5, 5).arrayBuffer()).byteLength, 0);
  assert.equal(file.slice(0, 10, 'audio/x').type, 'audio/x');
});

test('a slice spanning a chunk boundary issues only the reads it needs', async () => {
  const { file, data, fake } = rig({ size: 100000, chunkBytes: 16 * 1024 });
  const w = file.slice(16 * 1024 - 5, 16 * 1024 + 5);
  same(await w.arrayBuffer(), data.subarray(16 * 1024 - 5, 16 * 1024 + 5));
  assert.equal(fake.calls.read, 1);     // 10 bytes: one read (windows are not aligned to chunks)
  assert.ok(fake.bytesServed < 100);
});

test('empty file and zero-length reads make no native call', async () => {
  const { file, fake } = rig({ size: 0, bytes: new Uint8Array(0) });
  assert.equal((await file.arrayBuffer()).byteLength, 0);
  assert.equal(fake.calls.read, undefined);
});

test('concurrency cap: reads in flight never exceed the limiter (shared across files)', async () => {
  const limiter = createReadLimiter({ maxConcurrent: 2, maxBytes: 1 << 30 });
  const { file, data, fake } = rig({ size: 300000, chunkBytes: 16 * 1024, limiter });
  fake.readDelay = 3;
  const fileB = new DeviceFile({ backend: fake, id: 1, name: 'b', size: data.length, chunkBytes: 16 * 1024, limiter });
  const [a, b] = await Promise.all([file.arrayBuffer(), fileB.arrayBuffer()]);
  same(a, data); same(b, data);
  assert.ok(fake.maxInflightReads <= 2, `in flight ${fake.maxInflightReads}`);
  assert.ok(fake.maxInflightReads >= 2);
  assert.equal(limiter.stats().active, 0);
  assert.ok(limiter.stats().peakActive <= 2);
});

test('in-flight BYTES are capped too (a 4 MiB chunk waits for the 6 MiB budget)', async () => {
  const limiter = createReadLimiter({ maxConcurrent: 8, maxBytes: 5 * 1024 * 1024 });
  const { file, data, fake } = rig({ size: 4 * 1024 * 1024 * 3 / 2 | 0, chunkBytes: MAX_CHUNK, limiter });
  fake.readDelay = 2;
  same(await file.arrayBuffer(), data);
  assert.ok(limiter.stats().peakBytes <= 5 * 1024 * 1024 + MAX_CHUNK, 'oversized single holder allowed only alone');
  assert.equal(limiter.stats().active, 0);
});

test('chunkBytes is capped at 4 MiB and floored at 16 KiB', () => {
  const { fake } = rig();
  assert.equal(new DeviceFile({ backend: fake, id: 1, chunkBytes: 99 * 1024 * 1024 })._chunk, MAX_CHUNK);
  assert.equal(new DeviceFile({ backend: fake, id: 1, chunkBytes: 10 })._chunk, 16 * 1024);
});

test('an error mid-read rejects with DeviceReadError and stops issuing chunks', async () => {
  const { file, fake } = rig({ size: 20 * 16 * 1024, chunkBytes: 16 * 1024 });
  fake.failReadAt = 5 * 16 * 1024;
  await assert.rejects(file.arrayBuffer(), (e) => e instanceof DeviceReadError && /native read failed/.test(e.message) && e.offset >= 5 * 16 * 1024);
  assert.ok(fake.calls.read < 20, `stopped early (${fake.calls.read} of 20 chunks issued)`);
});

test('one transient failure is retried; a persistent one is not', async () => {
  const a = rig({ size: 40000, chunkBytes: 16 * 1024 });
  a.fake.failReads = 1;
  same(await a.file.arrayBuffer(), a.data);
  const b = rig({ size: 40000, chunkBytes: 16 * 1024 });
  b.fake.failReads = 99;
  await assert.rejects(b.file.arrayBuffer(), DeviceReadError);
});

test('a short read (file shrank) is an error, not silent truncation', async () => {
  const { fake } = rig({ size: 100 });
  const f = new DeviceFile({ backend: fake, id: 1, name: 'x', size: 5000, chunkBytes: 16 * 1024 });   // MediaStore said 5000, file has 100
  await assert.rejects(f.arrayBuffer(), /short read/);
});

test('a malformed base64 payload is a DeviceReadError', async () => {
  const f = new DeviceFile({ backend: { read: async () => ({ data: '!!!not base64!!!' }) }, id: 1, size: 10 });
  await assert.rejects(f.arrayBuffer(), DeviceReadError);
});

test('decodeBase64Into refuses to overflow its destination', () => {
  assert.throws(() => decodeBase64Into(btoa('abcdef'), new Uint8Array(3)), RangeError);
  assert.equal(decodeBase64Into('', new Uint8Array(3)), 0);
});

test('tags.js reads an ID3 tag through the DeviceFile head window (the real code path, unchanged)', async () => {
  const bytes = withId3({ TIT2: 'Heat Wave', TPE1: 'Martha', TALB: 'Reeling' }, pattern(200000), 300);
  const { file, fake } = rig({ bytes, chunkBytes: 16 * 1024 });
  const meta = await readFileTags(file, { duration: false });   // what the device source passes: MediaStore already has the duration, so no MP3 frame read
  assert.equal(meta.title, 'Heat Wave'); assert.equal(meta.artist, 'Martha'); assert.equal(meta.album, 'Reeling');
  assert.ok(fake.calls.read <= 3, `tag read used ${fake.calls.read} native reads`);
  assert.ok(fake.bytesServed < 2000, 'only the tag was transferred, not the 200 KB of audio');
});
