// framegate.js — one place that decides how often animation may run. Normal: the display's own rAF. AOD: at most one tick a second.
// Other modules keep calling window.requestAnimationFrame; while the gate is in 'aod' mode this module swaps in a once-per-second
// version (install/uninstall), so no loop has to be edited. Loops that want to be explicit may call frameGate.request(cb).
export const MODES = Object.freeze({ normal: { minIntervalMs: 0 }, aod: { minIntervalMs: 1000 } });

/** Pure: may a frame run now? */
export function frameDue(mode, lastRunMs, nowMs) {
  const m = MODES[mode] || MODES.normal;
  return !(m.minIntervalMs > 0) || !Number.isFinite(lastRunMs) || nowMs - lastRunMs >= m.minIntervalMs;
}
/** Pure: how long until the next frame may run (ms, >= 0). */
export function frameWait(mode, lastRunMs, nowMs) {
  const m = MODES[mode] || MODES.normal;
  if (!(m.minIntervalMs > 0) || !Number.isFinite(lastRunMs)) return 0;
  return Math.max(0, m.minIntervalMs - (nowMs - lastRunMs));
}

/** env = { win } (defaults to window); `now` injectable for tests. */
export function createFrameGate(env = {}) {
  const win = env.win || (typeof window !== 'undefined' ? window : null);
  const now = env.now || (() => (win && win.performance ? win.performance.now() : Date.now()));
  const realRaf = win && win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : null;
  const realCancel = win && win.cancelAnimationFrame ? win.cancelAnimationFrame.bind(win) : null;
  const setT = env.setTimeout || ((f, ms) => setTimeout(f, ms));
  const clrT = env.clearTimeout || ((id) => clearTimeout(id));
  let origRaf = null, origCancel = null, mode = 'normal', installed = false, last = NaN, seq = 0;
  const pending = new Map();         // gated id -> timer / raf id
  const queue = [];                  // callbacks waiting for the shared once-a-second tick
  let timer = 0;
  const subs = new Set();

  function flush() {
    timer = 0; last = now();
    const cbs = queue.splice(0);
    for (const [id, cb] of cbs) { pending.delete(id); try { cb(last); } catch (e) { try { console.error(e); } catch { /* */ } } }
  }
  function request(cb) {
    const id = ++seq;
    if (mode === 'aod' || !realRaf) {
      queue.push([id, cb]); pending.set(id, 1);
      if (!timer) timer = setT(flush, frameWait(mode, last, now()) || (mode === 'aod' ? MODES.aod.minIntervalMs : 16));
    } else {
      pending.set(id, realRaf((t) => { pending.delete(id); cb(t); }));
    }
    return id;
  }
  function cancel(id) {
    const q = queue.findIndex((e) => e[0] === id);
    if (q >= 0) queue.splice(q, 1);
    else if (pending.has(id) && realCancel) { try { realCancel(pending.get(id)); } catch { /* */ } }
    pending.delete(id);
  }
  function install() {
    if (installed || !win || !realRaf) return;
    installed = true; origRaf = win.requestAnimationFrame; origCancel = win.cancelAnimationFrame;
    win.requestAnimationFrame = request; win.cancelAnimationFrame = cancel;
  }
  function uninstall() {
    if (!installed) return;
    installed = false;
    win.requestAnimationFrame = origRaf; win.cancelAnimationFrame = origCancel;
    // callbacks parked for the slow tick run on the real rAF now (a loop must never be lost)
    if (timer) { clrT(timer); timer = 0; }
    for (const [id, cb] of queue.splice(0)) { pending.delete(id); realRaf(cb); }
  }
  return {
    request, cancel, install, uninstall,
    get mode() { return mode; },
    setMode(m) {
      m = MODES[m] ? m : 'normal'; if (m === mode) return;
      mode = m;
      if (m === 'aod') install(); else uninstall();
      for (const f of [...subs]) { try { f(m); } catch { /* */ } }
    },
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    get installed() { return installed; },
  };
}
export const frameGate = createFrameGate();
