// ─────────────────────────────────────────────────────────────────────────────
// fallback.js — the switch hook: run a show from the source the policy picks, and rescue it if it dies.
//
//   const fc = createFallbackController({ station, flagOn, cloudAvailable, net, factories:{ cloud, 'offline-host', canned } });
//   await fc.start();   fc.stop();   fc.source;   fc.onSwitch(cb)
//
// `factories[source](station)` returns a Session ({ start, stop, onChange }). Only the cloud source can be rescued: if the
// network goes away, or the cloud session reports an error, the controller stops it and starts the CANNED session (the
// dead-air ladder's rung 5: "offline: music only / pre-written show"), telling listeners through onSwitch. Cloud sessions do
// not exist yet (CLOUD_AVAILABLE is false), so today this only ever starts 'canned' or 'offline-host'; P2 plugs the real cloud
// factory in and flips the constant. Switching back up is deliberately NOT automatic (see policy.js: sticky).
// ─────────────────────────────────────────────────────────────────────────────

import { chooseShowSource, CLOUD_AVAILABLE } from './policy.js';
import { deadAirLadder } from '../core/scheduler.js';

export function createFallbackController({ station = null, flagOn = false, cloudAvailable = CLOUD_AVAILABLE, net, factories = {} } = {}) {
  const switchCbs = new Set();
  let session = null, source = null, unNet = null, stopped = true, decision = null, gen = 0;
  let stateCb = () => {};

  const online = () => { try { return !net || net.isOnline() !== false; } catch { return true; } };

  function launch(src, why) {
    const make = factories[src];
    if (typeof make !== 'function') return null;
    const my = ++gen;
    const s = make(station);
    if (!s) return null;
    session = s; source = src;
    if (typeof s.onChange === 'function') s.onChange((st) => {
      if (my !== gen) return;
      try { stateCb(st, src); } catch { /* */ }
      if (src === 'cloud' && st && st.phase === 'error') rescue('the cloud show failed');
    });
    return s;
  }

  function rescue(why) {
    if (stopped || source !== 'cloud') return;
    const from = source;
    const old = session;
    try { old && old.stop && old.stop(); } catch { /* */ }
    gen++;
    const next = chooseShowSource({ online: online(), cloudAvailable: false, flagOn, userStation: station, lastSource: 'cloud' });
    decision = next;
    const ladder = deadAirLadder({ online: online(), nextSongReady: true, talkReady: true });
    const s = launch(next.source || 'canned', why);
    for (const f of [...switchCbs]) { try { f({ from, to: source, reason: next.reason, why, ladder }); } catch { /* */ } }
    if (s && typeof s.start === 'function') Promise.resolve().then(() => s.start()).catch(() => {});
  }

  return {
    get source() { return source; },
    get session() { return session; },
    get decision() { return decision; },
    onSwitch(cb) { switchCbs.add(cb); return () => switchCbs.delete(cb); },
    onChange(cb) { stateCb = cb; },
    async start() {
      if (!stopped && session) return true; // already running: a second start must not orphan the first session or double-subscribe
      stopped = false;
      decision = chooseShowSource({ online: online(), cloudAvailable, flagOn, userStation: station, lastSource: null });
      const s = launch(decision.source || 'canned');
      if (!s) return false;
      try { unNet && unNet(); } catch { /* */ }
      unNet = null;
      if (source === 'cloud' && net && typeof net.onChange === 'function') unNet = net.onChange((isOn) => { if (!isOn) rescue('went offline'); });
      await s.start();
      return true;
    },
    stop() {
      stopped = true; gen++;
      try { unNet && unNet(); } catch { /* */ }
      unNet = null;
      try { session && session.stop && session.stop(); } catch { /* */ }
      session = null;
    },
  };
}
