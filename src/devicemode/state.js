// state.js — the Device mode state machine. PURE: no DOM, no timers; the caller feeds events and calls tick(). Never throws:
// any internal error drops to UNLOCKED (the safety rule), which is also what a fresh launch is unless the user asked otherwise.
//
// State { locked, wake, aod, notice }
//   locked  the user's switch (lock key). The UI freezes everything that is not an allowed button.
//   wake    the keep-awake hold is requested (the screen must stay on). True while locked, until the inactivity timeout.
//   aod     the always-on-display rendering is active (locked + wake + idle long enough).
//   notice  'timeout' after the hold was released and the user touched the device again (UI shows a small note), else null.
//
// Rules (docs/DEVICE_MODE.md):
//   lock()      -> locked, wake, not aod, clocks reset.
//   unlock()    -> everything off.
//   activity(k) -> k = 'touch' | 'button' | 'key'. Only while locked. Resets the AOD idle clock and the keep-awake clock, EXCEPT while AOD
//                  shows: a stray 'touch' does nothing there; a 'button' (the AOD buttons work directly) resets the keep-awake clock but
//                  leaves AOD up. Activity after a timeout re-takes the hold and sets notice='timeout'.
//   wakeGesture(kind) 'double' | 'long' | 'lockkey': leaves AOD only if kind equals the setting (aodWake). Never unlocks.
//   visibility(v) v=false: nothing (the OS owns the screen). v=true after being hidden: a deliberate return = activity AND leaves AOD.
//   playing(b)  while playing and neverTimeoutPlaying, the keep-awake clock does not run (it restarts when playback stops).
//   tick(now)   moves to AOD after aodIdleSec of inactivity; releases the hold after keepAwakeMin of inactivity.
//   settings changed -> call refresh().
import { DEFAULTS } from './settings.js';

const SEC = 1000, MIN = 60 * 1000;

/** @param {{now?:()=>number, settings?:()=>object, onChange?:(s:object, prev:object)=>void}} env */
export function createMachine(env = {}) {
  const clock = env.now || (() => Date.now());
  const getSettings = () => { try { return { ...DEFAULTS, ...((env.settings && env.settings()) || {}) }; } catch { return { ...DEFAULTS }; } };
  let s = { locked: false, wake: false, aod: false, notice: null };
  let lastActivity = 0, holdBase = 0, isPlaying = false, hidden = false, timedOut = false;
  const subs = new Set();

  const snap = () => ({ ...s });
  function commit(next) {
    const prev = s;
    if (prev.locked === next.locked && prev.wake === next.wake && prev.aod === next.aod && prev.notice === next.notice) return false;
    s = next;
    const cur = snap();
    for (const f of [env.onChange, ...subs]) { if (f) { try { f(cur, prev); } catch { /* a bad listener must not break the machine */ } } }
    return true;
  }
  const safe = (fn) => { try { return fn(); } catch { try { hardUnlock(); } catch { /* */ } return snap(); } };
  function hardUnlock() { timedOut = false; hidden = false; s = { locked: false, wake: false, aod: false, notice: null }; }

  function aodOn(set) { return !!(set.aodEnabled && set.aodIdleSec > 0); }
  const timeoutMs = (set) => (set.keepAwakeMin > 0 ? set.keepAwakeMin * MIN : Infinity);

  const api = {
    get state() { return snap(); },
    subscribe(f) { subs.add(f); return () => subs.delete(f); },

    lock() { return safe(() => { const t = clock(); lastActivity = t; holdBase = t; timedOut = false; commit({ locked: true, wake: true, aod: false, notice: null }); return snap(); }); },
    unlock() { return safe(() => { timedOut = false; commit({ locked: false, wake: false, aod: false, notice: null }); return snap(); }); },
    toggle() { return s.locked ? api.unlock() : api.lock(); },
    /** Fail-safe entry point for the UI: anything went wrong -> unlocked. */
    fail() { try { const was = snap(); hardUnlock(); const cur = snap(); if (was.locked || was.wake || was.aod) for (const f of [env.onChange, ...subs]) { if (f) { try { f(cur, was); } catch { /* */ } } } } catch { /* */ } return snap(); },

    activity(kind = 'touch') {
      return safe(() => {
        if (!s.locked) return snap();
        const t = clock();
        if (s.aod) {                              // AOD: only a button press counts; it keeps the screen on but does not leave AOD
          if (kind === 'button' || kind === 'key') { holdBase = t; }
          return snap();
        }
        lastActivity = t; holdBase = t;
        if (timedOut) { timedOut = false; commit({ ...s, wake: true, notice: 'timeout' }); }
        return snap();
      });
    },
    dismissNotice() { return safe(() => { commit({ ...s, notice: null }); return snap(); }); },

    wakeGesture(kind) {
      return safe(() => {
        if (!s.locked || !s.aod) return snap();
        if (kind !== getSettings().aodWake) return snap();
        const t = clock(); lastActivity = t; holdBase = t;
        commit({ ...s, aod: false });
        return snap();
      });
    },
    visibility(visible) {
      return safe(() => {
        if (!visible) { hidden = true; return snap(); }
        const was = hidden; hidden = false;
        if (!s.locked || !was) return snap();
        const t = clock(); lastActivity = t; holdBase = t;
        if (timedOut) { timedOut = false; commit({ ...s, wake: true, aod: false, notice: 'timeout' }); }
        else commit({ ...s, aod: false });
        return snap();
      });
    },
    playing(b) {
      return safe(() => { b = !!b; if (b === isPlaying) return snap(); if (!b) holdBase = Math.max(holdBase, clock()); isPlaying = b; return snap(); });
    },

    tick(now) {
      return safe(() => {
        if (!s.locked) return snap();
        const t = Number.isFinite(now) ? now : clock(), set = getSettings();
        if (s.wake) {
          if (set.neverTimeoutPlaying && isPlaying) holdBase = Math.max(holdBase, t);
          else if (t - holdBase >= timeoutMs(set)) { timedOut = true; commit({ ...s, wake: false, aod: false }); return snap(); }
        }
        if (s.wake && !s.aod && aodOn(set) && t - lastActivity >= set.aodIdleSec * SEC) commit({ ...s, aod: true });
        return snap();
      });
    },
    /** Setting changed: re-evaluate (e.g. AOD turned off while showing). */
    refresh() {
      return safe(() => { if (s.aod && !aodOn(getSettings())) commit({ ...s, aod: false }); return snap(); });
    },
    /** ms until something may change (for a precise timer), or null if nothing is pending. */
    nextDueMs(now) {
      try {
        if (!s.locked) return null;
        const t = Number.isFinite(now) ? now : clock(), set = getSettings();
        let due = Infinity;
        if (s.wake) {
          if (set.neverTimeoutPlaying && isPlaying) due = Math.min(due, 30 * SEC);          // re-check now and then; the clock is parked
          else if (timeoutMs(set) < Infinity) due = Math.min(due, holdBase + timeoutMs(set) - t);
          if (!s.aod && aodOn(set)) due = Math.min(due, lastActivity + set.aodIdleSec * SEC - t);
        }
        return due === Infinity ? null : Math.max(250, due);
      } catch { return null; }
    },

    // ── persistence across restarts (the caller stores/loads the snapshot) ──
    snapshot() { return { locked: s.locked }; },
    /** Honour a stored snapshot only when persistLock is on; otherwise a fresh launch is UNLOCKED. */
    restore(saved) {
      return safe(() => { if (getSettings().persistLock && saved && saved.locked === true) api.lock(); else api.unlock(); return snap(); });
    },
  };
  return api;
}
