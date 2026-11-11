import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = resolve(root, 'src/radio/canned');
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
const read = (p) => readFileSync(p, 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const staticImports = (src) => [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1]);
const dynamicImports = (src) => [...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);

test('static: canned code has no network API except the two injectable same-origin loaders, no dev-only imports, nothing eval-like, no randomness', () => {
  assert.ok(files.length >= 15, files.join());
  const BANNED = [/\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/, /\bRTCPeerConnection\b/, /\bnavigator\.connection\b/, /\beval\s*\(/, /\bnew Function\b/, /\bMath\.random\b/];
  for (const f of files) {
    const src = read(resolve(dir, f));
    const c = code(src);
    for (const re of BANNED) assert.doesNotMatch(c, re, `${f} matches ${re}`);
    // fetch only as an injectable default in the two loaders, never called by name elsewhere
    if (!['session.js', 'dial.js'].includes(f)) assert.doesNotMatch(c, /\bfetch\b/, `${f} mentions fetch`);
    if (f !== 'session.js') assert.doesNotMatch(c, /https?:\/\//, `${f} contains a URL`);
    if (!['dial.js', 'panel.js', 'audition.js', 'net.js', 'session.js', 'audio.js'].includes(f)) assert.doesNotMatch(c, /\b(document|localStorage|sessionStorage|AudioContext|new Audio)\b/, `${f} touches the browser`);
    assert.match(src, /^\/\/ (─{20,}\n\/\/ )?[a-z.-]+\.js — /, `${f} needs its header comment`);
    for (const m of c.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
      assert.match(m[1], /^\.{1,2}\//, `${f} imports ${m[1]}`);
      assert.doesNotMatch(m[1], /fake-adapters|fixtures|\/sim\.js|dev\.js/, `${f} imports a dev-only module: ${m[1]}`);
    }
  }
  // the session's fetch is a parameter with an own-origin check; the cross-origin guard is present
  const sess = code(read(resolve(dir, 'session.js')));
  assert.match(sess, /refused: not the app origin/);
  assert.doesNotMatch(sess, /fetch\s*\(\s*['"`]https?:/);
});

test('the pure canned modules are DOM-free (pack, slots, chooser, voices, audio-pack, policy, fallback, catalog, ai-styles)', () => {
  for (const f of ['pack.js', 'slots.js', 'chooser.js', 'voices.js', 'audio-pack.js', 'policy.js', 'fallback.js', 'catalog.js', 'ai-styles.js']) {
    assert.doesNotMatch(code(read(resolve(dir, f))), /\b(window|document|localStorage|navigator|Audio|AudioContext|setTimeout|setInterval|Date\.now)\b/, f);
  }
});

function bootGraph() {
  const html = read(resolve(root, 'index.html'));
  const entries = [...html.matchAll(/<script[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/g)].map((m) => resolve(root, m[1]));
  const seen = new Set(), dyn = [];
  const queue = [...entries];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = code(read(f));
    for (const spec of staticImports(src)) if (spec.startsWith('.')) queue.push(resolve(dirname(f), spec));
    for (const spec of dynamicImports(src)) dyn.push({ from: relative(root, f), spec });
  }
  return { files: [...seen].map((f) => relative(root, f)), dyn };
}

test('boot path: no canned (or other radio) code but the flag module is statically reachable; the doors are two dynamic imports in radio-player.js', () => {
  const g = bootGraph();
  assert.deepEqual(g.files.filter((f) => f.startsWith(`src${sep}radio${sep}`)), [`src${sep}radio${sep}flag.js`]);
  const toCanned = g.dyn.filter((d) => /radio\/canned/.test(d.spec)).map((d) => `${d.from} -> ${d.spec}`).sort();
  assert.deepEqual(toCanned, [`src${sep}radio-player.js -> ./radio/canned/dial.js`, `src${sep}radio-player.js -> ./radio/canned/index.js`]);
  // stations.js (boot path) never names the canned code
  assert.doesNotMatch(code(read(resolve(root, 'src/stations.js'))), /radio\/canned/);
  // main.js does not import it either
  assert.doesNotMatch(code(read(resolve(root, 'src/main.js'))), /radio\/canned/);
});
