import test from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from '../src/devicemode/state.js';
import { DEFAULTS } from '../src/devicemode/settings.js';

const MIN = 60000, SEC = 1000;
function rig(over = {}) {
  let t = 1_000_000; const set = { ...DEFAULTS, ...over };
  const m = createMachine({ now: () => t, settings: () => set });
  return { m, set, adv(ms) { t += ms; return m.tick(t); }, get t() { return t; } };
}

test('lock engages keep-awake, unlock releases everything', () => {
  const r = rig(); assert.deepEqual(r.m.state, { locked: false, wake: false, aod: false, notice: null });
  r.m.lock(); assert.deepEqual(r.m.state, { locked: true, wake: true, aod: false, notice: null });
  r.m.unlock(); assert.deepEqual(r.m.state, { locked: false, wake: false, aod: false, notice: null });
  r.m.toggle(); assert.equal(r.m.state.locked, true); r.m.toggle(); assert.equal(r.m.state.locked, false);
});

test('keep-awake timeout: releases the hold after N min idle, keeps the lock, activity re-arms with a notice', () => {
  const r = rig({ aodEnabled: false, neverTimeoutPlaying: false }); r.m.lock();
  r.adv(29 * MIN); assert.equal(r.m.state.wake, true);
  r.adv(1 * MIN); assert.equal(r.m.state.wake, false); assert.equal(r.m.state.locked, true);
  r.m.activity('touch'); assert.equal(r.m.state.wake, true); assert.equal(r.m.state.notice, 'timeout');
  r.m.dismissNotice(); assert.equal(r.m.state.notice, null);
  r.adv(29 * MIN); assert.equal(r.m.state.wake, true);   // re-armed from the activity
});

test('activity resets the timeout clock', () => {
  const r = rig({ aodEnabled: false, neverTimeoutPlaying: false }); r.m.lock();
  r.adv(20 * MIN); r.m.activity('button'); r.adv(20 * MIN); assert.equal(r.m.state.wake, true);
  r.adv(10 * MIN); assert.equal(r.m.state.wake, false);
});

test('Never: no timeout', () => {
  const r = rig({ keepAwakeMin: 0, aodEnabled: false }); r.m.lock(); r.adv(24 * 60 * MIN); assert.equal(r.m.state.wake, true);
});

test('playing prevents the timeout; it restarts when playback stops', () => {
  const r = rig({ aodEnabled: false }); r.m.lock(); r.m.playing(true);
  for (let i = 0; i < 10; i++) r.adv(10 * MIN);      // 100 min playing
  assert.equal(r.m.state.wake, true);
  r.m.playing(false); r.adv(29 * MIN); assert.equal(r.m.state.wake, true);
  r.adv(2 * MIN); assert.equal(r.m.state.wake, false);
});

test('playing does not prevent the timeout when the setting is off', () => {
  const r = rig({ aodEnabled: false, neverTimeoutPlaying: false }); r.m.lock(); r.m.playing(true); r.adv(31 * MIN); assert.equal(r.m.state.wake, false);
});

test('AOD enters after the idle delay, only while locked and awake', () => {
  const r = rig(); r.adv(5 * MIN); assert.equal(r.m.state.aod, false);       // unlocked: never
  r.m.lock(); r.adv(59 * SEC); assert.equal(r.m.state.aod, false); r.adv(1 * SEC); assert.equal(r.m.state.aod, true);
});

test('AOD off setting / delay 0: never enters; turning it off while showing leaves it', () => {
  let r = rig({ aodEnabled: false }); r.m.lock(); r.adv(10 * MIN); assert.equal(r.m.state.aod, false);
  r = rig({ aodIdleSec: 0 }); r.m.lock(); r.adv(10 * MIN); assert.equal(r.m.state.aod, false);
  r = rig(); r.m.lock(); r.adv(61 * SEC); assert.equal(r.m.state.aod, true); r.set.aodEnabled = false; r.m.refresh(); assert.equal(r.m.state.aod, false);
});

