// net.js — connectivity as an injectable adapter, so nothing here needs a browser to be tested.
// The real one wraps navigator.onLine and the window 'online' / 'offline' events (both are hints, not proof: a phone can be
// "online" behind a dead captive portal; a dropped cloud session is therefore ALSO a reason to degrade, see fallback.js).

/** -> { isOnline(), onChange(cb) -> unsubscribe } */
export function createNetAdapter({ win = (typeof window !== 'undefined' ? window : null), nav = (typeof navigator !== 'undefined' ? navigator : null) } = {}) {
  const isOnline = () => { try { return !nav || nav.onLine !== false; } catch { return true; } };
  return {
    isOnline,
    onChange(cb) {
      if (!win || typeof win.addEventListener !== 'function') return () => {};
      const on = () => { try { cb(true); } catch { /* */ } };
      const off = () => { try { cb(false); } catch { /* */ } };
      win.addEventListener('online', on); win.addEventListener('offline', off);
      return () => { try { win.removeEventListener('online', on); win.removeEventListener('offline', off); } catch { /* */ } };
    },
  };
}

/** A scriptable adapter for tests: set(online) flips it and notifies. */
export function createFakeNet(initial = true) {
  let online = initial;
  const cbs = new Set();
  return { isOnline: () => online, onChange(cb) { cbs.add(cb); return () => cbs.delete(cb); }, set(v) { online = !!v; for (const c of [...cbs]) c(online); } };
}
