import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSlotValue, slotValues, fillText, resolveUnit, slotsSatisfied, isLatinText, MAX_NAME_CHARS } from '../../src/radio/canned/slots.js';
import { STATION_IDS, loadPackFile } from '../support/canned-sim.mjs';

test('slot values are cleaned like On-air names and refuse what a fixed sentence cannot carry', () => {
  assert.equal(cleanSlotValue('nextTitle', '01 - Harbor_Lights [Remastered 2011].mp3'), 'Harbor Lights');
  assert.equal(cleanSlotValue('nextTitle', 'Paper Moon (Live)'), 'Paper Moon (Live)');
  assert.equal(cleanSlotValue('prevArtist', 'The Velvet Lanterns'), 'The Velvet Lanterns');
  for (const bad of ['Track 03', '', null, undefined, 'Unknown', '12345', '???', '夜に駆ける', 'Дождь', 'x'.repeat(MAX_NAME_CHARS + 1), 'one two three four five six seven eight nine ten', 'song.mp3.mp3', 'http://x.y']) {
    assert.equal(cleanSlotValue('nextTitle', bad), null, String(bad));
  }
  for (const bad of ['Unknown Artist', 'Various Artists', '<unknown>', '夜']) assert.equal(cleanSlotValue('nextArtist', bad), null, bad);
  assert.equal(cleanSlotValue('album', 'Unknown Album'), null);
  assert.equal(cleanSlotValue('album', 'Night Shift'), 'Night Shift');
  assert.equal(isLatinText('Björk'), true);
  assert.equal(isLatinText('Beyoncé & Jay'), true);
  assert.equal(isLatinText('Дождь'), false);
  assert.equal(isLatinText('1999'), false);
  assert.doesNotThrow(() => { for (const v of [{}, [], 5, Symbol.iterator.toString(), '\u0000\u0001']) cleanSlotValue('nextTitle', v); });
});

test('slotValues pulls prev/next and takes the album from the next song, else the previous', () => {
  const v = slotValues({ prev: { title: 'A Song', artist: 'Ann', album: 'Prev Album' }, next: { title: 'B Song', artist: 'Bo', album: 'Unknown Album' } });
  assert.deepEqual(v, { prevTitle: 'A Song', prevArtist: 'Ann', nextTitle: 'B Song', nextArtist: 'Bo', album: 'Prev Album' });
  assert.deepEqual(slotValues({}), { prevTitle: null, prevArtist: null, nextTitle: null, nextArtist: null, album: null });
  assert.doesNotThrow(() => slotValues({ prev: 5, next: 'x' }));
  assert.equal(fillText('Up next {nextTitle} by {nextArtist}', { nextTitle: 'X', nextArtist: null }), 'Up next X by {nextArtist}');
});

test('every slot segment in every pack falls back to its twin whenever ANY needed slot is empty (never a literal brace)', () => {
  const full = { prevTitle: 'Harbor Lights', prevArtist: 'Mara Quill', nextTitle: 'Paper Moon', nextArtist: 'June Parlor', album: 'Night Shift' };
  let slotUnits = 0;
  for (const id of STATION_IDS) {
    const pack = loadPackFile(id);
    for (const u of pack.units.filter((x) => x.slots.length)) {
      slotUnits++;
      // all slots present -> the slot variant, fully filled, with the names in it
      const ok = resolveUnit(u, full);
      assert.equal(ok.variant, 'slots', u.id);
      for (const l of ok.lines) assert.doesNotMatch(l.text, /\{\w+\}/, u.id);
      assert.ok(ok.lines.some((l) => /Harbor Lights|Mara Quill|Paper Moon|June Parlor|Night Shift/.test(l.text)), u.id);
      // each needed slot emptied in turn -> the twin
      for (const s of u.slots) {
        const r = resolveUnit(u, { ...full, [s]: null });
        assert.equal(r.variant, 'twin', `${u.id} without ${s}`);
        assert.equal(r.seg.fallbackOf, u.id);
        for (const l of r.lines) assert.doesNotMatch(l.text, /\{\w+\}/);
      }
      // preferTwin (audio-pack mode) forces the recording's twin
      assert.equal(resolveUnit(u, full, { preferTwin: true }).variant, 'twin');
      assert.equal(slotsSatisfied(u.seg, full), true);
      assert.equal(slotsSatisfied(u.seg, {}), false);
    }
    // slot-free units are unaffected by what the library knows
    for (const u of pack.units.filter((x) => !x.slots.length)) assert.equal(resolveUnit(u, {}).variant, 'plain');
  }
  assert.ok(slotUnits >= 60, `${slotUnits} slot units`);
});

test('a unit with slots and no twin cannot be aired when a slot is missing (null, not a half-filled line)', () => {
  const unit = { id: 'x', seg: { id: 'x', usesSlots: ['nextTitle'], lines: [{ host: 'a', text: 'Next: {nextTitle}.' }], estSec: 3 }, twins: [] };
  assert.equal(resolveUnit(unit, {}), null);
  assert.equal(resolveUnit(unit, { nextTitle: 'Okay' }).lines[0].text, 'Next: Okay.');
  assert.equal(resolveUnit(null, {}), null);
});
