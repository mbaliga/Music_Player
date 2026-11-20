// mixtape-v4.test.mjs — tape model v4: tape lengths, two sides, caps (time + 20 songs),
// unknown durations, moving across sides, per-side locate, migration, hostile data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIXTAPE_VERSION, TAPES, MAX_SONGS_PER_SIDE, UNKNOWN_DURATION_SEC, createMixtape, makeTrackRef, refSeconds, cleanDur,
  sideInfo, sideDuration, remaining, canAdd, tryAdd, addTrack, addMany, removeFromSide, removeTrack, moveInSide, moveTrack,
  moveAcross, autoFill, fillTape, withTape, canResize, withDurations, withAutoReverse, tapeSeconds, songCount, isOverCap,
  fmtDur, locate, sideProgress, sideDurations, flatIndex, sideOfFlat, autoNote, cassetteCfg, serializeMixtape, parseMixtape,
  serializeCollection, parseCollection, parseImport, resolveTracks, sidesFromLegacy,
} from '../src/mixtape.js';

const tk = (title, dur, extra = {}) => ({ title, artist: 'A', album: 'X', ...(dur ? { durationSec: dur } : {}), ...extra });
const empty = (length = 'C30') => createMixtape({ id: 'm', name: 'T', tape: { length } });

test('tape lengths are real cassettes: 15 / 30 / 45 minutes per side, 20 songs per side', () => {
  assert.equal(MIXTAPE_VERSION, 4);
  assert.equal(TAPES.C30.sideSec, 900); assert.equal(TAPES.C60.sideSec, 1800); assert.equal(TAPES.C90.sideSec, 2700);
  assert.equal(MAX_SONGS_PER_SIDE, 20);
  const m = createMixtape({ id: 'x' });
  assert.equal(m.tape.length, 'C60'); assert.equal(m.autoReverse, true);
  assert.deepEqual(m.sides, { A: [], B: [] }); assert.deepEqual(m.tracks, []);
  assert.equal(createMixtape({ id: 'y', tape: { length: 'C99' } }).tape.length, 'C60');
});

test('caps per tape length: exactly full is allowed, one second over is refused', () => {
  for (const [len, cap] of [['C30', 900], ['C60', 1800], ['C90', 2700]]) {
    let m = empty(len);
    m = tryAdd(m, 'A', tk('big', cap - 1)).mixtape;
    assert.equal(sideDuration(m, 'A'), cap - 1);
    assert.equal(canAdd(m, 'A', tk('one', 2)).ok, false);          // one second over
    assert.equal(canAdd(m, 'A', tk('fit', 1)).ok, true);           // exactly full
    const full = tryAdd(m, 'A', tk('fit', 1));
    assert.equal(full.ok, true); assert.equal(sideDuration(full.mixtape, 'A'), cap);
    assert.equal(remaining(full.mixtape, 'A').sec, 0);
    const over = tryAdd(full.mixtape, 'A', tk('x', 1));
    assert.equal(over.ok, false); assert.equal(over.mixtape, full.mixtape); assert.equal(over.code, 'time');
    assert.ok(canAdd(full.mixtape, 'B', tk('other', 100)).ok);     // the other side is its own tape
  }
});

test('refusal reasons are sentences the UI can show', () => {
  const m = tryAdd(empty('C30'), 'A', tk('a', 770)).mixtape;
  const r = canAdd(m, 'A', tk('b', 225));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'Side A has 2:10 left; this song is 3:45.');
  assert.equal(canAdd(m, 'B', tk('b', 1000)).reason, 'Side B has 15:00 left; this song is 16:40.');
  assert.match(canAdd(m, 'C', tk('b', 5)).reason, /side A or B/);
});

