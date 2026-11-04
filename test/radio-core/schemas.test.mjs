import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateContextSnapshot, validateRundown, validateSegment, validateScript, validateCallerTurn, validateStationMemory,
  VALIDATORS, SCHEMA_IDS, validate, LIMITS,
} from '../../src/radio/core/schemas.js';
import { snapshotFixture, SNAPSHOT_NAMES, goldenRundown, goldenScripts, makeLibrary } from '../../src/radio/core/fixtures.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const segment = () => ({ schemaVersion: 1, segmentId: 'sg1', slotId: 's1', kind: 'song', trackId: 't001', startSec: 0, durationSec: 200 });
const turn = () => ({
  schemaVersion: 1, callId: 'c1', turn: 0, direction: 'listener_calls_station', startedAt: '2026-11-04T18:05:00.000Z',
  listener: { transcript: 'play something slow', sttConfidence: 0.9, bargedIn: false, durationMs: 1800, audioRetained: false },
  actions: [{ type: 'request_song', query: 'slow', dedication: null }, { type: 'note_for_show', text: 'likes slow songs' }, { type: 'end_call' }],
  safety: 'ok',
});

test('every validator accepts its golden fixture', () => {
  for (const n of SNAPSHOT_NAMES) assert.deepEqual(validateContextSnapshot(snapshotFixture(n)), { ok: true, errors: [] }, n);
  assert.equal(validateRundown(goldenRundown()).ok, true);
  for (const s of Object.values(goldenScripts())) assert.equal(validateScript(s).ok, true);
  assert.equal(validateSegment(segment()).ok, true);
  assert.equal(validateCallerTurn(turn()).ok, true);
  assert.equal(validateStationMemory(snapshotFixture().memory).ok, true);
});

test('validators never throw on hostile input and always return {ok, errors[]}', () => {
  const cyc = {}; cyc.self = cyc;
  const evil = { get schemaVersion() { throw new Error('boom'); } };
  const junk = [undefined, null, 0, 'x', [], {}, cyc, evil, () => 1, Symbol('s'), NaN, { slots: 'no' }, { utterances: [null, 7] }];
  for (const v of Object.values(VALIDATORS)) {
    for (const j of junk) {
      const r = v(j);
      assert.equal(typeof r.ok, 'boolean');
      assert.ok(Array.isArray(r.errors));
      assert.equal(r.ok, r.errors.length === 0);
      assert.equal(r.ok, false);
    }
  }
});

test('versioning: wrong or missing schemaVersion is rejected with a clear path', () => {
  for (const [id, mk] of [[SCHEMA_IDS.rundown, goldenRundown], [SCHEMA_IDS.segment, segment], [SCHEMA_IDS.callerTurn, turn]]) {
    const v = mk(); v.schemaVersion = 2;
    assert.match(validate(id, v).errors[0], /schemaVersion: unsupported version 2/);
    delete v.schemaVersion;
    assert.match(validate(id, v).errors[0], /schemaVersion: required/);
  }
  assert.equal(validate('runout/nope/1', {}).ok, false);
});

test('snapshot: duplicates, bad facts, bad enums, size caps are all reported', () => {
  const s = snapshotFixture('rainy-commute');
  s.facts.push({ ...s.facts[0] });
  s.facts[1].kind = 'astrology';
  delete s.facts[2].mentionable;
  s.time.daypart = 'teatime';
  s.facts[3].say = 'x'.repeat(LIMITS.maxFactSayChars + 1);
  s.libraryDigest.candidates = makeLibrary(LIMITS.maxCandidates + 1);
  const r = validateContextSnapshot(s);
  assert.equal(r.ok, false);
  const text = r.errors.join('\n');
  assert.match(text, /facts\[\d+\]\.id: duplicate/);
  assert.match(text, /facts\[1\]\.kind: must be one of/);
  assert.match(text, /facts\[2\]\.mentionable: required/);
  assert.match(text, /time\.daypart/);
  assert.match(text, /facts\[3\]\.say: longer than 160/);
  assert.match(text, /candidates: more than 60 items/);
});

