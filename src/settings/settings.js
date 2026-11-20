// settings.js — the one place the app's preferences are described, validated, migrated and stored. Pure: storage is injected, every
// access is try/caught, nothing here touches the DOM.
//
// STORAGE. One versioned blob, localStorage['runout.settings.v1'] = { v: 1, ...settings }. Four preferences already had their own keys
// that other modules read directly (the radio flag, the cassette haptics key, the layout key, the old theme key). Those stay in
// step by WRITE-THROUGH ("mirror"): setting one here writes the blob AND the old key. On load the old keys are read back
// ("read-through") so a change made by the old code path (e.g. the radio panel's own AI toggle) is not lost. See LEGACY below.
//
//   createSettingsStore({ storage }) -> { get(path?), set(path, value), reset(path?), refresh(), subscribe(fn), snapshot() }
//   defaults(), validate(raw), migrate(blob, legacyReader), PATHS, ACCENT_PRESETS (re-exported from theme.js)
import { ACCENT_PRESETS, resolveAccent } from '../theme.js';

export const SETTINGS_KEY = 'runout.settings.v1';
export const SETTINGS_VERSION = 1;
export { ACCENT_PRESETS };

const THEMES = ['dark', 'oled', 'light'];
const LAYOUTS = ['compact', 'utilitarian', 'cinematic'];
const TEXT = ['small', 'default', 'large'];
const MOTION = ['system', 'reduce'];
const RPMS = [33.333, 45, 78];

/** Field table: path -> { type, values?, default, validate(v) -> value|undefined }. Order is the order the Settings page uses. */
export const FIELDS = Object.freeze({
  'appearance.theme':      { type: 'enum', values: THEMES, default: 'oled' },
  'appearance.accent':     { type: 'accent', default: 'violet' },
  'appearance.textSize':   { type: 'enum', values: TEXT, default: 'default' },
  'appearance.reduceMotion': { type: 'enum', values: MOTION, default: 'system' },
  'turntable.layout':      { type: 'enum', values: LAYOUTS, default: 'compact' },
  'haptics':               { type: 'bool', default: true },
  'playback.defaultRpm':   { type: 'rpm', values: RPMS, default: 33.333 },
  'playback.audiophile':   { type: 'bool', default: false },
  'radio.aiStations':      { type: 'bool', default: false },
  'privacy.rememberSearches': { type: 'bool', default: true },
});
export const PATHS = Object.freeze(Object.keys(FIELDS));

/** Check one value against its field. Returns the (normalised) value, or undefined when it is not acceptable. Never throws. */
export function checkField(path, v) {
  const f = FIELDS[path];
  if (!f) return undefined;
  try {
    if (f.type === 'enum') return f.values.includes(v) ? v : undefined;
    if (f.type === 'bool') return typeof v === 'boolean' ? v : undefined;
    if (f.type === 'rpm') { const n = Number(v); const hit = typeof v === 'number' || typeof v === 'string' ? f.values.find((x) => Math.abs(x - n) < 0.4) : undefined; return hit; }
    if (f.type === 'accent') { const a = resolveAccent(v); return a ? a.id : undefined; }
  } catch { /* fall through */ }
  return undefined;
}

const getPath = (o, p) => p.split('.').reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), o);
function setPath(o, p, v) { const ks = p.split('.'); let a = o; for (let i = 0; i < ks.length - 1; i++) a = a[ks[i]] = a[ks[i]] && typeof a[ks[i]] === 'object' ? a[ks[i]] : {}; a[ks[ks.length - 1]] = v; }

export function defaults() { const o = { v: SETTINGS_VERSION }; for (const p of PATHS) setPath(o, p, FIELDS[p].default); return o; }

/** Any parsed JSON -> a complete, valid settings object (unknown keys dropped, bad values -> defaults). */
export function validate(raw) {
  const out = defaults();
  if (!raw || typeof raw !== 'object') return out;
  for (const p of PATHS) { const v = checkField(p, getPath(raw, p)); if (v !== undefined) setPath(out, p, v); }
  return out;
}

