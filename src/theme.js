// ─────────────────────────────────────────────────────────────────────────────
// theme.js — JSON-based custom theming (paste → preview → apply).
//
// Schema (shared byte-for-byte with the Fylz/Fyl-Manager and Fotoz/Foto-Xplorr
// apps — do not diverge from this shape):
//
//   {
//     "version": 1,
//     "name": "My Theme",
//     "colors": {
//       "light": { "primary": "#RRGGBB", "secondary": "#RRGGBB", "tertiary": "#RRGGBB",
//                  "background": "#RRGGBB", "surface": "#RRGGBB", "surfaceVariant": "#RRGGBB",
//                  "onBackground": "#RRGGBB", "onSurface": "#RRGGBB" },
//       "dark":  { ...same 8 keys... }
//     }
//   }
//
// "#AARRGGBB" (8-digit, alpha-prefixed — Android's Color.parseColor shape) is
// accepted too, as a superset. There is no platform color parser here, so hex
// shape is validated by hand below.
//
// The parsing/validation half of this file (parseTheme + the hex helpers) is
// pure — no DOM, no browser global — so it is unit-testable the same way
// model.js is (see test/theme.test.mjs). Only setThemeVars/clearThemeVars touch
// `document`, and only from inside a function body, so importing this module
// under plain Node (as the tests do) is safe as long as those two are never
// called outside a browser.
// ─────────────────────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1;

/** The 8 required color keys, per mode, in schema order. */
export const PALETTE_KEYS = [
  'primary', 'secondary', 'tertiary',
  'background', 'surface', 'surfaceVariant',
  'onBackground', 'onSurface',
];

const MODES = ['light', 'dark'];

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate one hex color string. Accepts "#RRGGBB" or the 8-digit
 * alpha-prefixed "#AARRGGBB" superset. Returns null when valid, or a
 * human-readable reason naming the exact field and the bad value.
 */
export function validateHexColor(value, fieldPath) {
  if (typeof value !== 'string') {
    return `Invalid color for "${fieldPath}": ${JSON.stringify(value)} (expected a "#RRGGBB" or "#AARRGGBB" hex string).`;
  }
  if (value.charAt(0) !== '#') {
    return `Invalid color for "${fieldPath}": "${value}" (missing leading "#").`;
  }
  const body = value.slice(1);
  if (body.length !== 6 && body.length !== 8) {
    return `Invalid color for "${fieldPath}": "${value}" (expected 6 or 8 hex digits after "#", got ${body.length}).`;
  }
  if (!/^[0-9a-fA-F]+$/.test(body)) {
    return `Invalid color for "${fieldPath}": "${value}" (contains a non-hex digit).`;
  }
  return null;
}

/**
 * Parse and validate a theme JSON document from raw text.
 *
 * Returns { ok: true, theme } on success (theme is normalized: version,
 * name, colors.light.*, colors.dark.* — always present in canonical order),
 * or { ok: false, error } with ONE specific, named reason on failure. Never
 * throws — every malformed shape is caught and named instead.
 */
