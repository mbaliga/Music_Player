// sleep.js — the sleep timer: a pure model (no DOM, no audio nodes, no real timers; everything is injected, so it is unit-testable).
//
//   start(5 | 10 | 15 | 30 | 45 | 60)   stop after that many minutes
//   start('end')                          stop at the end of the track that is playing (the stage / tape clock decides, see getTrackRemaining)
//   cancel()                              clear it
//   tick()                                called by a timer (src/background.js owns it, so it runs with the screen off) and on visibility changes
//
// The last FADE_SEC seconds fade the sound out (applyGain(g), g 1 -> 0). At zero the host's owner-aware stop runs (onExpire) and the timer clears.
// onExpire() must stop playback and then restore the volume itself (applyGain(1)); the model leaves the gain at 0 until then.
// A MANUAL stop clears it too: once it has seen sound, a quiet stretch of IDLE_CLEAR_MS means the listener stopped it themselves.
export const SLEEP_MINUTES = Object.freeze([5, 10, 15, 30, 45, 60]);
export const FADE_SEC = 10;
export const END_MARGIN_SEC = 0.6;      // 'end of track' stops this long before the end, already silent, so the gapless join / next-track logic never gets to start the next one
export const IDLE_CLEAR_MS = 3000;

/** Fade curve: 1 until the last `fadeSec`, then a gentle ease to 0 (power curve: sounds even, the ear is logarithmic). */
export function fadeGain(remainingSec, fadeSec = FADE_SEC) {
  if (!(remainingSec < fadeSec)) return 1;
  if (!(remainingSec > 0)) return 0;
  return Math.pow(remainingSec / fadeSec, 1.5);
}

export const isSpec = (v) => v === 'end' || SLEEP_MINUTES.includes(v);

export function formatLeft(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/**
 * deps: now() ms, getTrackRemaining() -> seconds to the end of the playing track | null (radio / nothing), isPlaying() -> bool,
 *       applyGain(g), onExpire(), onChange(state)? (also available through subscribe)
 */
export function createSleep({ now = () => Date.now(), getTrackRemaining = () => null, isPlaying = () => false, applyGain = () => {}, onExpire = () => {}, onClear = () => {} } = {}) {
  let mode = 'off', deadline = 0, spec = null, sawPlaying = false, idleSince = 0, lastKey = '', lastGain = 1;
  const subs = new Set();
  const snapshot = () => {
    if (mode === 'off') return { mode: 'off', spec: null, remainingSec: null, fading: false };
    let rem = null;
    if (mode === 'timer') rem = Math.max(0, (deadline - now()) / 1000);
    else { const tr = getTrackRemaining(); rem = tr == null ? null : Math.max(0, tr - END_MARGIN_SEC); }
    return { mode, spec, remainingSec: rem, fading: rem != null && rem < FADE_SEC };
  };
  const emit = (force = false) => {
    const s = snapshot();
    const key = `${s.mode}|${s.spec}|${s.remainingSec == null ? 'x' : Math.ceil(s.remainingSec)}`;
    if (!force && key === lastKey) return;
    lastKey = key;
    for (const f of [...subs]) { try { f(s); } catch { /* */ } }
  };
  const gain = (g) => { if (g === lastGain || (Math.abs(g - lastGain) < 0.004 && g !== 0 && g !== 1)) return; lastGain = g; try { applyGain(g); } catch { /* */ } };
  function reset(why) {
    const was = mode;
    mode = 'off'; spec = null; deadline = 0; sawPlaying = false; idleSince = 0;
    if (lastGain !== 1 && why !== 'expired') { lastGain = 1; try { applyGain(1); } catch { /* */ } }   // after an expiry the HOST restores the volume once its stop has landed (else the fade would end in a blip at full volume)
    if (was !== 'off') { try { onClear(why); } catch { /* */ } }
    emit(true);
  }
  const api = {
    start(v) {
      if (!isSpec(v)) return false;
      if (mode !== 'off') reset('restart');
      spec = v; mode = v === 'end' ? 'end' : 'timer';
      if (mode === 'timer') deadline = now() + v * 60000;
      sawPlaying = false; idleSince = 0; lastKey = '';
      api.tick(); emit(true);
      return true;
    },
    cancel() { if (mode !== 'off') reset('cancelled'); },
    tick() {
      if (mode === 'off') return;
      const t = now();
      if (isPlaying()) { sawPlaying = true; idleSince = 0; }
      else if (sawPlaying) {
        if (!idleSince) idleSince = t;
        else if (t - idleSince >= IDLE_CLEAR_MS) { reset('stopped'); return; }   // the listener stopped it: the timer goes with it
      }
      const s = snapshot();
      if (s.remainingSec == null) { gain(1); emit(); return; }               // 'end of track' with nothing that has an end (radio): wait
      if (s.remainingSec <= 0) {
        gain(0);
        try { onExpire(); } catch { /* */ }
        reset('expired');
        return;
      }
      gain(fadeGain(s.remainingSec));
      emit();
    },
    state: snapshot,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    get active() { return mode !== 'off'; },
  };
  return api;
}
