import test from 'node:test';
import assert from 'node:assert/strict';
import { inEdgeStrip, drawerMayStart, owner } from '../src/shell/arbitration.js';
import { DRAWER } from '../src/shell/drawer.js';
import { pickNowPlaying, miniBarVisible } from '../src/shell/nowplaying.js';

const base = { open: false, where: 'page', pageGestureLive: false, otherPointers: 0, overlayOpen: false };

test('only the first EDGE_STRIP_PX px are the strip', () => {
  assert.equal(inEdgeStrip(0), true);
  assert.equal(inEdgeStrip(DRAWER.EDGE_STRIP_PX), true);
  assert.equal(inEdgeStrip(DRAWER.EDGE_STRIP_PX + 1), false);
  assert.equal(inEdgeStrip(-3), false);
});

test('closed: the strip starts a drawer drag, the page (platter, cassettes) never does', () => {
  assert.equal(owner({ ...base, where: 'strip' }), 'drawer');
  assert.equal(owner({ ...base, where: 'page' }), 'page');
  assert.equal(owner({ ...base, where: 'cover' }), 'page', 'the cover does not exist while closed');
});

test('a live platter / tonearm / pinch gesture blocks the drawer, even from the strip', () => {
  assert.equal(drawerMayStart({ ...base, where: 'strip', pageGestureLive: true }), false);
  assert.equal(drawerMayStart({ ...base, open: true, where: 'cover', pageGestureLive: true }), false);
});

test('a second finger never starts or joins a drawer drag', () => {
  assert.equal(drawerMayStart({ ...base, where: 'strip', otherPointers: 1 }), false);
});

test('open: the covered card is the drawer\'s', () => {
  assert.equal(owner({ ...base, open: true, where: 'cover' }), 'drawer');
  assert.equal(owner({ ...base, open: true, where: 'strip' }), 'drawer');
  assert.equal(owner({ ...base, open: true, where: 'page' }), 'page');
});

test('overlays (cassette player, editors, walkthrough) swallow edge presses', () => {
  assert.equal(drawerMayStart({ ...base, where: 'strip', overlayOpen: true }), false);
});

test('now playing: radio > mixtape > album; none when nothing plays', () => {
  assert.equal(pickNowPlaying({}), null);
  assert.equal(pickNowPlaying(null), null);
  assert.equal(pickNowPlaying({ album: { title: 'A' } }).home, 'albums');
  assert.equal(pickNowPlaying({ album: { title: 'A' }, mixtape: { title: 'M', sub: 'Tape' } }).source, 'mixtape');
  assert.equal(pickNowPlaying({ album: { title: 'A' }, mixtape: { title: 'M' }, radio: { title: 'R' } }).home, 'radio');
  assert.equal(pickNowPlaying({ radio: { title: '' } }), null);
});

test('the mini bar hides on the source\'s own section', () => {
  const np = pickNowPlaying({ radio: { title: 'Meridian' } });
  assert.equal(miniBarVisible(np, 'radio'), false);
  assert.equal(miniBarVisible(np, 'albums'), true);
  assert.equal(miniBarVisible(null, 'albums'), false);
});