export function parseTheme(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${e.message}` };
  }

  if (!isPlainObject(raw)) {
    return { ok: false, error: 'Theme must be a JSON object (got ' + (Array.isArray(raw) ? 'an array' : typeof raw) + ').' };
  }

  if (!('version' in raw)) {
    return { ok: false, error: 'Missing "version" field (expected 1).' };
  }
  if (raw.version !== SCHEMA_VERSION) {
    return { ok: false, error: `Unsupported "version": ${JSON.stringify(raw.version)} (expected ${SCHEMA_VERSION}).` };
  }

  // "name" has no named malformed case in the spec — tolerate absence/bad type
  // rather than refusing the whole theme over a cosmetic label.
  const name = (typeof raw.name === 'string' && raw.name.trim()) ? raw.name : 'Custom theme';

  if (!isPlainObject(raw.colors)) {
    return { ok: false, error: 'Missing "colors" object.' };
  }

  const colors = {};
  for (const mode of MODES) {
    const modeColors = raw.colors[mode];
    if (!isPlainObject(modeColors)) {
      return { ok: false, error: `Missing "colors.${mode}" object.` };
    }
    const parsed = {};
    for (const key of PALETTE_KEYS) {
      const fieldPath = `colors.${mode}.${key}`;
      if (!(key in modeColors)) {
        return { ok: false, error: `Missing "${fieldPath}".` };
      }
      const err = validateHexColor(modeColors[key], fieldPath);
      if (err) return { ok: false, error: err };
      parsed[key] = modeColors[key];
    }
    colors[mode] = parsed;
  }

  return { ok: true, theme: { version: SCHEMA_VERSION, name, colors } };
}

// ── Hex → CSS color helpers ──────────────────────────────────────────────────

/** Split a validated "#RRGGBB" or "#AARRGGBB" string into {r,g,b,a}. a is 0..1. */
export function hexToRgb(hex) {
  const body = hex.slice(1);
  if (body.length === 8) {
    // Android Color.parseColor order: alpha first.
    const a = parseInt(body.slice(0, 2), 16);
    const r = parseInt(body.slice(2, 4), 16);
    const g = parseInt(body.slice(4, 6), 16);
    const b = parseInt(body.slice(6, 8), 16);
    return { r, g, b, a: a / 255 };
  }
  const r = parseInt(body.slice(0, 2), 16);
  const g = parseInt(body.slice(2, 4), 16);
  const b = parseInt(body.slice(4, 6), 16);
  return { r, g, b, a: 1 };
}

/** A validated hex string → a CSS color value (passthrough for 6-digit, rgba() for 8-digit). */
export function hexToCssColor(hex) {
  const { r, g, b, a } = hexToRgb(hex);
  if (a >= 1) return `#${hex.slice(-6)}`;
  return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(4))})`;
}

/** A validated hex string's RGB, recombined with a NEW alpha (ignores its own alpha). */
export function withAlpha(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ── Schema key → CSS custom property mapping ─────────────────────────────────
//
// index.html's :root/[data-theme="light"] blocks define 8 tokens today:
//   --violet (fixed accent, same in both modes), --violet-glow, --bg, --surface,
//   --surface2, --border, --ink, --ink2. The schema's 8 keys map onto them as
//   follows (documented at length in HANDOFF.md):
//
//   primary        → --violet        (the instrument's core accent: toolbar
//                                      active state, RPM dial, brake, sliders,
//                                      stat readouts, walkthrough nav)
//   secondary      → --secondary     (new var; the library/browsing surface —
//                                      sort-chip active state, scan button)
//   tertiary       → --tertiary      (new var; optional/audiophile info
//                                      surfaces — feel-knob values, latency
//                                      readout)
//   background     → --bg
//   surface        → --surface
//   surfaceVariant → --surface2
//   onSurface      → --ink           (most UI text sits on --surface)
//   onBackground   → --ink-bg        (new var, used ONLY by .logo, which is
//                                      the one bit of text painted directly on
//                                      --bg; falls back to --ink when unset so
//                                      the built-in theme needs no new default)
//
// --border and --violet-glow/--ink2 have no direct schema slot:
//   --violet-glow and --ink2 ARE derived (alpha-blended from primary/onSurface,
//     matching the built-in convention: glow at .28 dark/.18 light, ink2 at
//     .48 dark/.5 light) — same kind of call the Fotoz agent made blending its
//     AccentPalette presets into concrete secondary/tertiary hex.
//   --border is deliberately left as the built-in low-alpha hairline (not
//     derived from the palette) — it's a structural separator, not a themed
//     color slot in the schema, and a low-alpha white/black line reads fine
//     over any custom background/surface.
export const CSS_VAR_MAP = {
  primary: '--violet',
  secondary: '--secondary',
  tertiary: '--tertiary',
  background: '--bg',
  surface: '--surface',
  surfaceVariant: '--surface2',
  onSurface: '--ink',
  onBackground: '--ink-bg',
};

const GLOW_ALPHA = { dark: 0.28, light: 0.18 };
const INK2_ALPHA = { dark: 0.48, light: 0.5 };

/** Every CSS custom property a custom theme may set — used to clear them all cleanly. */
export const THEME_CSS_VARS = [
  ...Object.values(CSS_VAR_MAP),
  '--violet-glow', '--ink2',
];

export const STORAGE_KEY = 'runout.customTheme';

/** Apply a validated theme's colors for one mode ('light'|'dark') as inline CSS vars. */
export function setThemeVars(theme, mode) {
  const c = theme.colors[mode];
  const style = document.documentElement.style;
  for (const [schemaKey, cssVar] of Object.entries(CSS_VAR_MAP)) {
    style.setProperty(cssVar, hexToCssColor(c[schemaKey]));
  }
  style.setProperty('--violet-glow', withAlpha(c.primary, GLOW_ALPHA[mode]));
  style.setProperty('--ink2', withAlpha(c.onSurface, INK2_ALPHA[mode]));
}

/** Remove every inline var a custom theme set, reverting to the built-in stylesheet defaults. */
export function clearThemeVars() {
  const style = document.documentElement.style;
  for (const v of THEME_CSS_VARS) style.removeProperty(v);
}

/** Persist a validated theme as the active custom theme. */
export function storeTheme(theme) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
}

/** Read back the stored custom theme, if any. Never throws — a corrupt entry reads as none. */
export function loadStoredTheme() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const result = parseTheme(raw);
  return result.ok ? result.theme : null;
}

/** Remove the stored custom theme (revert to the built-in default). */
export function clearStoredTheme() {
  localStorage.removeItem(STORAGE_KEY);
}