test('AOD: a stray touch does not wake; a button does not leave AOD; the configured wake gesture does', () => {
  const r = rig(); r.m.lock(); r.adv(61 * SEC);
  r.m.activity('touch'); assert.equal(r.m.state.aod, true);
  r.m.activity('button'); assert.equal(r.m.state.aod, true);
  r.m.wakeGesture('long'); assert.equal(r.m.state.aod, true);                // default is double
  r.m.wakeGesture('lockkey'); assert.equal(r.m.state.aod, true);
  r.m.wakeGesture('double'); assert.equal(r.m.state.aod, false); assert.equal(r.m.state.locked, true);
  r.adv(30 * SEC); assert.equal(r.m.state.aod, false);                       // the idle clock restarted at the wake
  r.adv(31 * SEC); assert.equal(r.m.state.aod, true);
});

test('wake gesture follows the setting (long, lockkey)', () => {
  for (const g of ['long', 'lockkey']) { const r = rig({ aodWake: g }); r.m.lock(); r.adv(61 * SEC); r.m.wakeGesture('double'); assert.equal(r.m.state.aod, true); r.m.wakeGesture(g); assert.equal(r.m.state.aod, false); }
});

test('AOD button presses keep the hold alive; unlock leaves AOD', () => {
  const r = rig({ neverTimeoutPlaying: false, keepAwakeMin: 5 }); r.m.lock(); r.adv(61 * SEC); assert.equal(r.m.state.aod, true);
  r.adv(3 * MIN); r.m.activity('button'); r.adv(3 * MIN); assert.equal(r.m.state.wake, true);
  r.adv(3 * MIN); assert.equal(r.m.state.wake, false); assert.equal(r.m.state.aod, false);
  const q = rig(); q.m.lock(); q.adv(61 * SEC); q.m.unlock(); assert.deepEqual(q.m.state, { locked: false, wake: false, aod: false, notice: null });
});

test('returning to the app (visible after hidden) is a deliberate wake: leaves AOD, re-arms', () => {
  const r = rig({ aodEnabled: true }); r.m.lock(); r.adv(61 * SEC); assert.equal(r.m.state.aod, true);
  r.m.visibility(false); r.adv(10 * SEC); r.m.visibility(true); assert.equal(r.m.state.aod, false);
  const q = rig({ aodEnabled: false, neverTimeoutPlaying: false }); q.m.lock(); q.m.visibility(false); q.adv(40 * MIN); q.m.visibility(true);
  assert.equal(q.m.state.wake, true); assert.equal(q.m.state.notice, 'timeout');   // the tick had not run while hidden: still handled
});

test('restart: a fresh launch is unlocked unless persistLock; restore honours the snapshot', () => {
  let r = rig(); r.m.lock(); const snap = r.m.snapshot(); const fresh = rig(); fresh.m.restore(snap); assert.equal(fresh.m.state.locked, false);
  r = rig({ persistLock: true }); r.m.restore(snap); assert.equal(r.m.state.locked, true); assert.equal(r.m.state.wake, true);
  r.m.restore(null); assert.equal(r.m.state.locked, false);
  r.m.restore({ locked: 'yes' }); assert.equal(r.m.state.locked, false);
});

test('errors drop to unlocked; a throwing listener or settings getter never throws out', () => {
  let t = 0; let boom = false;
  const m = createMachine({ now: () => t, settings: () => { if (boom) throw new Error('x'); return DEFAULTS; }, onChange: () => { if (boom) throw new Error('y'); } });
  m.lock(); assert.equal(m.state.locked, true);
  boom = true; t += 1000; assert.doesNotThrow(() => m.tick(t)); assert.doesNotThrow(() => m.wakeGesture('double'));
  m.fail(); assert.equal(m.state.locked, false);
  const m2 = createMachine({ now: () => { throw new Error('clock'); } });
  assert.doesNotThrow(() => m2.lock()); assert.equal(m2.state.locked, false);
});

test('nextDueMs points at the nearest transition', () => {
  const r = rig({ neverTimeoutPlaying: false }); assert.equal(r.m.nextDueMs(r.t), null);
  r.m.lock(); assert.equal(r.m.nextDueMs(r.t), 60 * SEC);
  r.adv(61 * SEC); assert.equal(r.m.nextDueMs(r.t), 30 * MIN - 61 * SEC);
  const z = rig({ keepAwakeMin: 0, aodIdleSec: 0 }); z.m.lock(); assert.equal(z.m.nextDueMs(z.t), null);
});

test('subscribers get (state, prev) once per real change', () => {
  const r = rig(); const seen = []; r.m.subscribe((s, p) => seen.push([s.locked, p.locked]));
  r.m.lock(); r.m.lock(); r.m.unlock(); assert.deepEqual(seen, [[true, false], [false, true]]);
});
