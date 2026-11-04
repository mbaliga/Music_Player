import test from 'node:test';
import assert from 'node:assert/strict';
import { ShowClock, LEAD } from '../../src/radio/core/show-clock.js';
import { repairRundown } from '../../src/radio/core/director-client.js';
import {
  planTalkOverIntro, duckEnvelope, gainAt, crossfadePlan, equalPower, scheduleShow, findDeadAir,
  findSafePoint, insertAtSafePoint, deadAirLadder, SCHED,
} from '../../src/radio/core/scheduler.js';
import { validateSegment } from '../../src/radio/core/schemas.js';
import { snapshotFixture, goldenRundown, FIXTURE_NOW_MS } from '../../src/radio/core/fixtures.js';

const golden = () => repairRundown(goldenRundown(), { snapshot: snapshotFixture(), atMs: FIXTURE_NOW_MS }).rundown;
const dueSet = (c, t, stage) => c.due(t).filter((x) => x.stage === stage).map((x) => x.slotId);

// ── show clock ───────────────────────────────────────────────────────────────

test('timeline: slots lay out end to end; overlays take no time and sit on their song', () => {
  const c = new ShowClock().append(golden().slots);
  const at = (id) => [c.get(id).start, c.get(id).end];
  assert.deepEqual(at('g1'), [0, 6]);
  assert.deepEqual(at('g2'), [6, 193]);
  assert.deepEqual(at('g3'), [193, 193]);
  assert.deepEqual(at('g4'), [193, 391]);
  assert.equal(c.endSec, 852);
  assert.equal(c.at(100).slot.slotId, 'g2');
  assert.equal(c.at(852), null);
});

test('lead times: select 3 slots, script 2, tts 1 (and >= 90 s buffer), decode 45 s', () => {
  const c = new ShowClock().append(golden().slots);
  // g5 is the 4th timed slot: select starts when slot 1 (g1) begins, script when g2 begins, tts when g4 begins
  assert.deepEqual(dueSet(c, 0, 'select').sort(), ['g2', 'g4']);
  assert.ok(dueSet(c, 6, 'select').includes('g6'));
  assert.ok(!dueSet(c, 0, 'script').includes('g5'));
  assert.ok(dueSet(c, 6, 'script').includes('g5'));
  assert.ok(!dueSet(c, 192, 'tts').includes('g5'));
  assert.ok(dueSet(c, 193, 'tts').includes('g5'));
  const tts = c.due(1000).find((x) => x.slotId === 'g5' && x.stage === 'tts');
  assert.ok(tts.startAtSec <= c.get('g5').start - LEAD.ttsMinBufferSec);
  assert.equal(tts.blockedBy, 'script');
  assert.ok(!dueSet(c, 6 + 187 - 46, 'decode').includes('g4'));
  assert.ok(dueSet(c, 193 - 45, 'decode').includes('g4'));
  assert.ok(!c.due(1000).some((x) => x.slotId === 'g1' || (x.slotId === 'g2' && x.stage !== 'select' && x.stage !== 'decode'))); // IDs are pre-rendered
});

test('done stages disappear; overdue flags missed hard deadlines', () => {
  const c = new ShowClock().append(golden().slots);
  assert.equal(c.overdue(385).filter((x) => x.slotId === 'g5').length > 0, true);
  for (const s of ['select', 'script', 'tts', 'decode']) c.markDone('g5', s);
  assert.equal(c.overdue(385).filter((x) => x.slotId === 'g5').length, 0);
  assert.ok(!c.due(385).some((x) => x.slotId === 'g5'));
});

test('actual durations re-flow later slots; dropping a slot closes the gap', () => {
  const c = new ShowClock().append(golden().slots);
  c.begin('g1', 0); c.complete('g1', 6.4);
  c.begin('g2', 6.4); c.complete('g2', 200);
  assert.equal(c.get('g4').start, 200);
  assert.equal(c.get('g3').start, 200);
  assert.equal(c.drop('g5'), true);
  assert.equal(c.get('g6').start, 200 + 198);
  assert.equal(c.drop('g2'), false); // already aired
  assert.equal(c.endSec, 852 + (200 - 193) - 30);
});

