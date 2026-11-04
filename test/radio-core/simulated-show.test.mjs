import test from 'node:test';
import assert from 'node:assert/strict';
import { runSimulatedShow, makeFakeAdapters } from '../../src/radio/core/sim.js';
import { verifyScript } from '../../src/radio/core/grounding.js';
import { validateSegment, validateScript } from '../../src/radio/core/schemas.js';
import { findDeadAir, insertAtSafePoint } from '../../src/radio/core/scheduler.js';
import { hasLeakedMarkers } from '../../src/radio/core/markup.js';
import { SNAPSHOT_NAMES, snapshotFixture, makeLibrary } from '../../src/radio/core/fixtures.js';

const LIB_IDS = new Set(makeLibrary(20).map((t) => t.trackId));
const end = (r) => Math.max(...r.segments.map((s) => s.startSec + s.durationSec));
function assertShowIsSound(r, label = '') {
  assert.deepEqual(r.deadAir, [], `${label} dead air`);
  assert.deepEqual(findDeadAir(r.segments, { fromSec: 0, toSec: end(r) }), [], `${label} dead air (recomputed)`);
  for (const s of r.segments) assert.deepEqual(validateSegment(s), { ok: true, errors: [] }, `${label} ${JSON.stringify(s)}`);
  // every script that went to air passes the verifier at its air time against the facts it was written from
  for (const a of r.aired) {
    assert.equal(validateScript(a.script).ok, true, `${label} ${a.slotId} schema`);
    const v = verifyScript(a.script, a.snapshot, { atMs: a.airAtMs });
    assert.deepEqual(v.problems, [], `${label} ${a.slotId} verifier`);
    for (const rd of a.rendered) assert.equal(hasLeakedMarkers(rd.body.replace(/<[^>]+>/g, '')), false, `${label} marker leak`);
  }
}

test('simulated 45-minute show: zero dead air, every script verified, nothing repeats', async () => {
  const r = await runSimulatedShow({ durationSec: 2700 });
  assert.ok(r.endSec >= 2700);
  assertShowIsSound(r);
  assert.equal(r.segments[0].kind, 'stinger');            // cold start: a local ID first, never silence
  assert.equal(r.segments[0].startSec, 0);
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.errors, []);
  assert.equal(r.canned.length, 0);
  assert.ok(r.aired.length >= 6, 'the host actually talked');
  const songs = r.segments.filter((s) => s.kind === 'song').map((s) => s.trackId);
  assert.ok(songs.length >= 12);
  assert.equal(new Set(songs).size, songs.length);
  assert.ok(songs.every((id) => LIB_IDS.has(id)));
  assert.ok(r.musicFraction > 0.6 && r.musicFraction < 1, `music fraction ${r.musicFraction}`);
  assert.ok(r.adapterCalls.director >= 3, 'the rundown rolled forward');
  assert.ok(r.segments.some((s) => s.mode === 'over_intro'), 'talk over intro happened');
  assert.ok(r.segments.some((s) => s.mode === 'between_songs'));
});

test('simulated show is deterministic and radio-style crossfades are gapless too', async () => {
  const a = await runSimulatedShow({ durationSec: 1500 });
  const b = await runSimulatedShow({ durationSec: 1500 });
  assert.deepEqual(a.segments, b.segments);
  assert.deepEqual(a.notes, b.notes);
  const radio = await runSimulatedShow({ durationSec: 1500, crossfade: 'radio' });
  assertShowIsSound(radio, 'radio');
  assert.ok(radio.segments.some((s) => s.fadeInSec > 0));
  const c = await runSimulatedShow({ durationSec: 1500, seed: 99, adapters: makeFakeAdapters({ seed: 99 }) });
  assert.notDeepEqual(a.segments.filter((s) => s.kind === 'song').map((s) => s.trackId), c.segments.filter((s) => s.kind === 'song').map((s) => s.trackId));
});

test('a caller can be dropped into a finished show at a safe point without dead air', async () => {
  const r = await runSimulatedShow({ durationSec: 1500 });
  for (const now of [300, 701.5, 1000, 1234.5]) {
    const out = insertAtSafePoint(r.segments, now, { durationSec: 45, segmentId: `c${now}` });
    assert.ok(out.safePoint.atSec >= now);
    assert.deepEqual(findDeadAir(out.segments, { fromSec: 0, toSec: end({ segments: out.segments }) }), [], `at ${now}`);
    for (const s of out.segments) assert.equal(validateSegment(s).ok, true, JSON.stringify(s));
  }
});

test('every context scenario produces a sound show', async () => {
  for (const name of SNAPSHOT_NAMES) {
    const r = await runSimulatedShow({ durationSec: 1200, scenario: name, adapters: makeFakeAdapters({ scenario: name }) });
    assertShowIsSound(r, name);
    assert.ok(r.endSec >= 1200, name);
  }
});

test('weather down / no location: the host never mentions what it cannot know', async () => {
  for (const name of ['weather-down', 'no-location']) {
    const r = await runSimulatedShow({ durationSec: 1800, scenario: name, adapters: makeFakeAdapters({ scenario: name }) });
    assertShowIsSound(r, name);
    const spoken = r.aired.flatMap((a) => a.script.utterances.map((u) => u.text)).join(' ');
    assert.doesNotMatch(spoken, /\b(rain|raining|degrees|forecast|snow|sunny)\b/i, name);
  }
});

test('small and empty libraries degrade to filler instead of silence or repeats', async () => {
  const five = await runSimulatedShow({ durationSec: 1500, scenario: 'five-track-library', adapters: makeFakeAdapters({ scenario: 'five-track-library' }) });
  assertShowIsSound(five, 'five');
  const songs = five.segments.filter((s) => s.kind === 'song' && !five.replays.some((x) => x.slotId === s.slotId)).map((s) => s.trackId);
  assert.equal(new Set(songs).size, songs.length);
  assert.ok(five.fallbacks.length > 0);
  const empty = await runSimulatedShow({ durationSec: 600, scenario: 'empty-library', adapters: makeFakeAdapters({ scenario: 'empty-library' }) });
  assertShowIsSound(empty, 'empty');
  assert.ok(empty.segments.every((s) => s.kind !== 'song'));
});

test('hostile ID3 tags never reach the air', async () => {
  const r = await runSimulatedShow({ durationSec: 1200, scenario: 'hostile-id3', adapters: makeFakeAdapters({ scenario: 'hostile-id3' }) });
  assertShowIsSound(r, 'hostile');
  const spoken = r.aired.flatMap((a) => a.script.utterances.map((u) => u.text)).join(' ');
  assert.doesNotMatch(spoken, /Elm Street|passwd|unrestricted|555|IGNORE/i);
  // same corpus, same snapshot, but the model parrots a hostile title: the verifier refuses it
  const snap = snapshotFixture('hostile-id3');
  const parrot = { schemaVersion: 1, slotId: 'p', utterances: [{ id: 'p1', text: snap.libraryDigest.candidates[0].title, style: { emotion: 'warm', energy: 0.5, pace: 1 }, factRefs: [] }] };
  assert.equal(verifyScript(parrot, snap, { atMs: Date.parse(snap.takenAt) }).ok, false);
});
