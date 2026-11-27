// wire.js — connects the settings store to the document at boot (main.js calls initSettings() once, before first paint).
// Everything app-specific (what "haptics" or "default speed" do) is subscribed by main.js; this file owns appearance only.
import { createSettingsStore } from './settings.js';
import { planAppearance, applyPlan, installMotionOverride } from './apply.js';
import { loadStoredTheme, setThemeVars, clearThemeVars } from '../theme.js';

const safeStorage = () => { try { return window.localStorage; } catch { return null; } };

export function initSettings({ win = window, doc = document, storage = safeStorage(), onWriteError = null } = {}) {
  const store = createSettingsStore({ storage, onWriteError });
  const custom = () => { try { return loadStoredTheme(); } catch { return null; } };
  const listeners = new Set();
  let lastDark = store.get('appearance.theme') === 'light' ? 'oled' : store.get('appearance.theme');

  function apply() {
    const c = custom();
    applyPlan(planAppearance(store.get(), { customTheme: c }), { root: doc.documentElement, customTheme: c, setThemeVars, clearThemeVars });
    const b = doc.getElementById('btnTheme');
    if (b) {
      const t = store.get('appearance.theme'); const ic = b.querySelector('.ic') || b;
      ic.textContent = t === 'light' ? '☀' : t === 'oled' ? '●' : '☾';
      const name = t === 'light' ? 'Light' : t === 'oled' ? 'OLED' : 'Dark';
      b.setAttribute('aria-label', `Theme: ${name}. Tap to change`); b.title = `Theme: ${name}. Tap to change (Light, Dark, OLED)`;
    }
  }
  installMotionOverride(win);
  apply();
  store.subscribe((_, path) => {
    if (store.get('appearance.theme') !== 'light') lastDark = store.get('appearance.theme');
    if (path === '*' || String(path).startsWith('appearance.')) apply();
  });
  return {
    store, apply,
    /** A custom theme was applied / reset (main.js): re-apply and tell the Settings page. */
    customThemeChanged() { apply(); for (const f of [...listeners]) { try { f(); } catch { /* */ } } },
    onCustomTheme(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** The drawer's moon / sun button: Light <-> the dark tone you last used. */
    toggleLightDark() { store.set('appearance.theme', store.get('appearance.theme') === 'light' ? lastDark : 'light'); },
    /** The drawer's Theme pill: Light -> Dark -> OLED -> Light (the three Settings offers; the Settings chips follow the store live). */
    cycleTheme() { const order = ['light', 'dark', 'oled']; store.set('appearance.theme', order[(order.indexOf(store.get('appearance.theme')) + 1) % order.length]); },
  };
}
