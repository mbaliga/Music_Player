// turntable-library.test.mjs — the DOM component, against a minimal fake DOM (the real browser run is
// scripts/verify-turntable-library.py): bounded DOM, textContent only, events, inert, destroy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountTurntableLibrary, albumsToCoverflow } from '../src/turntable/library.js';
import { makeDom } from './support/turntable-fake-dom.mjs';
import { coverBlobUrl, isTrackedCoverUrl } from '../src/turntable/covers.js';

const mk = (i, o = {}) => ({ id: 'a' + i, title: 'Album ' + i, artist: 'Art', kind: i % 4 === 1 ? 'cd' : 'vinyl', coverSeed: i,
  tracks: [{ title: 'one', durationSec: 61 }, { title: 'two', durationSec: null }, { title: 'three', durationSec: 5 }], ...o });
function setup(n = 5) {
  const d = makeDom();
  const lib = mountTurntableLibrary(d.container, d.deps);
  const log = []; for (const e of ['focus', 'selectTrack', 'tapCover', 'scan', 'filter', 'sort']) lib.on(e, (...a) => log.push([e, ...a]));
  lib.layout({ width: 360, height: 780, portrait: true });
  lib.setAlbums(Array.from({ length: n }, (_, i) => mk(i)));
  lib.setOpacity(1);
  return { d, lib, log, root: lib.el };
}
const find = (root, cls) => root.all().filter((e) => e.className.split(' ').includes(cls));
const rowsOf = (root) => find(root, 'tl-trk');

test('empty library shows the built-in test pressing and the scan hint', () => {
  const d = makeDom(); const lib = mountTurntableLibrary(d.container, d.deps); lib.layout({ width: 360, height: 780, portrait: true });
  const t = find(lib.el, 'tl-title')[0];
  assert.equal(t.textContent, 'Demo record');
  assert.match(lib.el.className, /tl-empty/);
  assert.equal(rowsOf(lib.el).length, 1);
  lib.setAlbums([mk(1)]); assert.doesNotMatch(lib.el.className, /tl-empty/);
  lib.destroy();
});

test('meta, rows, durations (em dash when unknown), now playing', () => {
  const { lib, root } = setup();
  assert.equal(find(root, 'tl-title')[0].textContent, 'Album 0');
  assert.equal(find(root, 'tl-sub')[0].textContent, 'Art · 3 tracks');         // a partial total is never shown
  const rows = rowsOf(root);
  assert.deepEqual(rows.map((r) => r.children[2].textContent), ['1:01', '—', '0:05']);
  assert.deepEqual(rows.map((r) => r.children[0].textContent), ['01', '02', '03']);
  lib.setNowPlaying({ albumId: 'a0', trackIndex: 1 });
  assert.deepEqual(rowsOf(root).map((r) => r.className), ['tl-trk', 'tl-trk on', 'tl-trk']);
  lib.setNowPlaying({ albumId: 'other', trackIndex: 1 });
  assert.ok(rowsOf(root).every((r) => r.className === 'tl-trk'));
});

test('hostile titles are text, never elements; long ones are clipped', () => {
  const { lib, root } = setup(1);
  const evil = '<img src=x onerror=alert(1)>';
  lib.setAlbums([mk(0, { title: evil, artist: '"><script>x</script>', tracks: [{ title: evil, durationSec: 1 }, { title: 'y'.repeat(5000), durationSec: 1 }] })]);
  assert.equal(find(root, 'tl-title')[0].textContent, evil);
  assert.equal(rowsOf(root)[0].children[1].textContent, evil);
  assert.ok(rowsOf(root)[1].children[1].textContent.length <= 200);
  assert.ok(root.all().every((e) => !['IMG', 'SCRIPT'].includes(e.tagName)));
});

test('selectTrack / tapCover / toolbar events carry the right ids', () => {
  const { lib, log, root } = setup();
  lib.focus(2, { animate: false });
  assert.equal(lib.getFocus(), 2);
  assert.deepEqual(log, [], 'programmatic focus is silent');
  rowsOf(root)[1].dispatch('click');
  assert.deepEqual(log.splice(0), [['selectTrack', 'a2', 1]]);
  const flow = find(root, 'tl-flow')[0];
  flow.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(log.splice(0), [['tapCover', 'a2']]);
  const chips = find(root, 'tl-chip');
  chips.find((c) => c.className.split(' ').includes('tl-scan')).dispatch('click');
  chips.filter((c) => c.className.split(' ').includes('tl-f'))[2].dispatch('click');
  chips.filter((c) => c.className.split(' ').includes('tl-s'))[1].dispatch('click');
  assert.deepEqual(log.splice(0), [['scan'], ['filter', 'cd'], ['sort', 'album']]);
});

test('keyboard: arrows move the focus, one focus event per settle', () => {
  const { d, lib, log, root } = setup();
  const flow = find(root, 'tl-flow')[0];
  flow.dispatch('keydown', { key: 'ArrowRight' }); flow.dispatch('keydown', { key: 'ArrowRight' });
  d.step(16, 120);
  assert.deepEqual(log.splice(0), [['focus', 2, 'a2']]);
  assert.equal(lib.getFocus(), 2);
  assert.equal(find(root, 'tl-title')[0].textContent, 'Album 2');
  flow.dispatch('keydown', { key: 'Home' }); d.step(16, 120);
  assert.deepEqual(log.splice(0), [['focus', 0, 'a0']]);
  assert.equal(d.pending(), 0, 'the loop stops when settled');
});