// ── the four keys other modules still read ──────────────────────────────────────────────────────────────────────────────
// read(raw, current) -> value | undefined (undefined = nothing to import); write(value) -> string | null (null = remove the key)
// authoritative: the old key is the truth whenever it is present or absent (the radio panel's toggle writes it directly).
const modeOf = (t) => (t === 'light' ? 'light' : 'dark');
export const LEGACY = Object.freeze([
  { path: 'appearance.theme', key: 'runout.theme',
    read: (raw, cur) => (raw === 'light' ? 'light' : raw === 'dark' ? (modeOf(cur) === 'dark' ? cur : 'oled') : undefined),   // an old 'dark' was the OLED black palette
    write: (v) => modeOf(v) },
  { path: 'turntable.layout', key: 'runout.layout.v2', read: (raw) => (LAYOUTS.includes(raw) ? raw : undefined), write: (v) => v },
  { path: 'haptics', key: 'runout.cassette.haptics', read: (raw) => (raw === '1' ? true : raw === '0' ? false : undefined), write: (v) => (v ? '1' : '0') },
  { path: 'radio.aiStations', key: 'runout.flag.radio.ai', authoritative: true, read: (raw) => raw === '1', write: (v) => (v ? '1' : null) },
]);

const safeGet = (st, k) => { try { return st ? st.getItem(k) : null; } catch { return null; } };
const safeSet = (st, k, v) => { try { if (!st) return false; if (v === null) st.removeItem(k); else st.setItem(k, v); return true; } catch { return false; } };

/** Parse the stored blob. null when absent / unreadable / a different version (then migration starts from defaults + old keys). */
export function parseBlob(text) {
  try {
    if (typeof text !== 'string' || !text || text.length > 20000) return null;
    const o = JSON.parse(text);
    return o && typeof o === 'object' && o.v === SETTINGS_VERSION ? o : null;
  } catch { return null; }
}

/** blob (or null) + a reader for the old keys -> { settings, changed } where changed lists paths imported from old keys. */
export function migrate(blob, readLegacy) {
  const settings = validate(blob);
  const changed = [];
  for (const l of LEGACY) {
    let raw = null; try { raw = readLegacy(l.key); } catch { raw = null; }
    const cur = getPath(settings, l.path);
    let v = l.read(raw, cur);
    if (v === undefined) continue;
    v = checkField(l.path, v);
    if (v === undefined || v === cur) continue;
    setPath(settings, l.path, v); changed.push(l.path);
  }
  return { settings, changed };
}

export function createSettingsStore({ storage = null } = {}) {
  const subs = new Set();
  const read = () => {
    const blob = parseBlob(safeGet(storage, SETTINGS_KEY));
    const { settings } = migrate(blob, (k) => safeGet(storage, k));
    return { settings, had: !!blob };
  };
  let { settings, had } = read();
  const persist = () => { safeSet(storage, SETTINGS_KEY, JSON.stringify(settings)); };
  const mirror = (path) => { const l = LEGACY.find((x) => x.path === path); if (l) safeSet(storage, l.key, l.write(getPath(settings, path))); };
  const emit = (path) => { for (const f of [...subs]) { try { f(settings, path); } catch (e) { try { console.error('settings subscriber', e); } catch { /* */ } } } };
  // first run (or a blob from a newer/older version): write what we resolved so the next load is a plain read
  if (!had) { persist(); for (const l of LEGACY) mirror(l.path); }

  const api = {
    /** The whole settings object (a copy), or one value by path. */
    get(path) { return path ? getPath(settings, path) : JSON.parse(JSON.stringify(settings)); },
    snapshot() { return JSON.parse(JSON.stringify(settings)); },
    /** Validate + store + mirror + notify. Returns true when the value was accepted. */
    set(path, value) {
      const v = checkField(path, value);
      if (v === undefined) return false;
      if (getPath(settings, path) === v) return true;
      setPath(settings, path, v);
      persist(); mirror(path); emit(path);
      return true;
    },
    reset(path) {
      const paths = path ? [path] : PATHS;
      for (const p of paths) if (FIELDS[p]) { setPath(settings, p, FIELDS[p].default); mirror(p); }
      persist(); emit(path || '*');
    },
    /** Re-read the old keys (call when the Settings page opens): a change made by old code paths shows up. */
    refresh() {
      const r = read();
      const changed = PATHS.filter((p) => getPath(r.settings, p) !== getPath(settings, p));
      if (changed.length) { settings = r.settings; persist(); for (const p of changed) emit(p); }
      return changed;
    },
    subscribe(fn) { if (typeof fn !== 'function') return () => {}; subs.add(fn); return () => subs.delete(fn); },
  };
  return api;
}
