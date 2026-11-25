// Regression (owner report, RedMagic): with a real library on the shelf only the built-in test pressing ever played.
// Root cause: main.js booted the synthesized demo onto the platter and nothing replaced it when the library arrived
// (setAlbums keeps focus without emitting 'focus'), so Play / tap-cover played the demo. The behaviour is proven in a
// browser by scripts/verify-real-playback.py (measured audio frequency); this guards the wiring so it cannot be dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const body = (name) => { const i = src.indexOf(name); assert.ok(i >= 0, name + ' exists'); return src.slice(i, i + 2500); };

test('Play never plays the demo while the library has albums', () => {
  // the decision uses the WHOLE library, never the filtered shelf (a filter that hides every album must not unlock the demo)
  assert.match(src, /const platterIsDemo = \(\) => state\.albumId === TEST_PRESSING_ID && libHasAlbums\(\)/);
  assert.match(src, /const libHasAlbums = \(\) => unfiltered\(\)\.length > 0/);
  const t = body('async function onToggle()');
  assert.ok(t.indexOf('platterIsDemo()') > 0 && t.indexOf('adoptFocusedAlbum(') > 0, 'onToggle adopts the focused album first');
  assert.ok(t.indexOf('platterIsDemo()') < t.indexOf("stage.dispatch({ type: 'toggle' })"), 'before the plain toggle');
});

test('a rebuilt shelf replaces the demo on the platter', () => {
  const r = body('function rebuildAlbums()');
  assert.match(r, /if \(platterIsDemo\(\)\) scheduleAdopt\(\)/);
});

test('load failures are loud (toast), never silent', () => {
  assert.match(src, /function toast\(text(, ms = \d+)?\)/);
  assert.match(body('async function loadAlbum('), /toast\(`Cannot play/);
  assert.match(body('async function jumpTo('), /toast\(`Cannot play/);
});
