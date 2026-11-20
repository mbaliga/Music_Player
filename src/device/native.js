// native.js — find the Runout "DeviceLibrary" Capacitor plugin (native/android/DeviceLibraryPlugin.java).
// Returns null everywhere except the Android app, so the web build, desktop browsers and every Node test
// keep using the folder picker. No @capacitor/core import: the app ships unbundled ES modules and the
// Capacitor bridge injects `window.Capacitor` itself.

export const PLUGIN_NAME = 'DeviceLibrary';

export function platformOf(win = globalThis) {
  const cap = win && win.Capacitor;
  if (!cap) return 'web';
  try {
    if (typeof cap.getPlatform === 'function') return String(cap.getPlatform());
  } catch { /* fall through */ }
  return typeof cap.platform === 'string' ? cap.platform : 'web';
}

export function isNativeAndroid(win = globalThis) {
  const cap = win && win.Capacitor;
  if (!cap) return false;
  try {
    const native = typeof cap.isNativePlatform === 'function' ? !!cap.isNativePlatform() : platformOf(win) !== 'web';
    return native && platformOf(win) === 'android';
  } catch { return false; }
}

/** The plugin proxy, or null when this is not the Android app (or the plugin is not installed). */
export function resolveNative(win = globalThis) {
  if (!isNativeAndroid(win)) return null;
  const cap = win.Capacitor;
  try {
    return cap.Plugins?.[PLUGIN_NAME] || (typeof cap.registerPlugin === 'function' ? cap.registerPlugin(PLUGIN_NAME) : null) || null;
  } catch { return null; }
}
