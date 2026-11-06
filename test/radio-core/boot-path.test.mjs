// `radio.ai` is OFF by default and, when off, the radio core must not be on the app's boot path:
// not statically reachable from index.html, not fetched, and no AI station type registered.
// The web build (scripts/build-web.mjs) stages index.html + src/ unbundled, so the browser's static
// import graph from index.html IS the boot path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(p, 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1'); // comments may mention the core; code may not
const CORE = `src${sep}radio${sep}core${sep}`;

const staticImports = (src) => [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1]);
const dynamicImports = (src) => [...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);

function bootGraph() {
  const html = read(resolve(root, 'index.html'));
  const entries = [...html.matchAll(/<script[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/g)].map((m) => resolve(root, m[1]));
  // inline module scripts can import too
  const inline = [...html.matchAll(/<script[^>]*\btype=["']module["'][^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((t) => t.trim());
  const seen = new Set(), dyn = [];
  const queue = [...entries];
  for (const code of inline) for (const spec of staticImports(code)) queue.push(resolve(root, spec));
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = read(f);
    for (const spec of staticImports(src)) if (spec.startsWith('.')) queue.push(resolve(dirname(f), spec));
    for (const spec of dynamicImports(src)) dyn.push({ from: relative(root, f), spec });
  }
  return { files: [...seen].map((f) => relative(root, f)), dyn, entries: entries.map((f) => relative(root, f)) };
}

test('boot graph: starts at index.html, includes the station seam and the flag, and never the core', () => {
  const g = bootGraph();
  assert.deepEqual(g.entries, [`src${sep}main.js`]);
  for (const f of ['main.js', 'stations.js', 'radio-player.js', `radio${sep}flag.js`]) assert.ok(g.files.includes(`src${sep}${f}`), f);
  assert.ok(g.files.length > 10);
  const leaked = g.files.filter((f) => f.startsWith(CORE) || f.includes(`${sep}radio${sep}core`));
  assert.deepEqual(leaked, [], 'radio core is statically reachable from the boot path');
});

test('the only door to the core is one dynamic import in radio-player.js, behind the flag', () => {
  const g = bootGraph();
  const toCore = g.dyn.filter((d) => /radio\/core/.test(d.spec));
  assert.deepEqual(toCore, [{ from: `src${sep}radio-player.js`, spec: './radio/core/index.js' }]);
  const flagIdx = read(resolve(root, 'src/radio-player.js'));
  assert.match(flagIdx, /registerAiStationTypes\(\{[\s\S]*isEnabled:[\s\S]*loadCore: \(\) => import\('\.\/radio\/core\/index\.js'\)/);
  // stations.js never names the core
  assert.doesNotMatch(code(read(resolve(root, 'src/stations.js'))), /radio\/core|radio-core/);
  // the flag module is the only radio/ file on the boot path and has no imports at all
  assert.deepEqual(g.files.filter((f) => f.startsWith(`src${sep}radio${sep}`)), [`src${sep}radio${sep}flag.js`]);
  assert.deepEqual(staticImports(read(resolve(root, 'src/radio/flag.js'))), []);
});

test('the web build is an unbundled copy of index.html + src/, so the static graph above is what ships and loads', () => {
  const build = read(resolve(root, 'scripts/build-web.mjs'));
  assert.match(build, /export const ITEMS = \['index\.html', 'src'\];/);
  assert.doesNotMatch(build, /esbuild|rollup|webpack|terser/);
  // the only radio/core paths the build mentions are the dev-only deny list; the shipped lazy barrel is never denied
  // (the full reachability + exclusion checks live in test/build-web.test.mjs)
  const mentioned = [...build.matchAll(/'(src\/radio\/core\/[^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(mentioned, ['src/radio/core/dev.js', 'src/radio/core/fake-adapters.js', 'src/radio/core/fixtures.js', 'src/radio/core/sim.js']);
});

// ── runtime behaviour, using the real radio-player.js wiring (it is importable in node) ──

async function freshBoot(storageValue, tag) {
  globalThis.window = { localStorage: { getItem: (k) => (k === 'runout.flag.radio.ai' ? storageValue : null), setItem() {}, removeItem() {} } };
  try {
    const stations = await import(`../../src/stations.js`);
    stations._resetStationTypes();
    await import(`../../src/radio-player.js?boot=${tag}`); // re-evaluated per tag: re-runs the registrations
    return stations;
  } finally { delete globalThis.window; }
}

test('flag off (default): only the real-station type exists and AI stations have no player', async () => {
  for (const [value, tag] of [[null, 'unset'], ['0', 'zero'], ['true', 'wrongvalue']]) {
    const st = await freshBoot(value, `off-${tag}`);
    assert.deepEqual(st.listStationTypes().map((t) => t.id), ['radio-browser'], tag);
    assert.equal(st.createSessionFor(st.aiYouStation(), {}), null);
    assert.equal(st.createSessionFor(st.aiYouCityStation('seattle'), {}), null);
  }
  // storage that throws is also "off"
  globalThis.window = { localStorage: { getItem() { throw new Error('blocked'); } } };
  try {
    const st = await import('../../src/stations.js');
    st._resetStationTypes();
    await import('../../src/radio-player.js?boot=off-throws');
    assert.deepEqual(st.listStationTypes().map((t) => t.id), ['radio-browser']);
  } finally { delete globalThis.window; }
});

test('flag on: both AI types register; a session lazy-loads the core and reports "unavailable" (stub)', async () => {
  const st = await freshBoot('1', 'on');
  assert.deepEqual(st.listStationTypes().map((t) => t.id).sort(), ['ai-you', 'ai-you-city', 'radio-browser']);
  for (const station of [st.aiYouStation(), st.aiYouCityStation('Seattle WA')]) {
    const session = st.createSessionFor(station, {});
    const phases = [];
    session.onChange((s) => phases.push(s.phase));
    await session.start();
    assert.deepEqual(phases, ['connecting', 'error']);
    assert.equal(session.state.error.kind, 'unavailable');
    session.stop();
    assert.equal(session.state.phase, 'idle');
  }
});
