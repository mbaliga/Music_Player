// Assemble the static web app into ./www, the Capacitor webDir.
//
// Capacitor copies webDir wholesale into the Android app's assets, so we stage
// only the runtime files — index.html + src/ — and deliberately leave out the
// dev server, tooling, and node_modules. Pure Node, no extra deps.
//
// DEV-ONLY EXCLUSIONS. src/ is served unbundled by serve.py in development and
// that stays untouched (nothing here changes the source tree). For the web/APK
// build we drop files that exist only for tests and the dev harness. The list is
// explicit on purpose: a new dev-only file must be added here (and the build test
// in test/build-web.test.mjs will fail loudly if something the app actually
// imports gets excluded, or if a listed file becomes reachable).
//
//   DENY      = paths (relative to the repo root) never shipped
//   DENY_GLOB = patterns for docs that ride along inside src/
//
// The radio core stays lazily loadable: src/radio/core/index.js is the shipped
// barrel (dynamic import in src/radio-player.js behind the radio.ai flag) and
// pulls in only shipped core modules. The dev barrel (dev.js), fakes, fixtures and
// the simulated show are NOT exported from it.

import { rm, mkdir, cp, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve, relative, sep, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { validatePackDoc } from '../src/radio/canned/pack.js';
import { buildStationsIndex, serializeIndex, isPackFile } from './stations-index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const ITEMS = ['index.html', 'src'];

// DATA SHIPPED BESIDE src/ (fetched lazily from the app's own origin by src/radio/canned, never imported):
//   content/stations/<id>.json  -> www/stations/<id>.json     the canned station packs (validated here; an invalid pack fails the build)
//   (generated)                 -> www/stations/index.json    the dial's station list, built from the packs
//   content/audio/** (optional) -> www/audio/**               pre-rendered voice packs from scripts/render-shows.py; ABSENT today
// Dev-only files in content/stations (README.md, _stoplist.json, the committed index.json) are not copied.
export const STATIONS_SRC = 'content/stations';
export const AUDIO_SRC = 'content/audio';

export const DENY = Object.freeze([
  'src/radio/core/dev.js',            // dev/test barrel
  'src/radio/core/fake-adapters.js',  // fake Context/Director/Writer/Voice/STT/Decoder
  'src/radio/core/fixtures.js',       // snapshot + library fixtures
  'src/radio/core/sim.js',            // simulated 45-minute show
]);
export const DENY_GLOB = Object.freeze([
  /^src\/radio\/core\/README\.md$/,   // documentation
  /\.test\.m?js$/,                    // never in src today; guards against future co-located tests
  /(^|\/)\.DS_Store$/,
]);

export const isDenied = (relPosix) => DENY.includes(relPosix) || DENY_GLOB.some((re) => re.test(relPosix));

async function* walk(dir) {
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

// ── import graph (used by the build as a guard and by the test) ──────────────
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const STATIC = /(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const URLREF = /new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;

/** Every file reachable from `<dir>/index.html`: module scripts, static + dynamic imports, `new URL(..., import.meta.url)`. */
export async function reachableFiles(dir) {
  const html = await readFile(resolve(dir, 'index.html'), 'utf8');
  const queue = [];
  const mod = /<script[^>]*\btype=["']module["'][^>]*>([\s\S]*?)<\/script>/g;
  for (const m of html.matchAll(/<script[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/g)) queue.push(resolve(dir, m[1]));
  for (const m of html.matchAll(mod)) for (const s of m[1].matchAll(STATIC)) if (s[1].startsWith('.')) queue.push(resolve(dir, s[1]));
  const seen = new Set();
  const missing = [];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    let src;
    try { src = stripComments(await readFile(f, 'utf8')); } catch { missing.push(f); continue; }
    for (const re of [STATIC, DYNAMIC, URLREF]) for (const m of src.matchAll(re)) if (m[1].startsWith('.')) queue.push(resolve(dirname(f), m[1]));
  }
  const rel = (f) => relative(dir, f).split(sep).join('/');
  return { files: [...seen].filter((f) => !missing.includes(f)).map(rel).sort(), missing: missing.map(rel).sort() };
}

/** Copy + validate the station packs, write the generated index, copy the optional audio packs. -> shipped pack file names */
async function stageStations(outDir, srcDir, audioDir) {
  const dest = resolve(outDir, 'stations');
  await mkdir(dest, { recursive: true });
  const files = (await readdir(srcDir)).filter(isPackFile).sort();
  for (const f of files) {
    const text = await readFile(resolve(srcDir, f), 'utf8');
    const { errors } = validatePackDoc(JSON.parse(text));
    if (errors.length) throw new Error(`build:web — station pack ${f} is invalid: ${errors.slice(0, 3).map((e) => e.msg).join('; ')}`);
    await writeFile(resolve(dest, f), text);
  }
  await writeFile(resolve(dest, 'index.json'), serializeIndex(buildStationsIndex(srcDir, audioDir)));
  if (existsSync(audioDir)) await cp(audioDir, resolve(outDir, 'audio'), { recursive: true });
  return files;
}

/** List every shipped file (posix paths relative to `dir`), sorted. */
export async function listFiles(dir) {
  const out = [];
  for await (const f of walk(dir)) out.push(relative(dir, f).split(sep).join('/'));
  return out.sort();
}

/**
 * Stage the app into `outDir` (default ./www). `buildId` is stamped into index.html (default derived from
 * GITHUB_SHA + the current time; pass one for a reproducible build).
 */
export async function buildWeb({ outDir = resolve(root, 'www'), buildId = null, quiet = false, stationsDir = resolve(root, STATIONS_SRC), audioDir = resolve(root, AUDIO_SRC) } = {}) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  let skipped = 0;
  for (const item of ITEMS) {
    await cp(resolve(root, item), resolve(outDir, item), {
      recursive: true,
      filter: (src) => {
        const rel = relative(root, src).split(sep).join(posix.sep);
        if (isDenied(rel)) { skipped++; return false; }
        return true;
      },
    });
  }

  // Canned station packs (+ optional audio packs), lazy-loaded data.
  const stationFiles = await stageStations(outDir, stationsDir, audioDir);

  // Stamp the build id into the staged index.html so a stale APK download is
  // obvious in the app UI. GITHUB_SHA is set automatically in CI; locally it's
  // absent and the placeholder falls back to a date-only marker.
  if (!buildId) {
    const sha = (process.env.GITHUB_SHA || '').slice(0, 7);
    const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
    buildId = sha ? `${sha} · ${date} UTC` : `local · ${date}`;
  }
  const indexPath = resolve(outDir, 'index.html');
  const html = await readFile(indexPath, 'utf8');
  await writeFile(indexPath, html.replace('__BUILD_ID__', buildId));

  // Guard: whatever the app can import must have been staged (a deny-list mistake fails the build, not the app).
  const { missing } = await reachableFiles(outDir);
  if (missing.length) throw new Error(`build:web — imported but not staged: ${missing.join(', ')}`);

  let bytes = 0;
  for (const f of await listFiles(outDir)) bytes += (await stat(resolve(outDir, f))).size;
  if (!quiet) console.log(`build:web → staged ${ITEMS.join(', ')} into ${relative(root, outDir) || '.'}/ (${skipped} dev-only files skipped, ${stationFiles.length} station packs, ${(bytes / 1024).toFixed(0)} KB, build ${buildId})`);
  return { outDir, buildId, skipped, bytes, stations: stationFiles };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await buildWeb();
}