test('20 songs per side: the 20th fits, the 21st is refused even with time to spare', () => {
  let m = empty('C90');
  for (let i = 1; i <= 20; i++) { const r = tryAdd(m, 'A', tk('s' + i, 30)); assert.ok(r.ok, 'song ' + i); m = r.mixtape; }
  assert.equal(m.sides.A.length, 20);
  const r = tryAdd(m, 'A', tk('s21', 30));
  assert.equal(r.ok, false); assert.equal(r.code, 'count'); assert.match(r.reason, /20 songs/);
  assert.ok(tryAdd(m, 'B', tk('s21', 30)).ok);
  // 40 per tape
  for (let i = 1; i <= 20; i++) m = tryAdd(m, 'B', tk('b' + i, 30)).mixtape;
  assert.equal(songCount(m), 40); assert.equal(m.tracks.length, 40);
  assert.equal(addTrack(m, tk('no', 30), 'B'), m);
});

test('unknown durations count as a conservative 4:00 and are flagged', () => {
  assert.equal(UNKNOWN_DURATION_SEC, 240);
  let m = empty('C30');
  m = addTrack(m, tk('mystery'), 'A');
  assert.deepEqual(refSeconds(m.sides.A[0]), { sec: 240, est: true });
  assert.deepEqual(sideInfo(m, 'A'), { sec: 240, est: true, count: 1 });
  assert.equal(fmtDur(240, true), '~4:00');
  // 3 unknowns = 12:00; the 4th (16:00) is refused with an estimate marker in the reason
  m = addTrack(addTrack(m, tk('u2'), 'A'), tk('u3'), 'A');
  const r = canAdd(m, 'A', tk('u4'));
  assert.equal(r.ok, false); assert.equal(r.reason, 'Side A has 3:00 left; this song is ~4:00.');
  // the real duration is learned later: hints replace the estimate
  const resolved = m.tracks.map((_, i) => ({ durationSec: [201.2, 199, 5][i] }));
  const m2 = withDurations(m, resolved);
  assert.deepEqual(m2.sides.A.map((r) => r.dur), [202, 199, 5]);   // rounded UP, conservative
  assert.equal(sideInfo(m2, 'A').est, false);
  assert.equal(withDurations(m2, resolved), m2);                    // nothing changed -> same object
  assert.equal(canAdd(m2, 'A', tk('u4')).ok, true);
});

test('a decoded real duration can push a side over its cap: flagged, never dropped', () => {
  let m = empty('C30');
  m = addMany(m, 'A', [tk('a'), tk('b'), tk('c')]).mixtape;       // 3 x ~4:00 = 12:00
  const m2 = withDurations(m, [{ durationSec: 400 }, { durationSec: 400 }, { durationSec: 400 }]);
  assert.equal(m2.tracks.length, 3); assert.equal(isOverCap(m2, 'A'), true); assert.equal(isOverCap(m2), true);
  assert.equal(canAdd(m2, 'A', tk('d', 1)).ok, false);
  assert.equal(remaining(m2, 'A').sec, 0);
});

test('addMany adds what fits and reports each skip with its reason', () => {
  const m = empty('C30');
  const r = addMany(m, 'A', [tk('a', 400), tk('b', 400), tk('c', 100), tk('d', 200)]);
  assert.equal(r.added, 3);                                        // 400 + 400 + 100 = 900 exactly; d skipped
  assert.deepEqual(r.mixtape.sides.A.map((t) => t.title), ['a', 'b', 'c']);
  assert.equal(r.skipped.length, 1); assert.equal(r.skipped[0].track.title, 'd'); assert.match(r.skipped[0].reason, /Side A has 0:00 left/);
  assert.equal(m.sides.A.length, 0);                               // input untouched
});