test('horizon: ask the Director for more when fewer than 6 slots are ahead', () => {
  const c = new ShowClock().append(golden().slots);
  assert.deepEqual(c.horizon(), { ahead: 8, needMore: false, want: 0 });
  c.begin('g1', 0); c.complete('g1', 6);
  c.begin('g2', 6); c.complete('g2', 193);
  assert.deepEqual(c.horizon(), { ahead: 6, needMore: false, want: 0 });
  c.begin('g4', 193); c.complete('g4', 391);
  assert.deepEqual(c.horizon(), { ahead: 5, needMore: true, want: 3 });
});

test('live events: invalidate pending slots, insert a caller after a slot', () => {
  const c = new ShowClock().append(golden().slots);
  c.begin('g1', 0);
  const dropped = c.invalidateAfter('g2');
  assert.deepEqual(dropped.map((s) => s.slotId), ['g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9']);
  assert.equal(c.endSec, 6 + 187);
  assert.equal(c.insertAfter('g2', { slotId: 'call1', kind: 'caller_open', targetSec: 60 }), true);
  assert.equal(c.get('call1').start, 193);
  assert.equal(c.insertAfter('nope', { slotId: 'x', kind: 'song', targetSec: 1 }), false);
});

// ── scheduler ────────────────────────────────────────────────────────────────

test('talk over intro: voice ends hitMargin before the vocals', () => {
  const p = planTalkOverIntro({ songStartSec: 100, cues: { introEndSec: 14, confidence: 'high' }, utterances: [{ id: 'a', durationSec: 5 }, { id: 'b', durationSec: 3 }] });
  assert.equal(p.mode, 'over_intro');
  assert.ok(Math.abs(p.voiceStartSec - 105.6) < 1e-9);
  assert.ok(Math.abs(p.voiceStartSec + p.durationSec - (100 + 14 - SCHED.hitMarginSec)) < 1e-9);
});

test('talk over intro: trims droppable from the end, then pre-rolls, else falls back', () => {
  const cues = { introEndSec: 14, confidence: 'high' };
  const trimmed = planTalkOverIntro({ songStartSec: 0, cues, utterances: [{ id: 'a', durationSec: 8 }, { id: 'b', durationSec: 4, droppable: true }, { id: 'c', durationSec: 3, droppable: true }] });
  assert.equal(trimmed.mode, 'over_intro');
  assert.deepEqual(trimmed.droppedIds, ['c']);
  assert.deepEqual(trimmed.keptIds, ['a', 'b']);
  const pre = planTalkOverIntro({ songStartSec: 100, cues, prevOutroSec: 8, utterances: [{ id: 'a', durationSec: 18 }] });
  assert.equal(pre.mode, 'pre_roll');
  assert.ok(Math.abs(pre.voiceStartSec - (100 - 4.4)) < 1e-9);
  const tooLong = planTalkOverIntro({ songStartSec: 100, cues, prevOutroSec: 8, utterances: [{ id: 'a', durationSec: 20 }] });
  assert.equal(tooLong.mode, 'between_songs');
  for (const c of [{ introEndSec: 14, confidence: 'low' }, { introEndSec: null, confidence: 'high' }, { introEndSec: 2, confidence: 'high' }, undefined]) {
    assert.equal(planTalkOverIntro({ songStartSec: 0, cues: c, utterances: [{ id: 'a', durationSec: 3 }] }).mode, 'between_songs');
  }
});

