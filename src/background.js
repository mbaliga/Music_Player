// background.js — keep the music going with the screen off / the app in the background (docs/DEVICE_LIBRARY.md, "Background playback").
//
// Three independent pieces, all no-ops where they do not apply (web, tests):
//
//   createLoopDriver(step)     drives the transport loop: requestAnimationFrame while the page is visible, a 250 ms timer while it is hidden
//                              (a hidden WebView gets no animation frames, and the loop owns rate, position, end-of-track and the
//                              mixtape / queue ticks). step(now, hidden) does the drawing only when hidden is false.
//   installAudioResume(...)    resume() the AudioContext when the OS suspends it (statechange) and when visibility changes.
//   createMediaBridge(...)     tells the native foreground service (DevicePlayback plugin) / navigator.mediaSession what is playing,
//                              and turns media-button events into the app's own transport actions.
//
//   startBackground({ step, engine, getMeta, actions }) wires all three and returns { sync(sources), poke(), driver, bridge }.
import { pickNowPlaying } from './shell/nowplaying.js';

export const BG_INTERVAL_MS = 250;
export const IDLE_STOP_MS = 60000;      // nothing playing this long: remove the notification and stop the service

// ── the loop driver ────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * One step at a time, from exactly one scheduler: rAF while visible, setInterval while hidden. A step that throws is logged and the loop
 * carries on (before this, one exception in a frame silently ended the transport for good).
 * env (all optional, for tests): { doc, raf, caf, setIv, clearIv, now }.
 */
export function createLoopDriver(step, env = {}) {
  const doc = env.doc !== undefined ? env.doc : (typeof document !== 'undefined' ? document : null);
  const raf = env.raf || (typeof requestAnimationFrame === 'function' ? (f) => requestAnimationFrame(f) : null);
  const caf = env.caf || (typeof cancelAnimationFrame === 'function' ? (id) => cancelAnimationFrame(id) : () => {});
  const setIv = env.setIv || ((f, ms) => setInterval(f, ms));
  const clearIv = env.clearIv || ((id) => clearInterval(id));
  const now = env.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const hidden = () => !!(doc && (doc.hidden === true || doc.visibilityState === 'hidden'));

  let running = false, rafId = 0, ivId = 0, inStep = false, errs = 0;

  function run(t, bg) {
    if (inStep) return;                       // never re-enter (an end-of-track poke from inside a step)
    inStep = true;
    try { step(t, bg); } catch (e) { if (errs++ < 5) { try { console.error('frame step failed', e); } catch { /* */ } } }
    finally { inStep = false; }
  }
  function onRaf(t) {
    rafId = 0;
    if (!running) return;
    run(typeof t === 'number' ? t : now(), hidden());
    arm();
  }
  function onTimer() {
    if (!running) return;
    if (!hidden()) { arm(); return; }         // visible again: hand back to rAF
    run(now(), true);
  }
  /** Make exactly the right scheduler active for the current visibility. */
  function arm() {
    if (!running) return;
    if (hidden()) {
      if (rafId) { caf(rafId); rafId = 0; }
      if (!ivId) ivId = setIv(onTimer, BG_INTERVAL_MS);
    } else {
      if (ivId) { clearIv(ivId); ivId = 0; }
      if (!rafId && raf) rafId = raf(onRaf);
    }
  }
  const onVis = () => { if (running) { arm(); if (hidden()) run(now(), true); } };

  return {
    start() {
      if (running) return;
      running = true;
      if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVis);
      arm();
    },
    stop() {
      running = false;
      if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVis);
      if (rafId) { caf(rafId); rafId = 0; }
      if (ivId) { clearIv(ivId); ivId = 0; }
    },
    /** Run a (hidden-mode) step right now: the audio thread says the track is about to end / has ended. No-op while visible. */
    poke() { if (running && hidden()) run(now(), true); },
    get mode() { return !running ? 'stopped' : hidden() ? 'timer' : 'raf'; },
  };
}

// ── AudioContext resume ────────────────────────────────────────────────────────────────────────────────────────────────────
/** Try to resume a suspended / interrupted context on statechange and on every visibility change. Returns a remove function. */
export function installAudioResume({ getCtx, doc = typeof document !== 'undefined' ? document : null } = {}) {
  const attempt = () => {
    try {
      const ctx = getCtx && getCtx();
      if (ctx && ctx.state !== 'running' && ctx.state !== 'closed' && typeof ctx.resume === 'function') {
        const p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});      // a gesture may be required first: the next play tap does it
      }
    } catch { /* */ }
  };
  let ctx = null;
  try { ctx = getCtx && getCtx(); } catch { /* */ }
  if (ctx && ctx.addEventListener) ctx.addEventListener('statechange', attempt);
  if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', attempt);
  return () => {
    if (ctx && ctx.removeEventListener) ctx.removeEventListener('statechange', attempt);
    if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', attempt);
  };
}

