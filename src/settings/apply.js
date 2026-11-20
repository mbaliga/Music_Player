// apply.js — settings -> the document. The decisions are PURE (planAppearance, themeColorFor), the DOM writes are two small functions.
//
// Order of precedence for colour (documented in docs/SETTINGS.md):
//   1. a custom JSON theme (src/theme.js; its own light + dark sets) — when one is stored it supplies every colour, accent included
//   2. the accent colour (Settings -> Appearance) — replaces the violet and its glow
//   3. the built-in palette for the chosen theme: Dark (soft), OLED black (the original), Light
import { accentVars, ACCENT_CSS_VARS, THEME_CSS_VARS } from '../theme.js';

export const THEME_COLOR = Object.freeze({ oled: '#000000', dark: '#14141a', light: '#ebebf2' });
const MODE_OF = { oled: 'dark', dark: 'dark', light: 'light' };

/**
 * settings + { customTheme: parsed theme | null } -> what the root element should look like.
 *   attrs   data-* attributes (null = remove)
 *   customMode  'light'|'dark' when a custom theme's colours should be set, else null (clear them)
 *   accent  { vars } to set when no custom theme is active, else null (clear)
 *   metaColor  value for <meta name="theme-color">
 */
export function planAppearance(settings, { customTheme = null } = {}) {
  const a = (settings && settings.appearance) || {};
  const theme = MODE_OF[a.theme] ? a.theme : 'oled';
  const mode = MODE_OF[theme];
  const custom = !!customTheme;
  const vars = !custom && a.accent && a.accent !== 'violet' ? accentVars(a.accent, mode) : null;
  return {
    mode, theme,
    attrs: {
      'data-theme': mode,
      'data-tone': theme === 'dark' && !custom ? 'soft' : null,
      'data-text': a.textSize === 'small' || a.textSize === 'large' ? a.textSize : null,
      'data-motion': a.reduceMotion === 'reduce' ? 'reduce' : null,
    },
    customMode: custom ? mode : null,
    accent: vars ? { vars } : null,
    metaColor: custom ? customTheme.colors[mode].background.slice(-6).replace(/^/, '#') : THEME_COLOR[theme],
  };
}

/** Write a plan to the document element. Browser only. `setThemeVars` / `clearThemeVars` come from theme.js (injected for tests). */
export function applyPlan(plan, { root = document.documentElement, customTheme = null, setThemeVars, clearThemeVars, meta = null } = {}) {
  for (const [k, v] of Object.entries(plan.attrs)) { if (v === null) root.removeAttribute(k); else root.setAttribute(k, v); }
  if (plan.customMode && customTheme) { setThemeVars(customTheme, plan.customMode); root.style.removeProperty('--on-accent'); }
  else {
    clearThemeVars();
    for (const k of ACCENT_CSS_VARS) root.style.removeProperty(k);
    if (plan.accent) for (const [k, v] of Object.entries(plan.accent.vars)) root.style.setProperty(k, v);
  }
  try { (meta || document.querySelector('meta[name="theme-color"]'))?.setAttribute('content', plan.metaColor); } catch { /* no meta */ }
}

// ── reduce-motion override ──────────────────────────────────────────────────────────────────────────────────────────────
// Code that asks matchMedia('(prefers-reduced-motion: reduce)') directly (the shell, the FX ring) follows the setting, because the
// query is answered here; CSS @media rules cannot be overridden, so settings.css adds a [data-motion="reduce"] rule for those.
// "Follow system" never FORCES full motion: a phone set to reduce stays reduced.
export function installMotionOverride(win = window, isForced = () => win.document.documentElement.dataset.motion === 'reduce') {
  try {
    if (win.__runoutMotionPatched || typeof win.matchMedia !== 'function') return false;
    const orig = win.matchMedia.bind(win);
    win.matchMedia = (q) => {
      const m = orig(q);
      if (!/prefers-reduced-motion\s*:\s*reduce/.test(String(q)) || !isForced()) return m;
      return new Proxy(m, { get: (t, k) => (k === 'matches' ? true : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) });
    };
    win.__runoutMotionPatched = true;
    return true;
  } catch { return false; }
}

export const modeOfTheme = (t) => MODE_OF[t] || 'dark';
export { THEME_CSS_VARS };
