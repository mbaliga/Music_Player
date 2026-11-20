import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SECTIONS, BOOTH_LABEL, DEFAULT_SECTION, STORAGE_KEY, ids, labelOf, indexOf, resolveSection, loadSection, saveSection, stepMenu,
} from '../src/shell/sections.js';

test('four sections in the owner\'s order; Booth reads the single label constant', () => {
  assert.deepEqual(ids(), ['albums', 'mixtapes', 'radio', 'booth', 'settings']);
  assert.deepEqual(SECTIONS.map((s) => s.label), ['Albums', 'Mixtapes', 'Radio', BOOTH_LABEL, 'Settings']);
  assert.equal(labelOf('booth'), BOOTH_LABEL);
  assert.equal(labelOf('nope'), '');
  assert.equal(new Set(ids()).size, 5);
});

test('resolveSection falls back to the default for anything unknown', () => {
  assert.equal(resolveSection('radio'), 'radio');
  for (const bad of [null, undefined, '', 'library', 42, '__proto__']) assert.equal(resolveSection(bad), DEFAULT_SECTION);
  assert.equal(DEFAULT_SECTION, 'albums');
});

function fakeStorage(init = {}) { const m = { ...init }; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, m }; }

test('persistence round trip; first run opens Albums; garbage is ignored', () => {
  const st = fakeStorage();
  assert.equal(loadSection(st), 'albums');
  assert.equal(saveSection(st, 'mixtapes'), true);
  assert.equal(st.m[STORAGE_KEY], 'mixtapes');
  assert.equal(loadSection(st), 'mixtapes');
  assert.equal(loadSection(fakeStorage({ [STORAGE_KEY]: 'garbage' })), 'albums');
});

test('storage that throws (private window) never breaks navigation', () => {
  const boom = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(loadSection(boom), 'albums');
  assert.equal(saveSection(boom, 'radio'), false);
  assert.equal(loadSection(null), 'albums');
  assert.equal(saveSection(null, 'radio'), false);
});

test('menu keyboard: arrows wrap, Home/End jump, other keys keep the index', () => {
  assert.equal(stepMenu(0, 'ArrowDown', 4), 1);
  assert.equal(stepMenu(3, 'ArrowDown', 4), 0);
  assert.equal(stepMenu(0, 'ArrowUp', 4), 3);
  assert.equal(stepMenu(2, 'Home', 4), 0);
  assert.equal(stepMenu(1, 'End', 4), 3);
  assert.equal(stepMenu(1, 'a', 4), 1);
  assert.equal(stepMenu(1, 'ArrowDown', 0), 0);
  assert.equal(indexOf('radio'), 2);
  assert.equal(indexOf('zzz'), 0);
});
