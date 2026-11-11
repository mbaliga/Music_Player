// The proper-noun scan must not cut names at accented letters (found by the offline host with real-world artist names).
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyScript } from '../../src/radio/core/grounding.js';
import { snapshotFixture, FIXTURE_NOW_MS } from '../../src/radio/core/fixtures.js';

const utt = (text, factRefs) => ({ schemaVersion: 1, slotId: 's', utterances: [{ id: 'u', text, style: { emotion: 'warm', energy: 0.5, pace: 1 }, factRefs }] });
const withName = (name) => {
  const s = snapshotFixture('rainy-commute');
  s.facts.push({ id: 'trk.next', kind: 'library', value: { title: name, artist: null }, say: name, asOf: s.takenAt, ttlSec: 3600, source: 'library', mentionable: true });
  return s;
};

test('accented Latin names that come from a referenced fact are grounded', () => {
  for (const name of ['Björk', 'Sigur Rós', 'Beyoncé', 'Motörhead', 'Ünïcödé Ñoño', 'Mötley Crüe', 'Łódź Night', 'Þorsteinn']) {
    const s = withName(name);
    const v = verifyScript(utt(`Up next, ${name}.`, ['trk.next']), s, { atMs: FIXTURE_NOW_MS });
    assert.equal(v.ok, true, `${name}: ${JSON.stringify(v.problems)}`);
  }
});

test('an accented name nobody supplied is still ungrounded', () => {
  const s = snapshotFixture('rainy-commute');
  const v = verifyScript(utt('Up next, Björk Quartet.', []), s, { atMs: FIXTURE_NOW_MS });
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.code === 'ungrounded_name'));
});
