import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../../src/radio/core/index.js';

const { fixtureShow, repairRundown, planSongs, verifyScript, scheduleShow, findDeadAir, FakeVoice, createVirtualClock, validateScript, rundownProblems, FIXTURE_NOW_MS } = core;

test('barrel exports the whole public surface without name clashes', () => {
  for (const name of ['validateContextSnapshot', 'validateRundown', 'validateSegment', 'validateScript', 'validateCallerTurn', 'ShowClock',
    'scheduleShow', 'repairRundown', 'planSongs', 'verifyScript', 'parseMarkup', 'degradeUtterance', 'createCall', 'step', 'addListenerNote',
    'sanitizeText', 'filterActions', 'evaluateGate', 'FakeWriter', 'runSimulatedShow', 'CORE_VERSION']) {
    assert.equal(typeof core[name] === 'undefined', false, name);
  }
});

test('fixture show end to end: golden rundown -> songs -> scripts -> voice -> timeline', async () => {
  const { snapshot, rundown, scripts } = fixtureShow();
  assert.deepEqual(rundownProblems(rundown, snapshot), []);
  const rep = repairRundown(rundown, { snapshot, atMs: FIXTURE_NOW_MS });
  assert.equal(rep.ok, true);
  const cands = snapshot.libraryDigest.candidates;
  const { picks } = planSongs(rep.rundown.slots, cands, { seed: 7 });
  assert.equal(picks.get('g2'), 't003');                          // the valid hint wins
  const songIds = [...picks.values()];
  assert.equal(new Set(songIds).size, songIds.length);

  const voice = new FakeVoice({ clock: createVirtualClock(0) });
  const items = [];
  for (const slot of rep.rundown.slots) {
    if (slot.kind === 'station_id') items.push({ slotId: slot.slotId, kind: 'station_id', stinger: { id: 'stinger.id.1', durationSec: slot.targetSec } });
    else if (slot.kind === 'song') {
      const t = cands.find((c) => c.trackId === picks.get(slot.slotId));
      items.push({ slotId: slot.slotId, kind: 'song', track: { trackId: t.trackId, durationSec: t.durationSec, cues: t.cues } });
    } else if (scripts[slot.slotId]) {
      const s = scripts[slot.slotId];
      assert.equal(validateScript(s).ok, true);
      assert.deepEqual(verifyScript(s, snapshot, { atMs: FIXTURE_NOW_MS, trackMeta: Object.fromEntries(cands.map((c) => [c.trackId, c])) }).problems, []);
      const r = await voice.render({ script: s });
      items.push({ slotId: slot.slotId, kind: slot.kind, voice: { utterances: r.utterances.map(({ id, durationSec, droppable, pauseSec }) => ({ id, durationSec, droppable, pauseSec })) } });
    }
  }
  const out = scheduleShow(items);
  assert.deepEqual(findDeadAir(out.segments, { fromSec: 0, toSec: out.endSec }), []);
  assert.ok(out.segments.some((s) => s.kind === 'voice' && s.attachedTo));
  assert.ok(out.endSec > 800);
});