test('ducking: lead before voice, release after, merged when ramps overlap', () => {
  const env = duckEnvelope([{ startSec: 10, endSec: 14 }]);
  assert.deepEqual(env.map((p) => p.t), [9.75, 10, 14, 14.4]);
  assert.equal(gainAt(env, 9), 1);
  assert.ok(Math.abs(20 * Math.log10(gainAt(env, 12)) - SCHED.duck.depthDb) < 1e-9);
  assert.ok(gainAt(env, 9.875) < 1 && gainAt(env, 9.875) > gainAt(env, 12));
  assert.equal(gainAt(env, 20), 1);
  assert.equal(duckEnvelope([{ startSec: 10, endSec: 12 }, { startSec: 12.3, endSec: 14 }]).length, 4);
  assert.equal(duckEnvelope([{ startSec: 10, endSec: 12 }, { startSec: 20, endSec: 21 }]).length, 8);
  assert.deepEqual(duckEnvelope([]), []);
});

test('crossfade: album is gapless, radio overlaps 2–4 s from the outro; equal power', () => {
  const out = { startSec: 0, durationSec: 200, cues: { outroStartSec: 190 } };
  assert.deepEqual(crossfadePlan(out, 'album'), { overlapSec: 0, incomingStartSec: 200 });
  assert.deepEqual(crossfadePlan(out, 'radio'), { overlapSec: 3, incomingStartSec: 197 });
  assert.equal(crossfadePlan(out, 'radio', { overlapSec: 9 }).overlapSec, 4);
  assert.equal(crossfadePlan({ ...out, cues: { outroStartSec: 198 } }, 'radio').overlapSec, 2);
  for (const p of [0, 0.25, 0.5, 1]) { const g = equalPower(p); assert.ok(Math.abs(g.out ** 2 + g.in ** 2 - 1) < 1e-12); }
});

const tr = (trackId, dur, introEnd = 12, conf = 'high') => ({ trackId, durationSec: dur, cues: { introEndSec: introEnd, outroStartSec: dur - 10, confidence: conf } });
const U = (id, d, droppable = false) => ({ id, durationSec: d, droppable });
function showItems(conf = 'high') {
  return [
    { slotId: 'g1', kind: 'station_id', stinger: { id: 'stinger.id.1', durationSec: 6 } },
    { slotId: 'g2', kind: 'song', track: tr('t1', 187) },
    { slotId: 'g3', kind: 'talk_over_intro', voice: { utterances: [U('a', 6), U('b', 3, true)] } },
    { slotId: 'g4', kind: 'song', track: tr('t2', 198, 12, conf) },
    { slotId: 'g5', kind: 'talk_break', voice: { utterances: [U('c', 12), U('d', 8), U('e', 5)] } },
    { slotId: 'g6', kind: 'song', track: tr('t3', 215) },
    { slotId: 'g9', kind: 'station_id', stinger: { id: 'stinger.id.2', durationSec: 5 } },
  ];
}

test('scheduleShow: valid segments, gapless in album and radio styles, voice rides the intro', () => {
  for (const style of ['album', 'radio']) {
    const r = scheduleShow(showItems(), { crossfade: style });
    for (const s of r.segments) assert.deepEqual(validateSegment(s), { ok: true, errors: [] }, JSON.stringify(s));
    assert.deepEqual(findDeadAir(r.segments, { fromSec: 0, toSec: r.endSec }), [], style);
    const song4 = r.segments.find((s) => s.slotId === 'g4');
    const v3 = r.segments.find((s) => s.slotId === 'g3');
    assert.equal(v3.mode, 'over_intro');
    assert.equal(v3.attachedTo, song4.segmentId);
    assert.ok(v3.startSec >= song4.startSec && v3.startSec + v3.durationSec <= song4.startSec + 12 - SCHED.hitMarginSec + 1e-9);
    assert.ok(v3.duck && v3.duck.depthDb === SCHED.duck.depthDb);
    assert.equal(r.segments.find((s) => s.slotId === 'g5').mode, 'between_songs');
  }
  const album = scheduleShow(showItems(), { crossfade: 'album' });
  assert.equal(album.segments.find((s) => s.slotId === 'g4').startSec, 193);
  const radio = scheduleShow(showItems(), { crossfade: 'radio' });
  assert.equal(radio.segments.find((s) => s.slotId === 'g4').startSec, 193 - 3);
  assert.equal(radio.segments.find((s) => s.slotId === 'g2').fadeInSec, undefined); // stinger -> song: no crossfade
});

