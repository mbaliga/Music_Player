// state.js — the player's state machine as a PURE reducer: reduce(state, action) -> { state, effects }.
//
// Fields (the handoff's): playing / starting / dragging / dep (arm deploy 0..1) / armS (arm position 0..1 along the chord) /
// frozenS (playhead while stopped) / z, zT, zGest (zoom + target + gesture-driven) / focus, fTarget (library cover focus).
//
// Rules (handoff section 1, rule 5-7):
//   * ONE toggle: Play when idle, Stop when playing or starting. The disc never leaves the platter.
//   * Stop freezes the disc / waveform / dots at the playhead (frozenS); the arm slides back along the rail (armS -> 0) and THEN
//     folds into the slot (dep -> 0). Play lowers the arm (dep -> 1) and audio begins when it is down; it RESUMES at frozenS and
//     restarts from 0 when the record had finished (frozenS > FINISHED).
//   * Pressing Play while the arm is still retracting resumes at frozenS (where it stopped), not wherever the arm happens to be.
//   * The arm lowers only while the player is in view (z < ARM_Z): playing a track from the library waits for the zoom-in.
//
// Effects are plain tags the glue acts on: 'beginAudio' (arm is down: open the bus), 'silence' (lift: bus off), 'focusSettled'.
export const FINISHED = 0.985;
export const ARM_Z = 0.3;
export const DEPLOY_S = 1.1;       // seconds for the arm to lower / fold
export const RETRACT_RATE = 1.1;   // armS decay: dt * RETRACT_RATE * (.4 + armS)
export const FOCUS_RATE = 11;
export const NONE = Object.freeze([]);

export function createPlayer() {
  return {
    playing: false, starting: false, dragging: false, wasPlaying: false,
    dep: 0, armS: 0, frozenS: 0, pendStart: 0,
    z: 0, zT: 0, zGest: false, focus: 0, fTarget: 0, focusDrag: false,
  };
}

const out = (state, ...effects) => ({ state, effects: effects.length ? effects : NONE });

/** the playhead the display/spiral/arm should show right now (0..1) */
export function playheadS(st, posS) {
  if (st.dragging || st.starting) return st.armS;
  return st.playing ? posS : st.frozenS;
}
/** does anything move? (the rAF loop runs only while this is true) */
export function needsFrame(st, eps = 0.0005) {
  return st.playing || st.starting || st.dragging || st.armS > eps || st.dep > 0.001 || st.z !== st.zT || st.focus !== st.fTarget;
}

export function reduce(st, a) {
  switch (a.type) {
    case 'toggle': {
      if (st.playing || st.starting) return reduce(st, { type: 'stop', s: a.s });
      const s0 = st.frozenS > FINISHED ? 0 : st.frozenS;
      return out({ ...st, starting: true, playing: false, pendStart: s0 });
    }
    case 'play': {   // start at s (a library track pick, album next/prev, a finished-record restart)
      return out({ ...st, starting: true, playing: false, dragging: false, pendStart: clamp01(a.s ?? 0), frozenS: clamp01(a.s ?? 0) });
    }
    case 'audioBegan':
      return out({ ...st, starting: false, playing: true });
    case 'stop': {
      const frozen = st.playing ? clamp01(a.s ?? st.armS) : st.starting ? st.pendStart : st.armS;
      return out({ ...st, playing: false, starting: false, dragging: false, frozenS: frozen }, 'silence');
    }
    case 'finished':
      return out({ ...st, playing: false, starting: false, frozenS: 1 }, 'silence');
    case 'dragStart': {
      if (st.dep < 0.99 || st.dragging) return out(st);
      const s = st.playing ? clamp01(a.s ?? st.armS) : st.armS;
      return out({ ...st, dragging: true, wasPlaying: st.playing || st.starting, playing: false, starting: false, armS: s, frozenS: s }, 'silence');
    }
    case 'dragMove':
      return st.dragging ? out({ ...st, armS: clamp01(a.s), frozenS: clamp01(a.s) }) : out(st);
    case 'dragEnd': {
      if (!st.dragging) return out(st);
      const s = clamp01(a.s ?? st.armS);
      if (s > 0.01 || st.wasPlaying) return out({ ...st, dragging: false, starting: true, pendStart: s, armS: s, frozenS: s });
      return out({ ...st, dragging: false, wasPlaying: false, armS: s, frozenS: s });
    }
    case 'zoomTo': return out({ ...st, zT: clamp01(a.z), zGest: false });
    case 'pinchStart': return out({ ...st, zGest: true, zT: st.z });
    case 'pinchMove': return out({ ...st, z: clamp01(a.z), zT: clamp01(a.z) });
    case 'pinchEnd': return out({ ...st, zGest: false, zT: a.settle ? 1 : 0 });
    case 'setZ': return out({ ...st, z: clamp01(a.z), zT: clamp01(a.z), zGest: false });
    case 'focusTo': return out({ ...st, fTarget: a.index, focusDrag: false });
    case 'focusDrag': return out({ ...st, focus: a.value, fTarget: a.value, focusDrag: true });
    case 'focusSet': return out({ ...st, focus: a.index, fTarget: a.index, focusDrag: false });
    case 'tick': return tick(st, a);
    default: return out(st);
  }
}

function tick(st, { dt, posS = 0, easeZ, reduced = false }) {
  const n = { ...st };
  const fx = [];
  if (!n.zGest && n.z !== n.zT) n.z = easeZ ? easeZ(n.z, n.zT, dt, reduced) : n.zT;
  if (!n.focusDrag && n.fTarget !== n.focus) {
    n.focus += (n.fTarget - n.focus) * Math.min(1, dt * FOCUS_RATE * (reduced ? 2.5 : 1));
    if (Math.abs(n.fTarget - n.focus) < 0.003) { n.focus = n.fTarget; fx.push('focusSettled'); }
  }
  const wantOut = n.playing || n.dragging || (n.starting && n.z < ARM_Z);
  if (n.dragging) { /* armS is driven by the pointer */ }
  else if (n.playing) n.armS = clamp01(posS);
  else if (n.starting) n.armS = n.pendStart;
  else if (n.armS > 0.0005) n.armS = Math.max(0, n.armS - dt * RETRACT_RATE * (0.4 + n.armS));
  else n.armS = 0;
  if (wantOut) n.dep = Math.min(1, n.dep + dt / DEPLOY_S);
  else if (n.armS <= 0) n.dep = Math.max(0, n.dep - dt / DEPLOY_S);
  if (n.starting && n.dep >= 1) fx.push('beginAudio');
  // an unchanged state keeps its identity, so the caller can tell "nothing moved" with ===
  let same = true;
  for (const k in n) if (n[k] !== st[k]) { same = false; break; }
  return fx.length ? { state: same ? st : n, effects: fx } : { state: same ? st : n, effects: NONE };
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
