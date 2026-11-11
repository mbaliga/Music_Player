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

// ── canned stations: data shipped beside src/, code lazy ─────────────────────
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { validatePackDoc } from '../src/radio/canned/pack.js';
import { buildStationsIndex, serializeIndex } from '../scripts/stations-index.mjs';

test('the canned station packs ship into stations/ with a generated index; dev-only content files do not', async () => {
  const out = await build('s1');
  const files = await listFiles(out);
  const packs = (await readdir(resolve(root, 'content/stations'))).filter((f) => f.endsWith('.json') && !f.startsWith('_') && f !== 'index.json').sort();
  assert.equal(packs.length, 6);
  for (const f of packs) {
    assert.ok(files.includes(`stations/${f}`), f);
    assert.equal(await readFile(resolve(out, 'stations', f), 'utf8'), await readFile(resolve(root, 'content/stations', f), 'utf8'));
    assert.deepEqual(validatePackDoc(JSON.parse(await readFile(resolve(out, 'stations', f), 'utf8'))).errors, []);
  }
  assert.ok(files.includes('stations/index.json'));
  const idx = JSON.parse(await readFile(resolve(out, 'stations/index.json'), 'utf8'));
  assert.deepEqual(idx.stations.map((s) => s.file), packs);
  // the shipped index is exactly what the generator produces and what is committed
  assert.equal(await readFile(resolve(out, 'stations/index.json'), 'utf8'), serializeIndex(buildStationsIndex()));
  assert.equal(await readFile(resolve(root, 'content/stations/index.json'), 'utf8'), serializeIndex(buildStationsIndex()), 'committed content/stations/index.json is stale: run node scripts/stations-index.mjs');
  assert.equal(files.some((f) => /(^|\/)(README\.md|_stoplist\.json)$/.test(f) && f.startsWith('stations/')), false);
  assert.equal(files.some((f) => f.startsWith('audio/')), false, 'no audio pack exists in this build');
});

test('canned code is reachable only lazily: dial + session via dynamic import, the packs are fetched not imported', async () => {
  const out = await build('s2');
  const r = await reachableFiles(out);
  assert.deepEqual(r.missing, []);
  for (const f of ['src/radio/canned/index.js', 'src/radio/canned/dial.js', 'src/radio/canned/runner.js', 'src/radio/canned/chooser.js', 'src/radio/canned/catalog.js']) assert.ok(r.files.includes(f), f);
  assert.equal(r.files.some((f) => f.startsWith('stations/')), false);
});

test('an optional audio pack directory is copied to audio/ and flagged in the index; an invalid pack fails the build', async () => {
  const sd = resolve(tmp, 'src-stations'), ad = resolve(tmp, 'src-audio');
  await mkdir(sd, { recursive: true }); await mkdir(resolve(ad, 'meridian-91-5'), { recursive: true });
  for (const f of ['meridian-91-5.json', 'tape-hiss-fm.json']) await writeFile(resolve(sd, f), await readFile(resolve(root, 'content/stations', f)));
  await writeFile(resolve(sd, '_stoplist.json'), '{}');
  await writeFile(resolve(ad, 'meridian-91-5/manifest.json'), JSON.stringify({ v: 1, station: 'meridian-91-5', segments: [] }));
  const out = resolve(tmp, 'aud');
  await buildWeb({ outDir: out, buildId: ID, quiet: true, stationsDir: sd, audioDir: ad });
  const files = await listFiles(out);
  assert.ok(files.includes('audio/meridian-91-5/manifest.json'));
  assert.equal(files.includes('stations/_stoplist.json'), false);
  const idx = JSON.parse(await readFile(resolve(out, 'stations/index.json'), 'utf8'));
  assert.deepEqual(idx.stations.map((s) => [s.id, s.audio === true]), [['meridian-91-5', true], ['tape-hiss-fm', false]]);
  // invalid pack
  const bad = resolve(tmp, 'bad-stations'); await mkdir(bad, { recursive: true });
  const doc = JSON.parse(await readFile(resolve(root, 'content/stations/meridian-91-5.json'), 'utf8')); doc.segments[0].lines = [];
  await writeFile(resolve(bad, 'meridian-91-5.json'), JSON.stringify(doc));
  await assert.rejects(buildWeb({ outDir: resolve(tmp, 'bad'), buildId: ID, quiet: true, stationsDir: bad, audioDir: resolve(tmp, 'none') }), /invalid/);
});
