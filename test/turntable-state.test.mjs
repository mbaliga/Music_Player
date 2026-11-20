import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer, reduce, playheadS, needsFrame, FINISHED, DEPLOY_S } from '../src/turntable/state.js';
import { easeZ } from '../src/turntable/camera.js';
import { buildArmLayout, locateS, seekTargetS, sFor, classifyArmFlick, estimateDurations, ARM_KNOBS, gapCentreS, radiusFor, seekTarget, buildLayout, TONEARM_KNOBS } from '../src/tonearm.js';

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} !~ ${b}`);
const run = (st, a) => reduce(st, a);
/** advance the clock n seconds at 60 fps; collect effects; acts on beginAudio like the glue does */
function advance(st, sec, o = {}) {
  const fx = [];
  for (let i = 0; i < Math.round(sec * 60); i++) {
    const r = reduce(st, { type: 'tick', dt: 1 / 60, posS: o.posS ?? st.armS, easeZ, z: st.z });
    st = r.state; fx.push(...r.effects);
    if (r.effects.includes('beginAudio')) { st = reduce(st, { type: 'audioBegan' }).state; }
  }
  return { st, fx };
}

test('idle: nothing moves, the loop would not run', () => {
  const st = createPlayer();
  assert.equal(needsFrame(st), false);
  assert.equal(needsFrame(advance(st, 1).st), false);
});

test('Play lowers the arm (dep 0 -> 1 in ~1.1 s) and audio begins when it is down', () => {
  let st = run(createPlayer(), { type: 'toggle' }).state;
  assert.equal(st.starting, true); assert.equal(st.playing, false);
  let r = advance(st, DEPLOY_S - 0.2);
  assert.equal(r.fx.includes('beginAudio'), false); assert.ok(r.st.dep < 1 && r.st.dep > 0.7);
  r = advance(r.st, 0.4, { posS: 0 });
  assert.equal(r.st.playing, true); assert.equal(r.st.starting, false); assert.equal(r.st.dep, 1);
  assert.equal(needsFrame(r.st), true);
});

test('Stop freezes the playhead, the arm slides back to 0 THEN folds into the slot; the disc state is untouched', () => {
  let st = createPlayer();
  st = run(st, { type: 'toggle' }).state; st = advance(st, 1.5, { posS: 0 }).st;
  st = advance(st, 0.1, { posS: 0.4 }).st;
  assert.equal(st.playing, true); near(st.armS, 0.4);
  const r = run(st, { type: 'toggle', s: 0.4 });
  assert.deepEqual([...r.effects], ['silence']);
  st = r.state;
  assert.equal(st.playing, false); assert.equal(st.starting, false); near(st.frozenS, 0.4);
  assert.equal(playheadS(st, 0.9), 0.4, 'disc + waveform + dots frozen at the stop position, whatever the audio clock says');
  // the arm retracts along the rail first: armS falls while dep stays 1 ...
  let steps = 0, sawSlide = false, sawFold = false;
  while ((st.armS > 0 || st.dep > 0) && steps++ < 60 * 10) {
    st = reduce(st, { type: 'tick', dt: 1 / 60, posS: 0.4, easeZ }).state;
    if (st.armS > 0 && st.dep === 1) sawSlide = true;
    if (st.armS === 0 && st.dep < 1 && st.dep > 0) sawFold = true;
    assert.ok(!(st.armS > 0 && st.dep < 1), 'never folds before it has slid home');
    near(st.frozenS, 0.4, 1e-12);
  }
  assert.ok(sawSlide && sawFold); assert.equal(st.dep, 0); assert.equal(st.armS, 0);
  assert.equal(needsFrame(st), false, 'idle again: the rAF loop stops');
});

test('Play resumes where it stopped, even if pressed while the arm is still retracting', () => {
  let st = createPlayer();
  st = run(st, { type: 'toggle' }).state; st = advance(st, 1.5).st; st = advance(st, 0.05, { posS: 0.62 }).st;
  st = run(st, { type: 'toggle', s: 0.62 }).state;
  st = advance(st, 0.3, { posS: 0.62 }).st;      // mid-retract
  assert.ok(st.armS > 0 && st.armS < 0.62);
  const r = run(st, { type: 'toggle' });
  assert.equal(r.state.starting, true); near(r.state.pendStart, 0.62);
});

test('a finished record restarts from 0 on Play', () => {
  let st = createPlayer();
  st = run(st, { type: 'toggle' }).state; st = advance(st, 1.5).st;
  st = run(st, { type: 'finished' }).state;
  assert.equal(st.playing, false); assert.equal(st.frozenS, 1);
  st = advance(st, 3).st;                         // retract
  assert.ok(st.frozenS > FINISHED);
  const r = run(st, { type: 'toggle' });
  assert.equal(r.state.pendStart, 0);
  assert.equal(r.state.starting, true);
});

test('Stop while still starting keeps the arm target as the stop position', () => {
  let st = run(createPlayer(), { type: 'play', s: 0.25 }).state;
  st = advance(st, 0.3).st;
  st = run(st, { type: 'toggle' }).state;
  assert.equal(st.starting, false); near(st.frozenS, 0.25);
});

test('the arm only lowers while the player is in view (z < .3); a library pick waits for the zoom-in', () => {
  let st = run({ ...createPlayer(), z: 1, zT: 1 }, { type: 'play', s: 0.1 }).state;
  st = advance(st, 2).st;
  assert.equal(st.dep, 0); assert.equal(st.starting, true);
  st = run(st, { type: 'zoomTo', z: 0 }).state;
  const r = advance(st, 3); assert.equal(r.st.playing, true); assert.equal(r.st.z, 0);
});

test('dragging the dimple: only with the arm down; lifts (silence), follows the pointer, resumes on release', () => {
  let st = createPlayer();
  assert.equal(run(st, { type: 'dragStart', s: 0 }).state.dragging, false, 'parked arm cannot be grabbed');
  st = run(st, { type: 'toggle' }).state; st = advance(st, 1.5).st; st = advance(st, 0.05, { posS: 0.2 }).st;
  let r = run(st, { type: 'dragStart', s: 0.2 });
  assert.deepEqual([...r.effects], ['silence']); st = r.state;
  assert.equal(st.dragging, true); assert.equal(st.playing, false); assert.equal(st.wasPlaying, true);
  st = run(st, { type: 'dragMove', s: 0.7 }).state; near(st.armS, 0.7); near(playheadS(st, 0), 0.7);
  assert.equal(advance(st, 1, { posS: 0 }).st.armS, 0.7, 'the arm stays under the finger');
  st = run(st, { type: 'dragEnd', s: 0.7 }).state;
  assert.equal(st.starting, true); near(st.pendStart, 0.7);
  st = advance(st, 0.1, { posS: 0.7 }).st; assert.equal(st.playing, true);
  // a drag that ends at the very start of a stopped record just drops idle
  let st2 = advance(run(createPlayer(), { type: 'toggle' }).state, 1.5).st;
  st2 = run(run(st2, { type: 'toggle', s: 0.0 }).state, { type: 'stop', s: 0 }).state;
});

test('zoom: pinch drives z directly, release snaps by hysteresis, taps ease; focus eases and reports when settled', () => {
  let st = run(createPlayer(), { type: 'pinchStart' }).state;
  st = run(st, { type: 'pinchMove', z: 0.4 }).state; assert.equal(st.z, 0.4); assert.equal(st.zGest, true);
  st = reduce(st, { type: 'tick', dt: 0.1, posS: 0, easeZ }).state; assert.equal(st.z, 0.4, 'gesture owns z');
  st = run(st, { type: 'pinchEnd', settle: 1 }).state; assert.equal(st.zT, 1);
  for (let i = 0; i < 200 && st.z !== 1; i++) st = reduce(st, { type: 'tick', dt: 1 / 60, posS: 0, easeZ }).state;
  assert.equal(st.z, 1);
  st = run(st, { type: 'focusTo', index: 3 }).state;
  let settled = false, n = 0;
  while (!settled && n++ < 600) { const r = reduce(st, { type: 'tick', dt: 1 / 60, posS: 0, easeZ }); st = r.state; settled = r.effects.includes('focusSettled'); }
  assert.ok(settled); assert.equal(st.focus, 3);
  assert.equal(needsFrame({ ...createPlayer(), z: 0.5, zT: 1 }), true);
});

// ── tonearm on the chord ───────────────────────────────────────────────────────
test('album layout on the unit chord: s maps to band / gap / time exactly like the old radius mapping', () => {
  const durs = [100, 200, 100], L = buildArmLayout(durs);
  const old = buildLayout(durs, 1, 0);
  // single band at the start: s = 0 is track 0 time 0; the last band's end is s = 1
  assert.deepEqual(seekTargetS(L, 0), { index: 0, time: 0, zone: 'start' });
  const end = seekTargetS(L, 1); assert.equal(end.index, 2); near(end.time, 100);
  // s inside track 1 (200 s): in the middle of its band
  const b1 = L.bands[1]; const sMid = (b1.uA + b1.uB) / 2;
  const t = seekTargetS(L, sMid); assert.equal(t.index, 1); near(t.time, 100, 1e-6); assert.equal(t.zone, 'track');
  // inverse
  near(sFor(L, 1, 100), sMid, 1e-9); near(sFor(L, 0, 0), 0, 1e-9);
  for (const [i, tt] of [[0, 30], [1, 150], [2, 99]]) { const r = seekTargetS(L, sFor(L, i, tt)); assert.equal(r.index, i); near(r.time, tt, 1e-6); }
  // identical to the old API at the same radius
  assert.deepEqual(seekTargetS(L, 0.4), seekTarget(old, 1 - 0.4, { ...TONEARM_KNOBS, gapGrabPx: ARM_KNOBS.gapGrab }));
  // proportional widths (gaps taken out)
  const w = L.bands.map((b) => b.uB - b.uA); near(w[1] / w[0], 2, 1e-9);
  assert.ok(Math.abs(radiusFor(L, 0, 0) - 1) < 1e-12);
});

test('dropping in a gap = the next track at 0:00; the gap is hit over a finger-fat zone', () => {
  const L = buildArmLayout([100, 100, 100]);
  const g = L.gaps[0], sg = gapCentreS(g);
  const r = seekTargetS(L, sg); assert.deepEqual({ ...r }, { index: 1, time: 0, zone: 'gap' });
  assert.equal(locateS(L, sg).zone, 'gap');
  assert.equal(locateS(L, sg + ARM_KNOBS.gapGrab * 0.45).zone, 'gap');
  assert.equal(locateS(L, sg + 0.1).zone, 'track');
  assert.equal(locateS(L, sg + 0.1).index, 1);
  // near a band's start edge snaps to 0:00
  const b1 = L.bands[1]; assert.equal(seekTargetS(L, b1.uA + 0.0112).zone, 'start');
  // one track: no gaps, reduces to the single-track record
  const one = buildArmLayout([180]); assert.equal(one.gaps.length, 0); near(seekTargetS(one, 0.5).time, 90, 1e-6);
  // unknown durations estimate as the mean
  assert.deepEqual(estimateDurations([100, null, 300]), [100, 200, 300]);
});

test('arm flick: a quick short sweep along the rail = next (toward the inner groove) / prev; slow or long drags are seeks', () => {
  const mk = (x0, x1, ms, n = 8, dy = 6) => Array.from({ length: n }, (_, i) => ({ x: x0 + (x1 - x0) * i / (n - 1), y: 80 + (i % 2) * dy, t: 1000 + ms * i / (n - 1) }));
  assert.equal(classifyArmFlick(mk(700, 560, 150)).dir, 'next');      // moving left = toward the centre of the disc
  assert.equal(classifyArmFlick(mk(560, 700, 150)).dir, 'prev');
  assert.equal(classifyArmFlick(mk(700, 560, 900)).dir, null, 'too slow');
  assert.equal(classifyArmFlick(mk(700, 680, 100)).dir, null, 'too short');
  assert.equal(classifyArmFlick(mk(1200, 500, 260)).dir, null, 'a long fast drag is a seek, not a flick');
  assert.equal(classifyArmFlick(mk(700, 560, 150, 8, 200)).dir, null, 'diagonal sweep');
  assert.equal(classifyArmFlick([]).dir, null); assert.equal(classifyArmFlick([{ x: 1, y: 1, t: 1 }]).dir, null);
});