test('snapshot: nested memory errors carry the memory path', () => {
  const s = snapshotFixture();
  s.memory.listenerNotes = [{ text: '', source: 'robot', at: 'now' }];
  const r = validateContextSnapshot(s);
  assert.ok(r.errors.some((e) => e.startsWith('memory.listenerNotes[0].text')));
  assert.ok(r.errors.some((e) => e.startsWith('memory.listenerNotes[0].source')));
});

test('rundown: slot kinds, duplicates, caps and shapes', () => {
  const r = goldenRundown();
  r.slots[1].kind = 'jingle';
  r.slots[2].slotId = r.slots[1].slotId;
  r.slots[3].song = { trackIdHint: 5 };
  r.slots[4].talk.mode = 'whispering';
  r.slots[0].targetSec = -3;
  r.slots.push(...Array.from({ length: 12 }, (_, i) => ({ slotId: `x${i}`, kind: 'song', targetSec: 1 })));
  const text = validateRundown(r).errors.join('\n');
  assert.match(text, /slots\[1\]\.kind/);
  assert.match(text, /duplicate slotId/);
  assert.match(text, /trackIdHint: must be a string/);
  assert.match(text, /talk\.mode/);
  assert.match(text, /targetSec: below minimum/);
  assert.match(text, /slots: more than 12 items/);
  assert.equal(validateRundown({ ...goldenRundown(), slots: [] }).ok, false);
});

test('script: style ranges, markup errors, factRefs shape, duplicate utterance ids', () => {
  const s = clone(goldenScripts().g5);
  s.utterances[0].style.pace = 2;
  s.utterances[0].style.emotion = 'furious';
  s.utterances[1].text = 'Hello {em}there {pause:99999}';
  s.utterances[2].id = s.utterances[1].id;
  s.utterances[2].factRefs = [1, 2];
  s.utterances[2].pauseAfterMs = 5000;
  const text = validateScript(s).errors.join('\n');
  assert.match(text, /style\.pace: above maximum/);
  assert.match(text, /style\.emotion/);
  assert.match(text, /markup: unclosed \{em\}/);
  assert.match(text, /markup: pause 99999ms/);
  assert.match(text, /duplicate id/);
  assert.match(text, /factRefs\[0\]: must be a string/);
  assert.match(text, /pauseAfterMs: above maximum/);
});

test('segment: song needs trackId, voice needs utterances, ducking bounds', () => {
  const a = segment(); delete a.trackId;
  assert.match(validateSegment(a).errors.join(), /trackId: required/);
  assert.match(validateSegment({ ...segment(), kind: 'voice', trackId: undefined }).errors.join(), /utterances: required/);
  assert.match(validateSegment({ ...segment(), duck: { depthDb: 6, leadMs: 250, releaseMs: 400 } }).errors.join(), /depthDb: above maximum/);
  assert.match(validateSegment({ ...segment(), durationSec: 0 }).errors.join(), /durationSec/);
});

test('caller turn: only the three actions exist; fields bounded', () => {
  const t = turn();
  t.actions.push({ type: 'run_shell', cmd: 'rm -rf /' });
  assert.match(validateCallerTurn(t).errors.join(), /actions\[3\]|more than 3/);
  const u = turn(); u.actions = [{ type: 'run_shell' }];
  assert.match(validateCallerTurn(u).errors.join(), /actions\[0\]\.type: must be one of/);
  const v = turn(); v.listener.transcript = 'a'.repeat(LIMITS.maxTranscriptChars + 1); v.safety = 'angry'; v.listener.sttConfidence = 2;
  const text = validateCallerTurn(v).errors.join('\n');
  assert.match(text, /transcript: longer/); assert.match(text, /safety/); assert.match(text, /sttConfidence: above/);
  const w = turn(); w.host = { script: { schemaVersion: 1, slotId: 's', utterances: [] } };
  assert.match(validateCallerTurn(w).errors.join(), /host\.script\.utterances: needs at least 1/);
});
