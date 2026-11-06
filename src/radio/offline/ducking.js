// ─────────────────────────────────────────────────────────────────────────────
// ducking.js — music-bus gain automation around LIVE speech.
//
// The cloud design (architecture 4.3) ducks with an envelope the scheduler computes against a MIXED buffer:
// voice and music share one timeline, so the envelope is just breakpoints (core scheduler.duckEnvelope).
// System speech cannot be rendered to a buffer or routed into Web Audio, so here the voice is a black box that
// starts and ends when the OS says so. The adapter therefore converts "voice window" into gain automation
// on the music bus that is DRIVEN BY EVENTS:
//     speak() called   -> hold   (ramp down over attackSec, pre-empting the engine's start latency)
//     onend / error / watchdog / cancel / stop -> release (ramp up over releaseSec)
// Holds are counted per owner, so overlapping or restarted speech never un-ducks early, and releaseAll() is the
// one call every exit path (stop, background, error) makes. Ramps start from the CURRENT value (tracked from the
// ramp we scheduled, so we never need to read the param) and are linear and monotone, so no click and no
// overshoot, even when a duck is interrupted mid-release.
//
// Where the show clock knows the voice window in advance (a talk-over scheduled at a song offset),
// applyEnvelope() converts a core duckEnvelope() into the same kind of automation on any AudioParam.
// ─────────────────────────────────────────────────────────────────────────────

export const DUCK = Object.freeze({ depthDb: -14, attackSec: 0.22, releaseSec: 0.45 });
export const dbToGain = (db) => 10 ** (db / 20);

export function createDuckController({ param, now, depthDb = DUCK.depthDb, attackSec = DUCK.attackSec, releaseSec = DUCK.releaseSec } = {}) {
  const target = dbToGain(depthDb);
  const holds = new Set();
  let seg = { t0: 0, t1: 0, g0: 1, g1: 1 };
  let nextId = 0;

  const valueAt = (t) => {
    if (t >= seg.t1 || seg.t1 <= seg.t0) return seg.g1;
    if (t <= seg.t0) return seg.g0;
    return seg.g0 + (seg.g1 - seg.g0) * ((t - seg.t0) / (seg.t1 - seg.t0));
  };

  function ramp(to, dur) {
    let t;
    try { t = now(); } catch { return; }
    if (seg.g1 === to) return; // already heading there
    const cur = valueAt(t);
    // fraction of the full excursion still to travel, so an interrupted ramp keeps the same slope
    const span = Math.abs(1 - target) || 1;
    const d = Math.max(0.02, dur * Math.min(1, Math.abs(to - cur) / span));
    try {
      // cancelAndHoldAtTime freezes an in-flight ramp at its current value (Chromium); elsewhere cancel + pin the value
      // we computed ourselves. Either way the new ramp starts from where the gain is NOW.
      if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(t);
      else { param.cancelScheduledValues(t); param.setValueAtTime(cur, t); }
      param.linearRampToValueAtTime(to, t + d);
    } catch { /* a dead context must not break the show */ }
    seg = { t0: t, t1: t + d, g0: cur, g1: to };
  }

  return {
    /** Start ducking for `owner` (a string/anything). Returns the hold id. */
    hold(owner = `h${nextId++}`) {
      const was = holds.size;
      holds.add(owner);
      if (!was) ramp(target, attackSec);
      return owner;
    },
    release(owner) {
      if (!holds.delete(owner)) return;
      if (!holds.size) ramp(1, releaseSec);
    },
    /** Every exit path: restore the music no matter how many holds are open. */
    releaseAll() { if (holds.size) { holds.clear(); ramp(1, releaseSec); } },
    /** Immediate, click-safe restore (used on stop: a short 20 ms ramp from the current value). */
    restoreNow() { holds.clear(); ramp(1, 0.02); },
    get ducked() { return holds.size > 0; },
    get holdCount() { return holds.size; },
    gainNow() { try { return valueAt(now()); } catch { return 1; } },
    /** the value the controller believes the param has at ctx time t (for tests and diagnostics) */
    gainAt: valueAt,
    targetGain: target,
  };
}

/**
 * Apply a core duckEnvelope() ([{t, gain}], seconds relative to baseTime) to an AudioParam.
 * Starts from the param's value at the first breakpoint so there is no jump. Returns the number of events scheduled.
 */
export function applyEnvelope(param, env, baseTime = 0, startGain = 1) {
  if (!env || !env.length) return 0;
  let n = 0;
  param.setValueAtTime(startGain, baseTime + env[0].t); n++;
  for (let i = 1; i < env.length; i++) {
    if (env[i].t <= env[i - 1].t) param.setValueAtTime(env[i].gain, baseTime + env[i].t);
    else param.linearRampToValueAtTime(env[i].gain, baseTime + env[i].t);
    n++;
  }
  return n;
}