test('remove / move within a side, legacy flat indices, and across sides honouring caps', () => {
  let m = empty('C30');
  m = addMany(m, 'A', [tk('a1', 300), tk('a2', 300), tk('a3', 300)]).mixtape;
  m = addMany(m, 'B', [tk('b1', 300), tk('b2', 300), tk('b3', 300)]).mixtape;
  assert.deepEqual(m.tracks.map((t) => t.title), ['a1', 'a2', 'a3', 'b1', 'b2', 'b3']);
  assert.deepEqual(moveInSide(m, 'A', 0, 2).sides.A.map((t) => t.title), ['a2', 'a3', 'a1']);
  assert.deepEqual(moveInSide(m, 'B', 2, -9).sides.B.map((t) => t.title), ['b3', 'b1', 'b2']);
  assert.equal(moveInSide(m, 'A', 7, 0), m);
  assert.deepEqual(removeFromSide(m, 'B', 1).sides.B.map((t) => t.title), ['b1', 'b3']);
  assert.deepEqual(removeTrack(m, 4).sides.B.map((t) => t.title), ['b1', 'b3']);
  assert.deepEqual(moveTrack(m, 3, 5).sides.B.map((t) => t.title), ['b2', 'b3', 'b1']);
  assert.deepEqual(moveTrack(m, 1, 99).sides.A.map((t) => t.title), ['a1', 'a3', 'a2']);   // clamps to its own side
  // across: both sides are exactly full (900) so the move is refused and nothing changes
  const full = moveAcross(m, 'A', 0, 'B');
  assert.equal(full.ok, false); assert.equal(full.mixtape, m); assert.match(full.reason, /Side B has 0:00 left/);
  const roomy = removeFromSide(m, 'B', 0);
  const ok = moveAcross(roomy, 'A', 0, 'B', 0);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.mixtape.sides.A.map((t) => t.title), ['a2', 'a3']);
  assert.deepEqual(ok.mixtape.sides.B.map((t) => t.title), ['a1', 'b2', 'b3']);
  assert.deepEqual(ok.mixtape.tracks.map((t) => t.title), ['a2', 'a3', 'a1', 'b2', 'b3']);
  assert.equal(moveAcross(m, 'A', 9, 'B').ok, false);
});

test('autoFill puts the rest of a pool on a side, skipping what is already on the tape', () => {
  let m = empty('C30');
  m = addTrack(m, tk('a', 300, { id: 'id-a' }), 'A');
  const pool = [tk('a', 300, { id: 'id-a' }), tk('b', 300, { id: 'id-b' }), tk('c', 300, { id: 'id-c' }), tk('d', 300, { id: 'id-d' }), tk('e', 300, { id: 'id-e' })];
  const r = autoFill(m, 'B', pool);
  assert.deepEqual(r.mixtape.sides.B.map((t) => t.title), ['b', 'c', 'd']);   // a is already on A; B holds 3 x 5:00
  assert.equal(r.skipped.length, 1);
  const f = fillTape(empty('C30'), pool);
  assert.deepEqual(f.mixtape.sides.A.map((t) => t.title), ['a', 'b', 'c']);
  assert.deepEqual(f.mixtape.sides.B.map((t) => t.title), ['d', 'e']);
});

test('tape length changes: growing is free, shrinking below what a side holds is refused', () => {
  let m = empty('C90');
  m = addMany(m, 'A', [tk('a', 1200), tk('b', 1200)]).mixtape;      // 40:00
  assert.equal(canResize(m, 'C60').ok, false);
  assert.match(canResize(m, 'C60').reason, /Side A holds 40:00; a C60 side takes 30:00/);
  assert.equal(canResize(m, 'C90').ok, true);
  assert.equal(withTape(m, 'C60').tape.length, 'C60');   // withTape does not judge; canResize does
  assert.equal(withTape(m, 'nope'), m);
  assert.equal(withAutoReverse(m, false).autoReverse, false);
  assert.equal(tapeSeconds(m), 2400);
});

