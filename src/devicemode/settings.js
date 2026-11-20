// settings.js — Device mode settings: defaults, validators, persistence, subscribe. Pure (storage injected); never throws.
// Stored under its own key until Workstream B's `runout.settings.v1` hosts it (one-line migration: read the old key once, then drop it).
export const KEY = 'runout.devicemode.v1';
export const VERSION = 1;

/** The ONLY place the tunables live. `allowed` lists the legal values for enumerated settings. */
export const SPEC = Object.freeze({
  persistLock:         { def: false, type: 'bool' },                          // a fresh launch starts unlocked (safety rule)
  unlockMethod:        { def: 'hold', type: 'enum', allowed: ['hold', 'double', 'slide'] },
  fxPadWhileLocked:    { def: false, type: 'bool' },
  dimFrozen:           { def: true, type: 'bool' },                           // subtle contrast drop on frozen areas
  keepAwakeMin:        { def: 30, type: 'enum', allowed: [0, 5, 15, 30, 60] }, // 0 = Never
  neverTimeoutPlaying: { def: true, type: 'bool' },
  aodEnabled:          { def: true, type: 'bool' },
  aodIdleSec:          { def: 60, type: 'enum', allowed: [0, 30, 60, 300] },   // 0 = Off
  aodWake:             { def: 'double', type: 'enum', allowed: ['double', 'long', 'lockkey'] },
  aodBrightnessPct:    { def: 8, type: 'int', min: 1, max: 40 },
  aodLowRefresh:       { def: true, type: 'bool' },
  pixelShift:          { def: true, type: 'bool' },
  glowPct:             { def: 30, type: 'int', min: 10, max: 60 },              // AOD accent glow luminance, % of normal
});

export const DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(SPEC).map(([k, s]) => [k, s.def])));

/** One value -> a legal value (the default if it is not legal). */
export function coerce(key, v) {
  const s = SPEC[key];
  if (!s) return undefined;
  if (s.type === 'bool') return typeof v === 'boolean' ? v : s.def;
  if (s.type === 'enum') return s.allowed.includes(v) ? v : s.def;
  if (s.type === 'int') { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(s.max, Math.max(s.min, n)) : s.def; }
  return s.def;
}

/** Any junk -> a complete, valid settings object. Unknown keys are dropped. */
export function validate(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of Object.keys(SPEC)) out[k] = coerce(k, o[k]);
  return out;
}

export function load(storage) {
  try {
    const t = storage && storage.getItem(KEY);
    if (!t) return validate(null);
    const d = JSON.parse(t);
    return validate(d && d.v === VERSION ? d.s : null);
  } catch { return validate(null); }
}
export function save(storage, s) {
  try { if (!storage) return false; storage.setItem(KEY, JSON.stringify({ v: VERSION, s: validate(s) })); return true; } catch { return false; }
}

/** A small store: get() / set(patch) / reset() / subscribe(fn) -> unsubscribe. */
export function createSettings(storage) {
  let cur = load(storage);
  const subs = new Set();
  const emit = () => { for (const f of [...subs]) { try { f(cur); } catch { /* a bad subscriber must not break the rest */ } } };
  return {
    get: () => cur,
    set(patch) { cur = validate({ ...cur, ...(patch && typeof patch === 'object' ? patch : {}) }); save(storage, cur); emit(); return cur; },
    reset() { cur = validate(null); save(storage, cur); emit(); return cur; },
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
  };
}