test('swipe: drag past a threshold, release -> next album, once', () => {
  const { d, lib, log, root } = setup();
  const flow = find(root, 'tl-flow')[0];
  const base = { pointerId: 1, pointerType: 'touch', button: 0 };
  flow.dispatch('pointerdown', { ...base, clientX: 200, timeStamp: 0, target: flow });
  for (let i = 1; i <= 8; i++) { flow.dispatch('pointermove', { ...base, clientX: 200 - 18 * i, timeStamp: i * 30 }); d.step(30); }
  flow.dispatch('pointerup', { ...base, clientX: 56, timeStamp: 280 });
  d.step(16, 150);
  assert.deepEqual(log.splice(0).map((e) => e[0]), ['focus']);
  assert.ok(lib.getFocus() >= 1);
});

test('inert below 50% opacity and when hidden; setOpacity does not leak events', () => {
  const { d, lib, log, root } = setup();
  const flow = find(root, 'tl-flow')[0];
  lib.setOpacity(0.49);
  assert.ok(root.hasAttribute('inert')); assert.equal(root.style.pointerEvents, 'none');
  flow.dispatch('keydown', { key: 'ArrowRight' }); d.step(16, 100);
  assert.deepEqual(log, []);
  lib.setOpacity(0.5); assert.ok(!root.hasAttribute('inert')); assert.equal(root.style.pointerEvents, 'auto');
  lib.hide(); assert.ok(root.hasAttribute('inert')); assert.equal(root.getAttribute('aria-hidden'), 'true'); assert.equal(root.style.visibility, 'hidden');
  lib.show(); assert.ok(!root.hasAttribute('inert')); assert.equal(root.style.visibility, 'visible');
});

test('2000 albums: DOM and canvases stay bounded however far the focus travels', () => {
  const { d, lib, root } = setup(2000);
  const before = root.all().length;
  for (const k of [0, 500, 1000, 1999, 3, 1500]) { lib.focus(k, { animate: false }); }
  const nodes = root.all();
  assert.ok(nodes.length < 130, `${nodes.length} nodes`);
  assert.ok(nodes.length - before < 40, 'no growth with travel');
  assert.ok(nodes.filter((e) => e.tagName === 'CANVAS').length <= 9);
  assert.equal(find(root, 'tl-cv').length, 9);
  assert.equal(lib.getFocus(), 1500);
});

test('setAlbums keeps the focused album when it is still there; odd input is tolerated', () => {
  const { lib } = setup(10);
  lib.focus(4, { animate: false });
  lib.setAlbums([mk(9), mk(4), mk(7)]);
  assert.equal(lib.getFocus(), 1);
  lib.setAlbums([null, 3, { id: 'x' }, { tracks: [] }]);
  assert.equal(lib.getFocus(), 0);
  lib.setAlbums(undefined); assert.equal(lib.getFocus(), 0);
  lib.focus(99, { animate: false }); assert.equal(lib.getFocus(), 0);
  lib.setAlbums(albumsToCoverflow([]));
});

test('destroy: removes the DOM, stops the loop, revokes the object URLs it was given', () => {
  const { d, lib, root } = setup();
  const api = { create: () => 'blob:t/1', revoke() {}, Blob: class { } };
  const u = coverBlobUrl(Uint8Array.of(0xff, 0xd8, 0xff, 1), 'image/jpeg', api);
  lib.setAlbums([mk(0, { coverUrl: u })]);
  assert.ok(isTrackedCoverUrl(u));
  lib.setAlbums([mk(1)]);                                   // dropped from the list -> revoked
  assert.ok(!isTrackedCoverUrl(u));
  const u2 = coverBlobUrl(Uint8Array.of(0xff, 0xd8, 0xff, 1), 'image/jpeg', { ...api, create: () => 'blob:t/2' });
  lib.setAlbums([mk(0, { coverUrl: u2 })]);
  lib.destroy();
  assert.ok(!isTrackedCoverUrl(u2));
  assert.equal(root.parentNode, null);
  lib.setAlbums([mk(3)]); lib.focus(1); lib.show();         // no-ops, no throw
  d.step(16, 3);
});

test('getSlotRect returns the slot placeholder rect', () => {
  const { lib } = setup();
  assert.equal(typeof lib.getSlotRect().width, 'number');
});

test('scan chip wording: web default, scanLabel dep and setScanLabel (native Android says Scan phone)', () => {
  const d = makeDom();
  const web = mountTurntableLibrary(d.container, d.deps);
  assert.equal(find(web.el, 'tl-long')[0].textContent, 'Scan music folder');
  assert.equal(find(web.el, 'tl-hint')[0].textContent, 'Scan your music folder to play your own music');
  web.setScanLabel({ long: 'Scan phone', hint: 'Scan your phone to fill the shelf' });
  assert.equal(find(web.el, 'tl-long')[0].textContent, 'Scan phone');
  assert.equal(find(web.el, 'tl-short')[0].textContent, 'Scan');
  assert.equal(find(web.el, 'tl-hint')[0].textContent, 'Scan your phone to fill the shelf');
  web.destroy();
  const d2 = makeDom();
  const nat = mountTurntableLibrary(d2.container, { ...d2.deps, scanLabel: { long: 'Scan phone', short: 'Scan', hint: 'Scan your phone to fill the shelf' } });
  assert.equal(find(nat.el, 'tl-long')[0].textContent, 'Scan phone');
  nat.destroy();
});
