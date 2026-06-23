// Assemble the static web app into ./www, the Capacitor webDir.
//
// Capacitor copies webDir wholesale into the Android app's assets, so we stage
// only the runtime files — index.html + src/ — and deliberately leave out the
// dev server, tooling, and node_modules. Pure Node, no extra deps.

import { rm, mkdir, cp } from 'node:fs/promises';
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
console.log(`build:web → staged ${ITEMS.join(', ')} into www/`);
