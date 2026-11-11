// The core must stay portable: no DOM, no network, no storage, no wall clock, no randomness, no
// timers, and no imports from outside src/radio/core. This is what lets it move with the engine
// if the audio path ever goes native (architecture R1) and what keeps tests deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/radio/core');
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));

// comments are documentation, not code: strip them before scanning
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

const FORBIDDEN = [
  /\bwindow\b/, /\bdocument\b/, /\bnavigator\b/, /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/,
  /\bWebSocket\b/, /\bAudioContext\b/, /\bAudioWorklet/, /\bWorker\s*\(/, /\bsetTimeout\b/, /\bsetInterval\b/, /\brequestAnimationFrame\b/,
  /\bDate\.now\b/, /\bnew Date\(\s*\)/, /\bperformance\.now\b/, /\bMath\.random\b/, /\bprocess\./, /\brequire\s*\(/, /\bimport\s*\(/, /\beval\s*\(/, /\bglobalThis\b/,
];

test('core has files to check', () => assert.ok(files.length >= 18, files.join()));

test('no browser, network, storage, clock, randomness or timer globals in core', () => {
  for (const f of files) {
    const src = code(readFileSync(resolve(dir, f), 'utf8'));
    for (const re of FORBIDDEN) assert.doesNotMatch(src, re, `${f} uses ${re}`);
  }
});

test('core imports only other core modules (relative, same folder)', () => {
  for (const f of files) {
    const src = readFileSync(resolve(dir, f), 'utf8');
    for (const m of src.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
      assert.match(m[1], /^\.\/[a-z-]+\.js$/, `${f} imports ${m[1]}`);
      assert.ok(files.includes(m[1].slice(2)), `${f} imports missing ${m[1]}`);
    }
    assert.doesNotMatch(src, /^\s*import\s+['"]/m, `${f} has a bare side-effect import`);
  }
});

test('every core module opens with a header comment explaining itself', () => {
  for (const f of files) assert.match(readFileSync(resolve(dir, f), 'utf8'), /^\/\/ ─{20,}\n\/\/ [a-z.-]+\.js — /, f);
});
