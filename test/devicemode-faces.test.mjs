import test from 'node:test';
import assert from 'node:assert/strict';
import { SECTIONS } from '../src/shell/sections.js';
import { registerLockFace, getLockFace, registeredFaces, liveSelectors, faceCss, GENERIC_FACE, _clearFacesForTests } from '../src/devicemode/faces.js';
import { allowsGesture, _setGuard } from '../src/devicemode/guard.js';
import { registerDefaultFaces, DEFAULT_FACES } from '../src/devicemode/default-faces.js';

test('sections registered in the shell are covered by a lock face; a future section falls back to the generic allowlist (warn, never red)', () => {
  _clearFacesForTests(); registerDefaultFaces();
  const missing = [];
  for (const s of SECTIONS) {
    const f = getLockFace(s.id);
    if (!f) { missing.push(s.id); assert.ok(liveSelectors(s.id).includes('button'), 'generic fallback for ' + s.id); continue; }
    assert.ok(f.buttons.length > 0, s.id + ' has no live selectors'); assert.ok(f.notes.length > 0, s.id + ' has no hint');
  }
  if (missing.length) console.warn('device mode: sections without a lock face (generic fallback in use): ' + missing.join(', '));
  for (const id of Object.keys(DEFAULT_FACES)) assert.ok(getLockFace(id), id);
});
test('registration is defensive; unregistered sections fall back to the generic button allowlist', () => {
  _clearFacesForTests(); assert.equal(registerLockFace('', {}), false); assert.equal(registerLockFace('x', { buttons: ['.a', 5, ''] }), true);
  assert.deepEqual(getLockFace('x').buttons, ['.a']); assert.deepEqual(getLockFace('x').aod, ['.a']);
  assert.ok(liveSelectors('nope').includes('button')); assert.deepEqual(GENERIC_FACE.buttons.length, 3);
  assert.ok(liveSelectors('x').includes('.dm-key'));
});
test('the FX pad is live in the Booth only when the setting allows it', () => {
  _clearFacesForTests(); registerDefaultFaces();
  assert.ok(!liveSelectors('booth', {}).includes('.fx-pad')); assert.ok(liveSelectors('booth', { fxPadWhileLocked: true }).includes('.fx-pad'));
  assert.ok(!liveSelectors('albums', { fxPadWhileLocked: true }).includes('.fx-pad'));
});
test('generated css scopes to the section, freezes the shell chrome and lights AOD buttons', () => {
  _clearFacesForTests(); registerDefaultFaces(); const css = faceCss('albums', {});
  assert.match(css, /data-dm-section="albums"/); assert.match(css, /pointer-events: auto/); assert.match(css, /\.hamburger/); assert.match(css, /--dm-glow/);
});
test('allowsGesture: everything frozen while locked except buttons/keys/sliders; FX pad by setting', () => {
  _setGuard({ locked: false }); for (const k of ['drawer-drag', 'platter-scrub', 'fx-pad']) assert.equal(allowsGesture(k), true);
  _setGuard({ locked: true });
  for (const k of ['drawer-drag', 'platter-scrub', 'tonearm-drag', 'pinch-zoom', 'coverflow-swipe', 'list-scroll', 'text-input', 'fx-pad', 'anything-new']) assert.equal(allowsGesture(k), false, k);
  for (const k of ['button', 'key', 'wind-hold', 'slider']) assert.equal(allowsGesture(k), true, k);
  _setGuard({ locked: true, fxPadWhileLocked: true }); assert.equal(allowsGesture('fx-pad'), true); _setGuard({ locked: false });
});

import { readFileSync } from 'node:fs';
import { GLOBAL_LIVE, GLOBAL_AOD } from '../src/devicemode/faces.js';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('the mini bar Pause / Next keys are live in every section while locked and lit in AOD; its title (navigation) is not', () => {
  for (const sel of ['.minibar-stop', '.minibar-toggle', '.minibar-prev', '.minibar-next']) { assert.ok(GLOBAL_LIVE.includes(sel), sel); assert.ok(GLOBAL_AOD.includes(sel), sel); }
  assert.ok(!GLOBAL_LIVE.includes('.minibar-main') && !GLOBAL_LIVE.includes('.minibar'));
  _clearFacesForTests(); registerDefaultFaces();
  for (const id of Object.keys(DEFAULT_FACES)) {
    assert.ok(liveSelectors(id).includes('.minibar-toggle') && liveSelectors(id).includes('.minibar-next'), id);
    assert.match(faceCss(id), /\.minibar-toggle/);
  }
  const nav = rd('src/shell/nav.js'); assert.match(nav, /minibar-toggle/); assert.match(nav, /minibar-next/);
});

test('the labelled Flip / Auto-flip buttons are on the Mixtapes live list; Look, Click sounds and Vibration stay frozen', () => {
  const live = DEFAULT_FACES.mixtapes.buttons.join(' ');
  assert.ok(live.includes('.tp-flip') && live.includes('.tp-auto'));
  for (const bad of ['.tp-look', '.tp-click', '.tp-vib', '.tp-back', '.tp-songs-btn', '.tp-chip']) assert.ok(!live.includes(bad), bad);
  const ui = rd('src/mixtape-ui.js');
  for (const c of ['tp-flip', 'tp-auto', 'tp-look', 'tp-click', 'tp-vib']) assert.ok(ui.includes(`'tp-chip ${c}'`), c);
  assert.match(rd('docs/DEVICE_MODE.md'), /tp-flip/);
});

test('devicemode.css has no at-rule nested inside a selector (invalid CSS)', () => {
  const css = rd('src/devicemode/devicemode.css');
  assert.ok(!/\]\s*@media/.test(css) && !/[a-z\]\)]\s+@media/i.test(css.replace(/\}\s*@media/g, '}')), 'an @media must start a rule, not follow a selector');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ body\[data-devicemode~="locked"\] \.dm-thumb/);
});

test('the timeout notice is guarded like the hint card: not shown in AOD, cleared on entering it', () => {
  const idx = rd('src/devicemode/index.js');
  assert.match(idx, /function showNotice\(\) \{\s*if \(!noticeEl \|\| aodApplied \|\| machine\.state\.aod\) return;/);
  assert.match(idx, /if \(on\) \{ clearHint\(\); noticeEl && \(noticeEl\.hidden = true\); \}/);
});

test('AOD stage: redraws on change only, and no label-art work while the outline is on', () => {
  const st = rd('src/turntable/stage.js');
  assert.match(st, /if \(outline\) \{[^]*?outlineSig[^]*?P\.playing && t - outlineAt >= 10000/);
  assert.ok(!/if \(outline\) \{ if \(dirty \|\| was !== P\)/.test(st));
  assert.match(st, /setLabelArt\(album\) \{\s*if \(outline\) \{ pendingLabel = album \|\| null; return; \}/);
  assert.match(st, /pendingLabel !== undefined/);
});