test('per-side locate: each side has its own 0..1 position, indices are within the side', () => {
  let m = empty('C60');
  m = addMany(m, 'A', [tk('a1', 100), tk('a2', 300)]).mixtape;
  m = addMany(m, 'B', [tk('b1', 200), tk('b2', 200), tk('b3', 400)]).mixtape;
  const dA = sideDurations(m, 'A'), dB = sideDurations(m, 'B');
  assert.deepEqual(dA, [100, 300]); assert.deepEqual(dB, [200, 200, 400]);
  assert.equal(sideProgress(m, 'A', 1, 0.5, dA), 0.625);
  assert.equal(sideProgress(m, 'B', 0, 0, dB), 0);                  // side B starts at 0 whatever A did
  assert.deepEqual(locate(m, 'A', 0.25, dA), { side: 'A', index: 0, frac: 1 });   // the boundary belongs to the song that just ended
  const l = locate(m, 'B', 0.5, dB);
  assert.equal(l.side, 'B'); assert.equal(l.index, 1); assert.ok(Math.abs(l.frac - 1) < 1e-9);
  // round trip
  for (const p of [0, 0.1, 0.5, 0.99, 1]) { const q = locate(m, 'B', p, dB); assert.ok(Math.abs(sideProgress(m, 'B', q.index, q.frac, dB) - p) < 1e-9); }
  assert.deepEqual(locate(empty(), 'A', 0.5, []), { side: 'A', index: 0, frac: 0 });
  assert.equal(flatIndex(m, 'B', 1), 3); assert.deepEqual(sideOfFlat(m, 1), { side: 'A', index: 1 }); assert.deepEqual(sideOfFlat(m, 4), { side: 'B', index: 2 });
  // unknown durations on a side -> equal weighting, no throw
  const u = locate(m, 'B', 0.5, [null, null, null]); assert.equal(u.index, 1);
});

test('label note and cassette cfg follow the side shown', () => {
  let m = empty();
  m = addMany(m, 'A', [tk('a', 60), tk('b', 60)]).mixtape;
  m = addMany(m, 'B', [tk('c', 60)]).mixtape;
  assert.equal(autoNote(m), 'Side A · 2 songs'); assert.equal(autoNote(m, 'B'), 'Side B · 1 song');
  assert.equal(cassetteCfg(m).text.side, 'A');
  const c = cassetteCfg(m, { side: 'B', reelStandIns: true });
  assert.equal(c.text.side, 'B'); assert.equal(c.text.note, 'Side B · 1 song'); assert.equal(c.reelStandIns, true); assert.equal(c.side, undefined);
});

test('v4 JSON round-trips (single doc and collection), keeps hints and ids', () => {
  let m = createMixtape({ id: 'q', name: 'Both', author: 'me', tape: { length: 'C90' }, autoReverse: false });
  m = addMany(m, 'A', [tk('one', 200, { id: 'tid1' }), tk('two')]).mixtape;
  m = addMany(m, 'B', [tk('three', 100)]).mixtape;
  const text = serializeMixtape(m), j = JSON.parse(text);
  assert.equal(j.version, 4); assert.equal(j.tape.length, 'C90'); assert.equal(j.autoReverse, false);
  assert.deepEqual(j.sides.A[0], { title: 'one', artist: 'A', album: 'X', id: 'tid1', dur: 200 });
  assert.deepEqual(j.sides.A[1], { title: 'two', artist: 'A', album: 'X' });
  const back = parseMixtape(text, { id: 'q' });
  assert.ok(back.ok); assert.deepEqual(back.mixtape, m);
  const col = parseCollection(serializeCollection([m, empty()]));
  assert.equal(col.length, 2); assert.deepEqual(col[0], m);
  assert.equal(parseImport(text).mixtapes[0].tape.length, 'C90');
});

