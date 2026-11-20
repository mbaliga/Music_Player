// FX ships in www/ and stays lazy: nothing under src/fx is reachable through STATIC imports from the app boot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWeb, listFiles, reachableFiles } from '../scripts/build-web.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

test('the build ships every FX module and its stylesheet; the app reaches them only through the lazy import', async () => {
  const tmp = await mkdtemp(resolve(tmpdir(), 'runout-fx-'));
  try {
    const out = resolve(tmp, 'www'); await buildWeb({ outDir: out, buildId: 'fx', quiet: true });
    const files = await listFiles(out);
    const srcFx = (await readdir(resolve(root, 'src/fx'))).map((f) => `src/fx/${f}`);
    for (const f of srcFx) assert.ok(files.includes(f), `${f} missing from www/`);
    assert.ok(srcFx.includes('src/fx/fx.css') && srcFx.includes('src/fx/ui.js'));
    const r = await reachableFiles(out);
    assert.deepEqual(r.missing, []);
    for (const f of srcFx.filter((x) => x.endsWith('.js'))) assert.ok(r.files.includes(f), `${f} not reachable (dynamic import chain broken)`);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('the boot path has NO static import of src/fx; the shell reaches the FX component through one lazy import in src/shell/booth.js', async () => {
  const booth = strip(await readFile(resolve(root, 'src/shell/booth.js'), 'utf8'));
  assert.equal((booth.match(/import\(\s*['"]\.\.\/fx\/section\.js['"]\s*\)/g) || []).length, 1, 'one dynamic import of fx/section.js');
  for (const f of ['main.js', 'audio-engine.js', 'render.js', 'library.js', 'mixtape-ui.js', 'radio-player.js', 'shell/booth.js', 'shell/nav.js', 'shell/sections.js']) {
    assert.equal(/^\s*import[^;]*from\s+['"][^'"]*\/fx\//m.test(strip(await readFile(resolve(root, 'src', f), 'utf8'))), false, `${f} statically imports src/fx`);
  }
});

test('the Booth page exists in the shell and the old panel no longer carries FX markup', async () => {
  const html = await readFile(resolve(root, 'index.html'), 'utf8');
  assert.match(html, /id="boothHost"/);
  assert.equal(/fx-section|id="fxHead"/.test(html), false);
});

test('mountFxSection is exported by the entry module with the documented return shape (checked statically)', async () => {
  assert.match(await readFile(resolve(root, 'src/fx/section.js'), 'utf8'), /export \{ mountFxSection \} from '\.\/ui\.js'/);
  const ui = await readFile(resolve(root, 'src/fx/ui.js'), 'utf8');
  for (const k of ['unmount()', 'onShow()', 'onHide()', 'onTrack()', 'platter:']) assert.ok(ui.includes(k), k);
});

test('FX worklet slots exist in the control layout and the worklet duplicates them verbatim', async () => {
  const lay = await readFile(resolve(root, 'src/control-layout.js'), 'utf8');
  const wk = await readFile(resolve(root, 'src/worklet.js'), 'utf8');
  for (const m of lay.matchAll(/export const (C_FX_\w+)\s*=\s*(\d+)/g)) assert.match(wk, new RegExp(`${m[1]}\\s*=\\s*${m[2]}\\b`), m[1]);
  assert.match(lay, /CONTROL_SLOTS = 16/);
});