// ── the native plugin, behind a safe wrapper ───────────────────────────────────────────────────────────────────────────────
const regCache = new WeakMap();
/** The DevicePlayback Capacitor plugin, or null on the web / desktop / tests (and when the APK was built without it). */
export function getPlaybackPlugin(win = typeof window !== 'undefined' ? window : null) {
  try {
    const cap = win && win.Capacitor;
    if (!cap) return null;
    if (typeof cap.isNativePlatform === 'function' && !cap.isNativePlatform()) return null;
    if (typeof cap.isPluginAvailable === 'function' && !cap.isPluginAvailable('DevicePlayback')) return null;
    if (typeof cap.registerPlugin === 'function') {
      if (!regCache.has(cap)) regCache.set(cap, cap.registerPlugin('DevicePlayback'));
      return regCache.get(cap);
    }
    return (cap.Plugins && cap.Plugins.DevicePlayback) || null;
  } catch { return null; }
}

// ── now playing -> native service / mediaSession, and media buttons -> transport ─────────────────────────────────────────────
/**
 * plugin       getPlaybackPlugin() or a fake (null = web: navigator.mediaSession is used instead)
 * actions       { toggle(source), next(source), prev(source), stop() }   the app's own transport (main.js miniActions)
 * getMeta(src)  -> { artist?, album? } for the playing source (main.js knows the library; this module does not)
 * duck(on)      music-bus ducking for AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK
 * notice(text)  a short plain-words message for the user (toast)
 * env           { doc, nav, now, setTimeout, clearTimeout, MediaMetadata } for tests
 */
export function createMediaBridge({ plugin = null, actions = {}, getMeta = () => ({}), duck = () => {}, notice = () => {}, env = {} } = {}) {
  const doc = env.doc !== undefined ? env.doc : (typeof document !== 'undefined' ? document : null);
  const nav = env.nav !== undefined ? env.nav : (typeof navigator !== 'undefined' ? navigator : null);
  const now = env.now || (() => Date.now());
  const MD = env.MediaMetadata !== undefined ? env.MediaMetadata : (typeof MediaMetadata !== 'undefined' ? MediaMetadata : null);
  const ms = !plugin && nav && nav.mediaSession ? nav.mediaSession : null;

  let np = null;               // the current pickNowPlaying() result
  let last = null;             // the last non-null np: a media "play" after a pause resumes THIS source
  let key = '', wasPlaying = false, started = false, askedPerm = false, idleSince = 0, lastSent = '', startTries = 0;
  const handles = [];

  const visible = () => !(doc && (doc.hidden === true || doc.visibilityState === 'hidden'));
  const safe = async (fn) => { try { return await fn(); } catch { return undefined; } };

  // ── media buttons / notification actions / focus changes -> the app's transport ──
  function onPlay() {
    const s = np || last;
    if (!s) return;
    if (np && np.playing) return;                               // already playing: nothing to do
    // Radio is deliberately NOT resumed (key, notification or after a call): a live stream has moved on while paused, and stop() tore the
    // connection down. Tapping the dial reconnects. (The native side may still send 'play' on focus gain; it lands here and is ignored.)
    if (s.source === 'radio') return;
    Promise.resolve(actions.toggle && actions.toggle(s.source)).catch(() => {});
  }
  function onPause() {
    if (!np || !np.playing) return;
    if (np.source === 'radio') { Promise.resolve(actions.stop && actions.stop()).catch(() => {}); return; }
    Promise.resolve(actions.toggle && actions.toggle(np.source)).catch(() => {});
  }
  function onNext() { const s = np || last; if (s && s.source !== 'radio' && actions.next) Promise.resolve(actions.next(s.source)).catch(() => {}); }
  function onPrev() { const s = np || last; if (s && s.source !== 'radio' && actions.prev) Promise.resolve(actions.prev(s.source)).catch(() => {}); }
  const handlers = { play: onPlay, pause: onPause, next: onNext, previous: onPrev };

  if (plugin && typeof plugin.addListener === 'function') {
    for (const name of ['play', 'pause', 'next', 'previous']) {
      safe(async () => { const h = await plugin.addListener(name, () => handlers[name]()); handles.push(h); });
    }
    // the service went away (notification swiped while paused, task removed): the next play starts it again
    safe(async () => { const h = await plugin.addListener('stopped', () => { started = false; lastSent = ''; key = ''; startTries = 0; }); handles.push(h); });
    // Android refused to promote the service (Play pressed from the background): audio continues but may be stopped by the OS.
    // Say so once and let the next sync while visible start the service again.
    safe(async () => { const h = await plugin.addListener('fgs-denied', () => {
      started = false; lastSent = ''; startTries = 0;
      try { notice('Background playback could not start. Open Runout and press Play to keep it going with the screen off.'); } catch { /* */ }
    }); handles.push(h); });
    safe(async () => { const h = await plugin.addListener('duck', (e) => { try { duck(!!(e && e.on)); } catch { /* */ } }); handles.push(h); });
  } else if (ms) {
    const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch { /* unsupported action */ } };
    set('play', onPlay); set('pause', onPause); set('nexttrack', onNext); set('previoustrack', onPrev);
  }

  // ── now playing -> out ──
  async function ensureService() {
    if (started || !plugin) return;
    if (!visible()) return;                                     // never start a foreground service from the background (API 31+ refuses)
    started = true;
    if (!askedPerm) {                                           // API 33+: ask once, on the first play; a refusal only hides the notification
      askedPerm = true;
      await safe(() => plugin.requestNotificationPermission && plugin.requestNotificationPermission());
    }
    const ok = await safe(async () => { await plugin.start(); return true; });
    if (!ok) { started = false; startTries++; }             // refused (e.g. the OS would not start it): retried a few times, then left alone
  }

  function sync(sources) {
    const cur = pickNowPlaying(sources);
    np = cur;
    if (cur) last = cur;
    const t = now();
    if (!cur) {
      if (wasPlaying || started) {
        wasPlaying = false;
        if (plugin) safe(() => plugin.setState({ playing: false }));
        if (ms) { try { ms.playbackState = 'paused'; } catch { /* */ } }
      }
      if (started) {
        if (!idleSince) idleSince = t;
        else if (t - idleSince > IDLE_STOP_MS) { started = false; idleSince = 0; key = ''; if (plugin) safe(() => plugin.stop()); }
      }
      return;
    }
    idleSince = 0;
    const meta = (() => { try { return getMeta(cur.source) || {}; } catch { return {}; } })();
    const k = `${cur.source}|${cur.title}|${cur.sub}|${meta.artist || ''}|${meta.album || ''}`;
    const md = { title: cur.title, artist: meta.artist || cur.sub || '', album: meta.album || '' };
    const stateKey = `${k}|${cur.playing ? 1 : 0}`;
    if (stateKey === lastSent && !(plugin && cur.playing && !started && startTries < 3)) { wasPlaying = cur.playing; return; }
    lastSent = stateKey;
    if (plugin) {
      if (k !== key) safe(() => plugin.setMetadata(md));
      safe(() => plugin.setState({ playing: !!cur.playing }));
      if (cur.playing && !started && startTries < 3) ensureService();
    }
    if (ms) {
      if (k !== key && MD) { try { ms.metadata = new MD(md); } catch { /* */ } }
      try { ms.playbackState = cur.playing ? 'playing' : 'paused'; } catch { /* */ }
    }
    key = k; wasPlaying = !!cur.playing;
  }

  return {
    sync, get started() { return started; }, handlers,
    destroy() { for (const h of handles) { try { h && h.remove && h.remove(); } catch { /* */ } } },
  };
}

