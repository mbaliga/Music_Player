// probe.test.mjs — RP-1 capability probe page: static, offline, glyph+word, tiny fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';

const dir = new URL('../packaging/probe/', import.meta.url);
const html = await readFile(new URL('capability-probe.html', dir), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

test('probe page makes no network calls and loads nothing external', () => {
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(html, /<script[^>]*\ssrc=/i);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(script, /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|\bimport\s*\(/);
});

test('probe script parses', () => {
  assert.doesNotThrow(() => new Function(script));
});

test('every status line is emitted through say() with a glyph and a word', () => {
  const m = script.match(/const GLYPH = \{([^}]*)\}/);
  const pairs = [...m[1].matchAll(/(\w+):\s*"([^"]+)"/g)];
  assert.deepEqual(pairs.map((p) => p[1]).sort(), ['ABSENT', 'FAIL', 'INFO', 'PASS', 'UNKNOWN']);
  for (const p of pairs) assert.ok(p[2].length > 0);
  assert.match(script, /GLYPH\[status\] \+ " " \+ status/);
  // no direct writes to the output that skip say()
  assert.equal([...script.matchAll(/out\.textContent\s*=/g)].length, 1);
  // every say() call names a known status
  for (const c of script.matchAll(/\bsay\(\s*([^,)]+)/g)) {
    const a = c[1].trim();
    if (a.startsWith('"')) assert.match(a, /^"(PASS|FAIL|UNKNOWN|ABSENT|INFO)"$/);
  }
});

test('probe covers the RP-1 checklist', () => {
  for (const s of ['crossOriginIsolated', 'C_READ_POS', 'registerProcessor', 'baseLatency', 'outputLatency',
    'decodeAudioData', 'localStorage', 'showDirectoryPicker', 'webkitdirectory', 'setPointerCapture', 'audioSession']) {
    assert.ok(script.includes(s), `missing ${s}`);
  }
});

test('fixtures are tiny and match what is embedded in the page', async () => {
  const names = (await readdir(new URL('fixtures/', dir))).filter((n) => n.startsWith('tone.'));
  assert.ok(names.length >= 5);
  for (const n of names) {
    const f = new URL(`fixtures/${n}`, dir);
    const size = (await stat(f)).size;
    assert.ok(size > 0 && size < 16 * 1024, `${n} is ${size} bytes`);
    const b64 = (await readFile(f)).toString('base64');
    assert.ok(html.includes(JSON.stringify(b64)), `${n} not embedded; run build-probe.mjs`);
  }
});
