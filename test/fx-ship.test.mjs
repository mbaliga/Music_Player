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

test('main.js (the boot path) has NO static import of src/fx and one dynamic import of the FX UI', async () => {
  const src = strip(await readFile(resolve(root, 'src/main.js'), 'utf8'));
  assert.equal(/^\s*import[^;]*from\s+['"]\.\/fx\//m.test(src), false, 'static import of ./fx/ from main.js');
  assert.equal((src.match(/import\(\s*['"]\.\/fx\/ui\.js['"]\s*\)/g) || []).length, 1);
  // and no other boot module reaches into fx
  for (const f of ['audio-engine.js', 'render.js', 'library.js', 'mixtape-ui.js', 'radio-player.js']) assert.equal(/\.\/fx\//.test(strip(await readFile(resolve(root, 'src', f), 'utf8'))), false, f);
});

test('the FX section is the LAST section of the panel and the page boots without any FX markup besides it', async () => {
  const html = await readFile(resolve(root, 'index.html'), 'utf8');
  const panel = html.slice(html.indexOf('<aside class="panel">'), html.indexOf('</aside>'));
  const sections = [...panel.matchAll(/<div class="section[^"]*"[^>]*?(?:id="([^"]+)")?[^>]*>/g)].map((m) => m[0]);
  assert.match(sections[sections.length - 1], /fx-section/);
  assert.equal((panel.match(/class="section fx-section"/g) || []).length, 1);
});

test('FX worklet slots exist in the control layout and the worklet duplicates them verbatim', async () => {
  const lay = await readFile(resolve(root, 'src/control-layout.js'), 'utf8');
  const wk = await readFile(resolve(root, 'src/worklet.js'), 'utf8');
  for (const m of lay.matchAll(/export const (C_FX_\w+)\s*=\s*(\d+)/g)) assert.match(wk, new RegExp(`${m[1]}\\s*=\\s*${m[2]}\\b`), m[1]);
  assert.match(lay, /CONTROL_SLOTS = 16/);
});
