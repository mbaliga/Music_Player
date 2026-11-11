// radio-canned-snapshots.test.mjs — saved canned stations follow the stations index (renames), and missing ones are detectable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  emptyModel, toggleFavourite, recordPlayed, refreshCannedSnapshots, isMissingCanned, removeEntry, stationFromEntry, parseModel, serializeModel,
} from '../src/radio-store.js';

const idx = [{ id: 'meridian-91-5', name: 'Meridian 91.5', dial: '91.5', tagline: 'The art of listening.' }, { id: 'tape-hiss-fm', name: 'Tape Hiss FM', dial: '88.3', tagline: 'Nine watts.' }];
const stale = (id = 'meridian-91-5') => ({ type: 'canned', id, name: 'Old Meridian', dial: '90.0', tagline: 'old line', tags: ['canned'] });

test('refreshCannedSnapshots: name, dial and tagline of favourites, recents and last come from the index', () => {
  let m = emptyModel();
  m = toggleFavourite(m, stale(), 1);
  m = recordPlayed(m, stale('tape-hiss-fm'), 2);
  m = { ...m, last: { ...m.last, snap: { ...m.last.snap, name: 'Stale Tape' } }, favs: m.favs, recents: m.recents };
  m = recordPlayed(m, stale(), 3);
  const r = refreshCannedSnapshots(m, idx);
  assert.notEqual(r, m);
  for (const e of [...r.favs, ...r.recents, r.last]) {
    const x = idx.find((i) => i.id === e.id);
    assert.deepEqual([e.snap.name, e.snap.dial, e.snap.tagline], [x.name, x.dial, x.tagline]);
  }
  assert.equal(stationFromEntry(r.favs[0]).name, 'Meridian 91.5');
  assert.equal(refreshCannedSnapshots(r, idx), r, 'nothing to change -> same model (no save)');
});

test('refreshCannedSnapshots: other station types are untouched, and an empty / failed index changes nothing', () => {
  let m = emptyModel();
  m = toggleFavourite(m, { type: 'radio-browser', id: 'meridian-91-5', name: 'Real FM', streamUrl: 'https://s/1' }, 1);
  m = toggleFavourite(m, stale(), 2);
  assert.equal(refreshCannedSnapshots(m, []), m);
  assert.equal(refreshCannedSnapshots(m, null), m);
  const r = refreshCannedSnapshots(m, idx);
  assert.equal(r.favs.find((e) => e.type === 'radio-browser').snap.name, 'Real FM');
});

test('refreshed snapshots survive serialise / parse (dial and tagline are persisted)', () => {
  const m = refreshCannedSnapshots(toggleFavourite(emptyModel(), stale(), 1), idx);
  const back = parseModel(serializeModel(m));
  assert.equal(back.favs[0].snap.dial, '91.5');
  assert.equal(back.favs[0].snap.tagline, 'The art of listening.');
});

test('isMissingCanned: only a canned id absent from a loaded index', () => {
  assert.equal(isMissingCanned(stale('gone'), idx), true);
  assert.equal(isMissingCanned(stale(), idx), false);
  assert.equal(isMissingCanned(stale('gone'), null), false, 'index not loaded yet');
  assert.equal(isMissingCanned(stale('gone'), []), false, 'a failed load is not proof');
  assert.equal(isMissingCanned({ type: 'radio-browser', id: 'gone', name: 'x' }, idx), false);
});

test('removeEntry drops the station from favourites, recents and Resume', () => {
  let m = recordPlayed(toggleFavourite(emptyModel(), stale('gone'), 1), stale('gone'), 2);
  m = recordPlayed(m, stale('tape-hiss-fm'), 3);
  const r = removeEntry(m, 'canned|gone');
  assert.deepEqual([r.favs.length, r.recents.map((e) => e.id), r.last.id], [0, ['tape-hiss-fm'], 'tape-hiss-fm']);
  assert.equal(removeEntry(recordPlayed(emptyModel(), stale('gone'), 1), 'canned|gone').last, null);
});

test('recordPlayed never overwrites a fresh canned snapshot with a stale one', () => {
  let m = refreshCannedSnapshots(toggleFavourite(emptyModel(), stale(), 1), idx);
  // Resume / a saved row handed the stale object back: with the index, the index wins
  const a = recordPlayed(m, stale(), 5, idx);
  assert.equal(a.last.snap.name, 'Meridian 91.5');
  assert.equal(a.favs[0].snap.name, 'Meridian 91.5');
  assert.equal(a.recents[0].snap.dial, '91.5');
  // without the index (not loaded yet), the existing fresh snapshot is kept
  const b = recordPlayed(m, stale(), 6);
  assert.equal(b.last.snap.name, 'Meridian 91.5');
  assert.equal(b.favs[0].snap.tagline, 'The art of listening.');
  // a station the loaded index no longer lists is not recorded as played
  assert.equal(recordPlayed(m, stale('gone'), 7, idx), m);
});

test('dial cards are plain containers with one real button; no role=button wrapping buttons', () => {
  const src = readFileSync(new URL('../src/radio/canned/dial.js', import.meta.url), 'utf8');
  assert.ok(!/role:\s*'button'/.test(src));
  assert.ok(/class: 'dial-play', type: 'button'/.test(src));
});