// ── the sleep timer's clock ─────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Drives src/sleep.js with a timer of its own (NOT requestAnimationFrame, which a hidden page never gets): setInterval keeps ticking with the
 * screen off while the foreground service holds the app alive, and a visibility change ticks at once. The model works from a wall-clock deadline,
 * so a throttled timer only delays the stop, never loses it. env: { doc, setIv, clearIv } for tests.
 */
export function createSleepDriver(sleep, { tickMs = 250, env = {} } = {}) {
  const doc = env.doc !== undefined ? env.doc : (typeof document !== 'undefined' ? document : null);
  const setIv = env.setIv || ((f, ms) => setInterval(f, ms));
  const clearIv = env.clearIv || ((id) => clearInterval(id));
  let id = 0;
  const run = () => { try { sleep.tick(); } catch (e) { try { console.error('sleep tick failed', e); } catch { /* */ } } };
  const onVis = () => run();
  const arm = () => { if (sleep.active && !id) { id = setIv(run, tickMs); if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVis); } else if (!sleep.active && id) disarm(); };
  const disarm = () => { if (id) { clearIv(id); id = 0; } if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVis); };
  const off = sleep.subscribe(arm);      // armed while a timer exists, silent (no timer at all) otherwise
  arm();
  return { get running() { return !!id; }, tickNow: run, destroy() { off(); disarm(); } };
}

// ── everything, for main.js ────────────────────────────────────────────────────────────────────────────────────────────────
export function startBackground({ step, engine, actions, getMeta, notice, win = typeof window !== 'undefined' ? window : null, doc = typeof document !== 'undefined' ? document : null } = {}) {
  const driver = createLoopDriver(step, { doc });
  installAudioResume({ getCtx: () => engine && engine.ctx, doc });
  if (engine) {
    // The audio thread tells us the track is about to end / has ended, so advancing never waits on a throttled timer.
    engine.onPlaybackEdge = () => { try { driver.poke(); } catch { /* */ } };
  }
  const duck = (on) => {
    try {
      const g = engine.musicBus.gain, t = engine.ctx.currentTime;
      g.setTargetAtTime(on ? 0.25 : 1, t, 0.08);
    } catch { /* no engine yet */ }
  };
  const bridge = createMediaBridge({ plugin: getPlaybackPlugin(win), actions, getMeta, duck, notice });
  driver.start();
  return { driver, bridge, sync: (sources) => bridge.sync(sources), poke: () => driver.poke() };
}
