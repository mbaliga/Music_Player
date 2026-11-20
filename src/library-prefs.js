// ─────────────────────────────────────────────────────────────────────────────
// library-prefs.js — user preferences for the music library (what to scan, what to hide).
//
//   import { libraryPrefs, DEFAULT_PREFS, clearLibraryCache } from './library-prefs.js';
//   libraryPrefs.get()                       -> frozen snapshot of all prefs
//   libraryPrefs.set({ minDurationSec: 45 }) -> merged + validated + persisted; returns the new snapshot
//   libraryPrefs.subscribe(fn)               -> fn(snapshot, changedKeys); returns unsubscribe
//   libraryPrefs.reset()                     -> back to defaults
//
// Storage: localStorage key `runout.library.prefs`, a versioned JSON envelope { v, prefs }.
// NEVER throws: blocked/absent storage, corrupt JSON, a newer version or hostile values all
// fall back to defaults (and invalid fields are repaired one by one). Pure + DOM-free: the
// storage object is injectable (tests, other hosts); the shared default instance lazily uses
// globalThis.localStorage.
//
// Prefs (all validated):
//   sources            { folder: bool, device: bool }  which sources feed the library
//   minDurationSec     number >= 0   tracks shorter than this are hidden (ringtones, voice notes); default 30
//   excludeFolders     string[]      folder names / path fragments hidden from the DEVICE scan
//   includeFolders     string[]      when non-empty, ONLY these folders are kept (device scan)
//   rescanOnResume     bool          rescan (throttled) when the app returns to the foreground
//   parseUntagged      bool          read tags from the file itself for tracks MediaStore has no tags for
// ─────────────────────────────────────────────────────────────────────────────

export const PREFS_KEY = 'runout.library.prefs';
export const PREFS_VERSION = 1;

export const DEFAULT_EXCLUDE_FOLDERS = Object.freeze([
  'WhatsApp Audio', 'WhatsApp Voice Notes', 'Ringtones', 'Notifications', 'Alarms',
  'Recordings', 'Voice Recorder', 'Call recordings', 'Podcasts',
]);

export const DEFAULT_PREFS = Object.freeze({
  sources: Object.freeze({ folder: true, device: true }),
  minDurationSec: 30,
  excludeFolders: DEFAULT_EXCLUDE_FOLDERS,
  includeFolders: Object.freeze([]),
  rescanOnResume: true,
  parseUntagged: true,
});

const MAX_LIST = 200;
const MAX_NAME = 200;

const cleanList = (v, fallback) => {
  if (!Array.isArray(v)) return fallback;
  const out = [];
  const seen = new Set();
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const s = x.trim().replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '').trim().slice(0, MAX_NAME);
    const k = s.toLowerCase();
    if (!s || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= MAX_LIST) break;
  }
  return Object.freeze(out);
};

/** Repair arbitrary input into a complete, valid prefs object (unknown keys dropped). */
export function normalizePrefs(raw, base = DEFAULT_PREFS) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const src = r.sources && typeof r.sources === 'object' ? r.sources : {};
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);
  const min = Number(r.minDurationSec);
  return Object.freeze({
    sources: Object.freeze({ folder: bool(src.folder, base.sources.folder), device: bool(src.device, base.sources.device) }),
    minDurationSec: Number.isFinite(min) && min >= 0 && min <= 3600 ? min : base.minDurationSec,
    excludeFolders: 'excludeFolders' in r ? cleanList(r.excludeFolders, base.excludeFolders) : base.excludeFolders,
    includeFolders: 'includeFolders' in r ? cleanList(r.includeFolders, base.includeFolders) : base.includeFolders,
    rescanOnResume: bool(r.rescanOnResume, base.rescanOnResume),
    parseUntagged: bool(r.parseUntagged, base.parseUntagged),
  });
}

function safeStorage(getter) {
  try { return getter() || null; } catch { return null; }
}

export function createLibraryPrefs({ storage, key = PREFS_KEY } = {}) {
  const store = () => (storage !== undefined ? storage : safeStorage(() => globalThis.localStorage));
  const subs = new Set();
  let cur = null;

  function load() {
    try {
      const raw = store()?.getItem(key);
      if (!raw) return DEFAULT_PREFS;
      const env = JSON.parse(raw);
      if (!env || env.v !== PREFS_VERSION) return DEFAULT_PREFS;   // unknown / newer version: ignore, never crash
      return normalizePrefs(env.prefs);
    } catch { return DEFAULT_PREFS; }
  }
  function save(p) {
    try { store()?.setItem(key, JSON.stringify({ v: PREFS_VERSION, prefs: p })); } catch { /* blocked storage: stay in memory */ }
  }
  const changedKeys = (a, b) => Object.keys(DEFAULT_PREFS).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  function emit(next, keys) {
    for (const fn of [...subs]) { try { fn(next, keys); } catch { /* a bad subscriber must not break the others */ } }
  }

  const api = {
    get() { if (!cur) cur = load(); return cur; },
    set(patch) {
      const prev = api.get();
      const p = patch && typeof patch === 'object' ? patch : {};
      const merged = { ...prev, ...p, sources: { ...prev.sources, ...(p.sources && typeof p.sources === 'object' ? p.sources : {}) } };
      const next = normalizePrefs(merged, prev);
      const keys = changedKeys(prev, next);
      if (!keys.length) return prev;
      cur = next;
      save(next);
      emit(next, keys);
      return next;
    },
    reset() {
      const prev = api.get();
      cur = DEFAULT_PREFS;
      try { store()?.removeItem(key); } catch { /* ignore */ }
      const keys = changedKeys(prev, cur);
      if (keys.length) emit(cur, keys);
      return cur;
    },
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      subs.add(fn);
      return () => subs.delete(fn);
    },
    /** Drop the in-memory copy so the next get() re-reads storage (tests, other tabs). */
    reload() { cur = null; return api.get(); },
  };
  return api;
}

/** The shared instance the app (and B's Settings page) uses. */
export const libraryPrefs = createLibraryPrefs();

// Things that hold derived library data register a clearer here (the device source registers its
// IndexedDB index). clearLibraryCache() runs them all plus the persisted folder index. Never throws.
const clearers = new Set();
export function registerCacheClearer(fn) { clearers.add(fn); return () => clearers.delete(fn); }

/**
 * Forget every persisted library artefact (folder index + saved folder handles + the device index) so the
 * next open starts from scratch. Prefs are NOT touched. Resolves to the number of clearers that succeeded.
 */
export async function clearLibraryCache({ clearFolderIndex } = {}) {
  let ok = 0;
  const tasks = [...clearers];
  if (clearFolderIndex !== null) {
    tasks.push(clearFolderIndex || (async () => { const m = await import('./library-store.js'); await m.clearAll(); }));
  }
  for (const t of tasks) {
    try { await t(); ok++; } catch { /* best effort */ }
  }
  return ok;
}
