// ─────────────────────────────────────────────────────────────────────────────
// device/index.js — the `deviceLibrary` platform adapter and the one-call installer.
//
//   import { deviceLibrary, installDeviceLibrary } from './device/index.js';
//
//   deviceLibrary.isAvailable()              true only in the Android (Capacitor) app with the native plugin
//   deviceLibrary.status                     scanStatus (phase / found / processed / total ...), always an object
//   deviceLibrary.requestPermission()        ask once; 'granted' | 'denied' | 'blocked' | 'needs-permission' | 'error'
//   deviceLibrary.openSettings()             the "Open settings" button of the blocked state
//   deviceLibrary.scan({ onProgress, signal, force })   incremental; see source.js
//   deviceLibrary.generation()               cheap change token
//   deviceLibrary.getArt(trackOrShelfItem, size)        -> object URL | null
//   deviceLibrary.mountScanCard(container)   the permission / progress card (status.js)
//   deviceLibrary.allowAndScan()             what the card's Allow button runs
//
// Everywhere else (web, desktop, Node tests) isAvailable() is false and every call is a harmless no-op, so the
// folder picker keeps working unchanged.
// ─────────────────────────────────────────────────────────────────────────────
import { resolveNative } from './native.js';
import { createDeviceSource } from './source.js';
import { createScanStatus, mountScanCard, describeStatus } from './status.js';
import { libraryPrefs } from '../library-prefs.js';

export { DeviceFile, DeviceBlob, DeviceReadError, createReadLimiter } from './device-file.js';
export { createDeviceSource } from './source.js';
export { createScanStatus, describeStatus, mountScanCard } from './status.js';
export { mapRow, applyTags, deviceTrackId } from './records.js';
export { resolveNative, isNativeAndroid } from './native.js';

/** Build an adapter around a native plugin (or null). Tests pass a fake; the app uses the default instance below. */
export function createDeviceLibrary({ native = undefined, win = globalThis, prefs = libraryPrefs, ...rest } = {}) {
  let source;
  const get = () => {
    if (source === undefined) {
      const n = native !== undefined ? native : resolveNative(win);
      source = createDeviceSource({ native: n, prefs, ...rest });
    }
    return source;
  };
  const adapter = {
    isAvailable: () => get().isAvailable(),
    get source() { return get(); },
    get status() { return get().status; },
    restore: () => get().restore(),
    refreshPermission: () => get().refreshPermission(),
    requestPermission: () => get().requestPermission(),
    openSettings: () => get().openSettings(),
    scan: (opts) => get().scan(opts),
    generation: () => get().generation(),
    getArt: (t, size) => get().getArt(t, size),
    tracks: () => get().tracks(),
    onChange: (fn) => get().onChange(fn),
    clear: () => get().clear(),
    startWatching: (cb) => get().startWatching(cb),
    attachResume: (o) => get().attachResume(o),
    async allowAndScan() {
      const r = await get().requestPermission();
      if (r !== 'granted') return null;
      get().startWatching().catch(() => {});
      return get().scan({ force: true });
    },
    mountScanCard(container, o = {}) {
      const s = get();
      return mountScanCard(container, {
        status: s.status,
        onAllow: () => adapter.allowAndScan(),
        onOpenSettings: () => s.openSettings(),
        onRetry: () => s.scan({ force: true }),
        ...o,
      });
    },
  };
  return adapter;
}

export const deviceLibrary = createDeviceLibrary();

/**
 * Boot wiring (one call from main.js): register the device source with the LibraryManager, show persisted
 * tracks at once, then check permission. With permission already granted it scans (incrementally) and keeps
 * itself fresh (MediaStore observer + rescan on resume). Without it, NOTHING is requested: the scan card's Allow
 * button (a user gesture, with the explanation) is the only thing that asks. No-op off Android.
 */
export async function installDeviceLibrary(library, { adapter = deviceLibrary, prefs = libraryPrefs } = {}) {
  if (!adapter.isAvailable()) return null;
  library.registerSource(adapter.source);
  await adapter.restore();
  const p = await adapter.refreshPermission();
  const detachResume = adapter.attachResume();
  let stopWatching = () => {};
  if (p === 'granted' && prefs.get().sources.device) {
    adapter.scan().catch(() => {});
    adapter.startWatching().then((stop) => { stopWatching = stop; }).catch(() => {});
  }
  return { adapter, detach() { detachResume(); stopWatching(); } };
}

export { describeStatus as describeScanStatus };
