// keepawake.js — keep the screen on while Device mode is locked. Prefer the native DeviceDisplay plugin (FLAG_KEEP_SCREEN_ON: no
// permission, survives WebView visibility quirks), else the Screen Wake Lock API (re-acquired on visibilitychange), else nothing
// (`status.mode === 'none'`; the UI says the screen may still sleep). Never throws; never rejects.
//
// env = { native?: {keepAwake({on})}, nav?: Navigator, doc?: Document }
export function createKeepAwake(env = {}) {
  const nav = env.nav || (typeof navigator !== 'undefined' ? navigator : null);
  const doc = env.doc || (typeof document !== 'undefined' ? document : null);
  const native = env.native || null;
  let want = false, sentinel = null, nativeOn = false, pending = null, error = null, nativeBroken = false;
  const subs = new Set();
  const visible = () => !doc || doc.visibilityState !== 'hidden';
  const emit = () => { for (const f of [...subs]) { try { f(status()); } catch { /* */ } } };

  function status() {
    const mode = native && !nativeBroken ? 'native' : (nav && nav.wakeLock && typeof nav.wakeLock.request === 'function' ? 'wakelock' : 'none');
    return { mode, wanted: want, held: mode === 'native' ? nativeOn : !!sentinel, error };
  }

  async function applyNative() {
    try { await native.keepAwake({ on: want }); nativeOn = want; error = null; return true; }
    catch (e) { nativeBroken = true; nativeOn = false; error = 'native:' + ((e && e.message) || 'failed'); return false; }
  }
  async function applyWeb() {
    if (!want) {
      const s = sentinel; sentinel = null;
      if (s) { try { await s.release(); } catch { /* already released */ } }
      return;
    }
    if (sentinel || !visible()) return;                          // visible only: the API rejects a hidden page
    if (!nav || !nav.wakeLock || typeof nav.wakeLock.request !== 'function') { error = 'unsupported'; return; }
    try {
      const s = await nav.wakeLock.request('screen');
      if (!want) { try { await s.release(); } catch { /* */ } return; }   // unlocked while the request was in flight
      sentinel = s; error = null;
      if (typeof s.addEventListener === 'function') s.addEventListener('release', () => { if (sentinel === s) { sentinel = null; emit(); } });
    } catch (e) { error = (e && e.name) || 'failed'; }          // NotAllowedError (battery saver, no gesture, policy)
  }
  async function apply() {
    if (native && !nativeBroken) { if (await applyNative()) return; }
    await applyWeb();
  }
  // serialise applies so rapid lock/unlock cannot interleave
  function run() { pending = (pending || Promise.resolve()).then(apply).catch(() => {}).then(emit); return pending; }

  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', () => { if (want && visible()) run(); });
  }
  return {
    /** Request (on=true) or drop (on=false) the hold. Resolves when applied; the result is the current status. */
    set(on) { want = !!on; return run().then(status); },
    get status() { return status(); },
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
  };
}
