// Rewrites the FIXTURES block of capability-probe.html from fixtures/*.
// Run: node packaging/probe/build-probe.mjs   (test/probe.test.mjs checks they agree)
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const names = (await readdir(`${dir}fixtures`)).filter((n) => n.startsWith('tone.')).sort();
const entries = [];
for (const n of names) {
  const b64 = (await readFile(`${dir}fixtures/${n}`)).toString('base64');
  entries.push(`  ${JSON.stringify(n.slice(5))}: ${JSON.stringify(b64)},`);
}
const block = `/*FIXTURES-BEGIN*/\nconst FIXTURES = {\n${entries.join('\n')}\n};\n/*FIXTURES-END*/`;
const path = `${dir}capability-probe.html`;
const html = await readFile(path, 'utf8');
await writeFile(path, html.replace(/\/\*FIXTURES-BEGIN\*\/[\s\S]*?\/\*FIXTURES-END\*\//, () => block));
console.log(`embedded ${names.length} fixtures`);