test('scheduleShow: unusable intro puts the talk between songs; missing voice drops the slot quietly', () => {
  const r = scheduleShow(showItems('low'));
  const v = r.segments.find((s) => s.slotId === 'g3');
  assert.equal(v.mode, 'between_songs');
  assert.ok(v.startSec + v.durationSec <= r.segments.find((s) => s.slotId === 'g4').startSec + 1e-9);
  assert.deepEqual(findDeadAir(r.segments, { fromSec: 0, toSec: r.endSec }), []);
  const items = showItems(); delete items[2].voice; delete items[4].voice;
  const q = scheduleShow(items);
  assert.equal(q.segments.filter((s) => s.kind === 'voice').length, 0);
  assert.equal(q.notes.filter((n) => /no voice ready/.test(n.note)).length, 2);
  assert.deepEqual(findDeadAir(q.segments, { fromSec: 0, toSec: q.endSec }), []);
});

test('scheduleShow: trimmed utterances are reported', () => {
  const items = showItems();
  items[2].voice.utterances = [U('a', 8), U('b', 3, true), U('x', 3, true)];
  const r = scheduleShow(items);
  assert.ok(r.notes.some((n) => /trimmed x/.test(n.note)));
  assert.deepEqual(r.segments.find((s) => s.slotId === 'g3').utterances.map((u) => u.id), ['a', 'b']);
});

test('dead air detector: reports gaps over 250 ms, ignores shorter', () => {
  const seg = (s, d) => ({ startSec: s, durationSec: d });
  assert.deepEqual(findDeadAir([seg(0, 10), seg(10.2, 5)], { fromSec: 0, toSec: 15.2 }), []);
  const g = findDeadAir([seg(0, 10), seg(11, 5)], { fromSec: 0, toSec: 16 });
  assert.equal(g.length, 1);
  assert.equal(g[0].lengthSec, 1);
  assert.equal(findDeadAir([seg(0, 10)], { fromSec: 0, toSec: 12 }).length, 1);
  assert.equal(findDeadAir([], { fromSec: 0, toSec: 5 }).length, 1);
  assert.deepEqual(findDeadAir([seg(0, 5), seg(2, 10)], { fromSec: 0, toSec: 12 }), []); // overlap is coverage
});

test('safe points: song boundary, utterance end inside a break, never in the past', () => {
  const r = scheduleShow(showItems());
  const sp1 = findSafePoint(r.segments, 100);
  assert.equal(sp1.reason, 'song_boundary');
  assert.equal(sp1.atSec, 193);
  const brk = r.segments.find((s) => s.slotId === 'g5');
  const u0 = brk.utterances[0];
  const mid = findSafePoint(r.segments, u0.startSec + 1);
  assert.equal(mid.reason, 'utterance_end');
  assert.equal(mid.afterUtteranceId, 'c');
  assert.ok(Math.abs(mid.atSec - (u0.startSec + u0.durationSec)) < 1e-9);
  const late = findSafePoint(r.segments, 192.9); // too close: needs prep time
  assert.ok(late.atSec >= 192.9 + 0.5);
  assert.equal(findSafePoint(r.segments, 99999).reason, 'idle');
  for (let t = 0; t < r.endSec; t += 7.3) assert.ok(findSafePoint(r.segments, t).atSec >= t);
});

