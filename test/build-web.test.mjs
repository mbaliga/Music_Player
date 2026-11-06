import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildWeb, listFiles, reachableFiles, DENY } from '../scripts/build-web.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'test-build';
let tmp;
async function build(name) { const out = resolve(tmp, name); await buildWeb({ outDir: out, buildId: ID, quiet: true }); return out; }
async function digest(dir) {
  const h = createHash('sha256');
  for (const f of await listFiles(dir)) { h.update(f); h.update(await readFile(resolve(dir, f))); }
  return h.digest('hex');
}
test.before(async () => { tmp = await mkdtemp(resolve(tmpdir(), 'runout-build-')); });
test.after(async () => { await rm(tmp, { recursive: true, force: true }); });

test('dev-only radio files are absent from the build, runtime files present', async () => {
  const out = await build('a');
  const files = await listFiles(out);
  for (const d of DENY) assert.equal(files.includes(d), false, d);
  assert.deepEqual(DENY.length >= 4, true);
  assert.equal(files.some((f) => /README\.md$/.test(f) && f.startsWith('src/radio/')), false);
  for (const f of ['index.html', 'src/main.js', 'src/radio/core/index.js', 'src/radio/core/cues.js', 'src/radio/flag.js', 'src/worklet.js']) assert.ok(files.includes(f), f);
  assert.match(await readFile(resolve(out, 'index.html'), 'utf8'), /test-build/);
});

test('every module reachable from index.html (static, dynamic, new URL) is shipped, including the lazy radio core', async () => {
  const out = await build('b');
  const r = await reachableFiles(out);
  assert.deepEqual(r.missing, []);
  const src = await reachableFiles(root);
  assert.deepEqual(src.missing, []);
  // the reachable set of the staged app equals that of the source tree: nothing reachable was dropped
  assert.deepEqual(r.files, src.files);
  assert.ok(r.files.includes('src/radio/core/index.js'), 'dynamic import target');
  assert.ok(r.files.includes('src/radio/core/cues.js'), 'transitive core module');
  assert.ok(r.files.includes('src/worklet.js'), 'new URL(...) target');
  // and no reachable file is a dev-only one
  for (const d of DENY) assert.equal(r.files.includes(d), false, `${d} reachable from the shipped app`);
  // every core module the shipped barrel reaches exists in the output
  const files = new Set(await listFiles(out));
  for (const f of r.files) assert.ok(files.has(f), f);
});

test('the staged radio core actually loads (flag-on path) without the dev files', async () => {
  const out = await build('c');
  const core = await import(resolve(out, 'src/radio/core/index.js') + `?x=${Date.now()}`);
  assert.equal(typeof core.scheduleShow, 'function');
  assert.equal(typeof core.extractCues, 'function');
  assert.equal('runSimulatedShow' in core, false);
});

test('the build is deterministic', async () => {
  const a = await build('d1'), b = await build('d2');
  assert.deepEqual(await listFiles(a), await listFiles(b));
  assert.equal(await digest(a), await digest(b));
});