test('v3 migrates to side A on a tape that fits (B empty); songs are never dropped', () => {
  const v3 = JSON.stringify({ version: 3, name: 'Old', author: 'a', cfg: { style: 'noir', pen: 'type', wear: 0.2, gloss: 0.4, text: { subtitle: '', note: '', side: 'A' } },
    tracks: [{ title: 'a', artist: 'b', album: 'c', id: 'i1' }, { title: 'b' }] });
  const p = parseMixtape(v3);
  assert.ok(p.ok); assert.equal(p.mixtape.tape.length, 'C60'); assert.equal(p.mixtape.sides.A.length, 2); assert.equal(p.mixtape.sides.B.length, 0);
  assert.equal(p.mixtape.autoReverse, true); assert.equal(p.mixtape.sides.A[0].id, 'i1');
  const col = parseCollection(JSON.stringify({ version: 3, mixtapes: [{ id: 'z', name: 'Z', tracks: [{ title: 't' }], cfg: {} }] }));
  assert.equal(col[0].sides.A.length, 1); assert.equal(col[0].tape.length, 'C60');
  // 70 songs of 4:00 (est) cannot fit: A is filled to its caps, the rest stays on B (over its caps), nothing lost
  const big = Array.from({ length: 70 }, (_, i) => ({ title: 'n' + i }));
  const r = sidesFromLegacy(big.map(makeTrackRef));
  assert.equal(r.length, 'C90'); assert.equal(r.A.length, 11);      // 11 x 4:00 = 44:00 <= 45:00
  assert.equal(r.A.length + r.B.length, 70);
  const mm = createMixtape({ id: 'b', tracks: big });
  assert.equal(mm.tracks.length, 70); assert.equal(isOverCap(mm, 'B'), true); assert.equal(canAdd(mm, 'B', tk('x', 1)).ok, false);
  // a v3 list of 25 short songs: > 20, so side A is full at 20 and the rest sits on B
  const shorts = createMixtape({ id: 's', tracks: Array.from({ length: 25 }, (_, i) => tk('s' + i, 60)) });
  assert.equal(shorts.sides.A.length, 20); assert.equal(shorts.sides.B.length, 5); assert.equal(isOverCap(shorts), false);
});

test('hostile data: bad tape, bad durations, bad sides never throw and never get through', () => {
  assert.equal(cleanDur(NaN), 0); assert.equal(cleanDur(-3), 0); assert.equal(cleanDur(Infinity), 0); assert.equal(cleanDur('9'), 0);
  assert.equal(cleanDur(1e9), 0); assert.equal(cleanDur(0.2), 1); assert.equal(cleanDur(224.4), 225);
  const m = createMixtape({ id: 'h', name: '<img src=x onerror=alert(1)>', sides: { A: [{ title: '<b>x</b>', dur: -5 }, null, 7, { title: 'ok', dur: 'abc' }], B: 'nope', __proto__: { x: 1 } }, tape: 'C45' });
  assert.equal(m.sides.A.length, 2); assert.deepEqual(m.sides.B, []); assert.equal(m.sides.A[0].dur, undefined);
  assert.equal(m.name, '<img src=x onerror=alert(1)>');               // stored as text; the UI only ever uses textContent
  for (const bad of [null, undefined, 5, 'x', [], {}]) assert.doesNotThrow(() => createMixtape({ id: 'z', sides: bad }));
  assert.equal(parseMixtape('{"version":4,"name":"n","cfg":{"style":"clear","pen":"marker"},"sides":[]}').ok, false);
  assert.equal(parseMixtape('{"version":4,"name":"n","cfg":{"style":"clear","pen":"marker"},"sides":{"A":"x"}}').ok, false);
  assert.equal(parseMixtape('{"version":4,"name":"n","cfg":{"style":"clear","pen":"marker"},"sides":{"A":[]},"tape":"C30"}').ok, false);
  const ok = parseMixtape('{"version":4,"name":"n","cfg":{"style":"clear","pen":"marker"},"sides":{"A":[{"title":"t","dur":1e99}]},"autoReverse":"yes"}');
  assert.ok(ok.ok); assert.equal(ok.mixtape.autoReverse, true); assert.equal(ok.mixtape.sides.A[0].dur, undefined);
  assert.equal(canAdd(m, 'A', null).ok, true);                         // a null track is an Untitled 4:00 ref, no throw
  assert.equal(removeFromSide(m, 'A', -1), m); assert.equal(removeFromSide(m, 'Z', 0), m);
});

test('resolveTracks still works on the flat list (A then B)', () => {
  let m = empty();
  m = addTrack(addTrack(m, tk('x', 10, { id: 'i-x' }), 'B'), tk('y', 10, { id: 'i-y' }), 'A');
  const lib = [{ id: 'i-x', title: 'x', artist: 'A', album: 'X' }, { id: 'i-y', title: 'y', artist: 'A', album: 'X' }];
  const r = resolveTracks(m, lib);
  assert.equal(r[0].id, 'i-y'); assert.equal(r[1].id, 'i-x');
});
