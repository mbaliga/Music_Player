// Assemble the static web app into ./www, the Capacitor webDir.
//
// Capacitor copies webDir wholesale into the Android app's assets, so we stage
// only the runtime files — index.html + src/ — and deliberately leave out the
// dev server, tooling, and node_modules. Pure Node, no extra deps.

import { rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const www = resolve(root, 'www');

const ITEMS = ['index.html', 'src'];

await rm(www, { recursive: true, force: true });
await mkdir(www, { recursive: true });
for (const item of ITEMS) {
  await cp(resolve(root, item), resolve(www, item), { recursive: true });
}

// Stamp the build id into the staged index.html so a stale APK download is
// obvious in the app UI. GITHUB_SHA is set automatically in CI; locally it's
// absent and the placeholder falls back to a date-only marker.
const sha = (process.env.GITHUB_SHA || '').slice(0, 7);
const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
const buildId = sha ? `${sha} · ${date} UTC` : `local · ${date}`;
const indexPath = resolve(www, 'index.html');
const html = await readFile(indexPath, 'utf8');
await writeFile(indexPath, html.replace('__BUILD_ID__', buildId));

console.log(`build:web → staged ${ITEMS.join(', ')} into www/ (build ${buildId})`);
