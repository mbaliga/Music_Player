import test from 'node:test';
import assert from 'node:assert/strict';
import { SECTIONS } from '../src/shell/sections.js';
import { registerLockFace, getLockFace, registeredFaces, liveSelectors, faceCss, GENERIC_FACE, _clearFacesForTests } from '../src/devicemode/faces.js';
import { allowsGesture, _setGuard } from '../src/devicemode/guard.js';
import { registerDefaultFaces, DEFAULT_FACES } from '../src/devicemode/default-faces.js';

test('every shell section registers a lock face (and each lists buttons + notes)', () => {
  _clearFacesForTests(); registerDefaultFaces();
  for (const s of SECTIONS) {
    const f = getLockFace(s.id); assert.ok(f, `no lock face for section "${s.id}"`);
    assert.ok(f.buttons.length > 0, s.id + ' has no live buttons'); assert.ok(f.notes.length > 0, s.id + ' has no hint');
  }
  assert.deepEqual([...registeredFaces()].sort(), SECTIONS.map((s) => s.id).sort());
  assert.deepEqual(Object.keys(DEFAULT_FACES).sort(), SECTIONS.map((s) => s.id).sort());
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
