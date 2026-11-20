// native.js — the optional bridge to the DeviceDisplay Capacitor plugin (native/android-display/DeviceDisplayPlugin.java).
// Absent on the web / desktop / tests: everything here degrades to a no-op and reports `available: false`.
export function getDisplayPlugin(win = typeof window !== 'undefined' ? window : null) {
  try {
    const cap = win && win.Capacitor;
    if (!cap) return null;
    if (typeof cap.isNativePlatform === 'function' && !cap.isNativePlatform()) return null;
    if (typeof cap.isPluginAvailable === 'function' && !cap.isPluginAvailable('DeviceDisplay')) return null;
    if (typeof cap.registerPlugin === 'function') return cap.registerPlugin('DeviceDisplay');
    return (cap.Plugins && cap.Plugins.DeviceDisplay) || null;
  } catch { return null; }
}

/** Brightness / refresh-rate overrides for AOD. plugin = getDisplayPlugin() or a fake. Never throws, never rejects. */
export function createDisplayControl(plugin) {
  const call = async (name, arg) => { try { if (plugin && typeof plugin[name] === 'function') { await plugin[name](arg); return true; } } catch { /* the OS may refuse; AOD still works */ } return false; };
  return {
    get available() { return !!plugin; },
    setBrightness: (fraction) => call('setBrightness', { fraction: fraction == null ? null : Math.max(0.01, Math.min(1, fraction)) }),
    setRefreshRate: (hz) => call('setPreferredRefreshRate', { hz: hz == null ? null : hz }),
    async info() { try { return plugin && plugin.getInfo ? await plugin.getInfo() : null; } catch { return null; } },
  };
}
