import test from 'node:test';
import assert from 'node:assert/strict';
import { createSleep, fadeGain, formatLeft, isSpec, SLEEP_MINUTES, FADE_SEC, END_MARGIN_SEC, IDLE_CLEAR_MS } from '../src/sleep.js';

function rig(over = {}) {
  const r = { t: 1_000_000, playing: true, trackRem: null, gains: [], expired: 0, cleared: [], ...over };
  r.s = createSleep({ now: () => r.t, isPlaying: () => r.playing, getTrackRemaining: () => r.trackRem, applyGain: (g) => r.gains.push(g), onExpire: () => { r.expired++; }, onClear: (w) => r.cleared.push(w) });
  return r;
}

test('options are 5/10/15/30/45/60 and end of track', () => {
  assert.deepEqual([...SLEEP_MINUTES], [5, 10, 15, 30, 45, 60]);
  assert.equal(isSpec('end'), true); assert.equal(isSpec(7), false); assert.equal(isSpec(null), false);
});

test('fadeGain: 1 until the last 10 s, then monotone down to 0', () => {
  assert.equal(fadeGain(60), 1); assert.equal(fadeGain(FADE_SEC), 1); assert.equal(fadeGain(0), 0); assert.equal(fadeGain(-3), 0);
  let prev = 1;
  for (let r = 9.9; r > 0; r -= 0.3) { const g = fadeGain(r); assert.ok(g < prev && g > 0, String(r)); prev = g; }
  assert.ok(fadeGain(5) > 0.3 && fadeGain(5) < 0.4);
});

test('formatLeft', () => { assert.equal(formatLeft(754.2), '12:35'); assert.equal(formatLeft(59.1), '1:00'); assert.equal(formatLeft(0), '0:00'); assert.equal(formatLeft(-4), '0:00'); });

test('timed: counts down, fades over the last 10 s, expires once, clears itself', () => {
  const r = rig();
  assert.equal(r.s.start(5), true);
  assert.deepEqual([r.s.state().mode, r.s.state().spec, Math.round(r.s.state().remainingSec)], ['timer', 5, 300]);
  r.t += 200_000; r.s.tick(); assert.equal(r.gains.length, 0);                    // 100 s left: no fade yet
  r.t += 95_000; r.s.tick(); assert.ok(r.gains.at(-1) < 1 && r.gains.at(-1) > 0.3);   // 5 s left
  assert.equal(r.s.state().fading, true);
  r.t += 4_000; r.s.tick(); assert.ok(r.gains.at(-1) < r.gains.at(-2) || r.gains.at(-1) < 0.2);
  assert.equal(r.expired, 0);
  r.t += 2_000; r.s.tick();
  assert.equal(r.expired, 1); assert.equal(r.s.active, false); assert.deepEqual(r.cleared, ['expired']);
  assert.equal(r.gains.at(-1), 0, 'the gain stays at 0 until the host has stopped playback and restores it');
  r.t += 60_000; r.s.tick(); assert.equal(r.expired, 1, 'never fires twice');
});

test('a slept-through gap (timer throttled with the screen off) still expires on the next tick', () => {
  const r = rig(); r.s.start(5);
  r.t += 20 * 60_000; r.s.tick();
  assert.equal(r.expired, 1);
});

test('end of track: follows the playing track, stops just before its end, even after a skip', () => {
  const r = rig({ trackRem: 200 });
  r.s.start('end');
  assert.equal(r.s.state().mode, 'end'); assert.equal(Math.round(r.s.state().remainingSec), 199);
  r.trackRem = 8; r.s.tick(); assert.ok(r.gains.at(-1) < 1);
  r.trackRem = 150; r.s.tick(); assert.equal(r.gains.at(-1), 1);              // the listener skipped to a longer track: back to full volume
  r.trackRem = END_MARGIN_SEC + 0.2; r.s.tick(); assert.equal(r.expired, 0);
  r.trackRem = END_MARGIN_SEC - 0.1; r.s.tick(); assert.equal(r.expired, 1);
});

test('end of track with nothing that has an end (radio) waits, silently', () => {
  const r = rig({ trackRem: null }); r.s.start('end');
  for (let i = 0; i < 5; i++) { r.t += 60_000; r.s.tick(); }
  assert.equal(r.expired, 0); assert.equal(r.s.active, true); assert.equal(r.s.state().remainingSec, null);
});

test('a manual stop clears the timer (after a quiet stretch, not on a momentary pause)', () => {
  const r = rig(); r.s.start(30);
  r.s.tick();                                           // playing: seen
  r.playing = false; r.t += 1000; r.s.tick(); assert.equal(r.s.active, true);   // a track change blip
  r.playing = true; r.t += 500; r.s.tick(); r.playing = false;
  r.t += 1000; r.s.tick(); r.t += IDLE_CLEAR_MS + 10; r.s.tick();
  assert.equal(r.s.active, false); assert.deepEqual(r.cleared, ['stopped']); assert.equal(r.expired, 0);
});

test('armed while nothing plays: waits for sound instead of clearing at once', () => {
  const r = rig({ playing: false }); r.s.start(10);
  r.t += 30_000; r.s.tick(); assert.equal(r.s.active, true);
  r.playing = true; r.t += 1000; r.s.tick(); assert.equal(r.s.active, true);
});

test('cancel and restart restore the volume and notify', () => {
  const r = rig(); const seen = []; r.s.subscribe((s) => seen.push(s.mode + ':' + s.spec));
  r.s.start(5); r.t += 295_000; r.s.tick(); assert.ok(r.gains.at(-1) < 1);
  r.s.start(15); assert.equal(r.gains.at(-1), 1); assert.equal(r.s.state().spec, 15);
  r.s.cancel(); assert.equal(r.s.active, false); assert.equal(r.s.state().mode, 'off');
  assert.equal(r.s.start(7), false);
  assert.ok(seen.includes('timer:5') && seen.includes('timer:15') && seen.includes('off:null'));
});
