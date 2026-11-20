// devicemode-integration.test.mjs — the lock faces and gesture guards against the NEW stage / coverflow / cassette (Workstream I).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allowsGesture, _setGuard } from '../src/devicemode/guard.js';
import { DEFAULT_FACES } from '../src/devicemode/default-faces.js';
import { HINT_MAX_MS } from '../src/devicemode/index.js';
import { onAodOutlineMode, setAodOutlineMode, aodOutlineMode } from '../src/devicemode/aodhooks.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('locked: stage / coverflow / cassette gesture kinds are frozen, keys stay live', () => {
  _setGuard({ locked: true });
  for (const k of ['platter-scrub', 'platter-brake', 'tonearm-drag', 'pinch-zoom', 'coverflow-swipe', 'track-row', 'library-chip', 'shelf-tap', 'editor', 'tape-tap', 'drawer-drag']) assert.equal(allowsGesture(k), false, k);
  for (const k of ['button', 'key', 'wind-hold', 'slider']) assert.equal(allowsGesture(k), true, k);
  _setGuard({ locked: false });
  for (const k of ['platter-scrub', 'pinch-zoom', 'coverflow-swipe', 'tape-tap']) assert.equal(allowsGesture(k), true, k + ' unlocked');
});

test('every gesture entry point of the new UI consults allowsGesture', () => {
  const stage = read('src/turntable/stage.js');
  for (const k of ['tonearm-drag', 'platter-scrub', 'platter-brake', 'pinch-zoom']) assert.ok(stage.includes(`'${k}'`) || stage.includes(k), 'stage: ' + k);
  assert.ok((stage.match(/allowsGesture\(/g) || []).length >= 5);
  const lib = read('src/turntable/library.js');
  for (const k of ['coverflow-swipe', 'track-row', 'library-chip']) assert.ok(lib.includes(`'${k}'`), 'library: ' + k);
  const pl = read('src/cassette/players.js');
  for (const k of ["'wind-hold'", "'tape-tap'", "'button'"]) assert.ok(pl.includes(k), 'players: ' + k);
  assert.ok(read('src/cassette/shelf.js').includes("'shelf-tap'"));
  assert.ok(read('src/mixtape-ui.js').includes("'editor'"));
  assert.ok(read('src/main.js').includes("allowsGesture('platter-brake')"));
});

test('gesture surfaces are marked data-lock-surface', () => {
  assert.match(read('src/turntable/stage.js'), /data-lock-surface/);
  assert.match(read('src/turntable/library.js'), /data-lock-surface/);
  assert.match(read('src/mixtape-ui.js'), /'data-lock-surface'/);
});

test('Albums face: the live selectors exist in the stage markup, the cassette keys are role=button / data-key', () => {
  const svg = read('src/turntable/stage-svg.js');
  for (const sel of DEFAULT_FACES.albums.buttons.filter((s) => s.startsWith('#tt-'))) assert.ok(svg.includes(`id="${sel.slice(1)}"`), sel);
  assert.ok(DEFAULT_FACES.mixtapes.buttons.includes('.tp [role=button]') && DEFAULT_FACES.mixtapes.buttons.includes('.tp [data-key]'));
  const pl = read('src/cassette/players.js');
  assert.match(pl, /role: 'button'[^\n]*'data-key': k\.id/);
  for (const id of ['flip', 'auto']) assert.ok(pl.includes(`'${id}'`), id);
  // frozen things are NOT on the live lists
  const live = DEFAULT_FACES.albums.buttons.join(' ');
  for (const bad of ['#tt-grab', '#tt-dispHit', 'tl-', '.hamburger', '.tp-chip']) assert.ok(!live.includes(bad), bad);
  assert.ok(!DEFAULT_FACES.mixtapes.buttons.join(' ').includes('.cs-card'));
});

test('the locked hint card dismisses itself within 4 s', () => { assert.ok(HINT_MAX_MS <= 4000); });

test('AOD outline hook: late subscribers get the current value, unsubscribing works', () => {
  const seen = []; setAodOutlineMode(true);
  const off = onAodOutlineMode((v) => seen.push(v)); assert.deepEqual(seen, [true]);
  setAodOutlineMode(false); assert.deepEqual(seen, [true, false]); off(); setAodOutlineMode(true); assert.deepEqual(seen, [true, false]);
  assert.equal(aodOutlineMode(), true); setAodOutlineMode(false);
});

test('the stage and the cassette player subscribe to the AOD outline hook; Booth pauses its drawing', () => {
  assert.match(read('src/main.js'), /onAodOutlineMode\(\(on\) => stage\.setOutline\(on\)\)/);
  assert.match(read('src/mixtape-ui.js'), /onAodOutlineMode\(/);
  assert.match(read('src/shell/booth.js'), /onAodOutlineMode\(/);
  assert.match(read('src/fx/ui.js'), /setAod\(on\)/);
});