test('caller insertion: lands at a song boundary and pushes the rest out gaplessly', () => {
  for (const style of ['album', 'radio']) {
    const r = scheduleShow(showItems(), { crossfade: style });
    const out = insertAtSafePoint(r.segments, 100, { durationSec: 30, segmentId: 'call1' });
    assert.equal(out.safePoint.reason, 'song_boundary');
    const call = out.segments.find((s) => s.segmentId === 'call1');
    assert.equal(call.startSec, out.safePoint.atSec);
    assert.equal(call.source, 'caller');
    assert.equal(call.duck.depthDb, SCHED.callDuckDb);
    assert.deepEqual(validateSegment(call), { ok: true, errors: [] });
    const g4 = out.segments.find((s) => s.slotId === 'g4' && s.kind === 'song');
    assert.ok(g4.startSec >= call.startSec + call.durationSec - 1e-9, style);
    assert.deepEqual(findDeadAir(out.segments, { fromSec: 0, toSec: Math.max(...out.segments.map((s) => s.startSec + s.durationSec)) }), [], style);
    // the stream after the call is the same length as before, shifted by the call
    const before = r.segments.find((s) => s.slotId === 'g6').startSec;
    const after = out.segments.find((s) => s.slotId === 'g6').startSec;
    assert.ok(Math.abs(after - before - 30 - (style === 'radio' ? 3 : 0)) < 1e-9 || Math.abs(after - before - 30) < 1e-9);
    // overlay voice moved with its song
    const v3 = out.segments.find((s) => s.slotId === 'g3');
    assert.ok(v3.startSec >= call.startSec + call.durationSec - 1e-9);
  }
});

test('caller insertion inside a break splits it at the utterance boundary', () => {
  const r = scheduleShow(showItems());
  const brk = r.segments.find((s) => s.slotId === 'g5');
  const out = insertAtSafePoint(r.segments, brk.utterances[0].startSec + 1, { durationSec: 20, segmentId: 'c1', source: 'alert' });
  assert.equal(out.safePoint.reason, 'utterance_end');
  const head = out.segments.find((s) => s.segmentId === brk.segmentId);
  const tail = out.segments.find((s) => s.segmentId === `${brk.segmentId}:resume`);
  const call = out.segments.find((s) => s.segmentId === 'c1');
  assert.equal(call.source, 'alert');
  assert.deepEqual(head.utterances.map((u) => u.id), ['c']);
  assert.deepEqual(tail.utterances.map((u) => u.id), ['d', 'e']);
  assert.ok(tail.startSec >= call.startSec + call.durationSec - 1e-9);
  assert.ok(Math.abs(tail.utterances[0].startSec - (brk.utterances[1].startSec + 20)) < 1e-9);
  const g6 = out.segments.find((s) => s.slotId === 'g6');
  assert.ok(Math.abs(g6.startSec - (r.segments.find((s) => s.slotId === 'g6').startSec + 20)) < 1e-9);
  const end = Math.max(...out.segments.map((s) => s.startSec + s.durationSec));
  assert.deepEqual(findDeadAir(out.segments, { fromSec: 0, toSec: end }), []);
  for (const s of out.segments) assert.equal(validateSegment(s).ok, true, JSON.stringify(s));
});

test('dead-air ladder: drop talk at T-8, filler when no song, any decoded track, offline badge', () => {
  assert.deepEqual(deadAirLadder({}), { rung: 1, action: 'normal' });
  assert.equal(deadAirLadder({ talkReady: false, secondsToSlot: 20 }).action, 'normal');
  assert.equal(deadAirLadder({ talkReady: false, secondsToSlot: 8 }).action, 'drop_talk');
  assert.deepEqual(deadAirLadder({ nextSongReady: false, anyDecodedTrack: false }), { rung: 3, action: 'local_filler' });
  assert.deepEqual(deadAirLadder({ nextSongReady: false }), { rung: 4, action: 'any_decoded_track' });
  assert.deepEqual(deadAirLadder({ online: false }), { rung: 5, action: 'normal', badge: 'offline_music_only' });
  assert.equal(deadAirLadder({ online: false, nextSongReady: false }).badge, 'offline_music_only');
});
