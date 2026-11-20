// persist.js — localStorage round trip for the FX state. Versioned, sanitised, and it NEVER throws (private windows,
// blocked storage, corrupt JSON and quota errors all degrade to "no saved state").
import { sanitizeFx, defaultFx, FX_VERSION } from './modes.js';

export const FX_STORAGE_KEY = 'runout.fx.v1';

export function serializeFx(st) { return JSON.stringify(sanitizeFx(st)); }

/** Parse a stored string into a valid state. Anything unreadable, or from a different version, gives the defaults. */
export function parseFx(text) {
  try {
    if (typeof text !== 'string' || text.length === 0 || text.length > 4096) return defaultFx();
    const o = JSON.parse(text);
    if (!o || typeof o !== 'object' || o.v !== FX_VERSION) return defaultFx();
    return sanitizeFx(o);
  } catch { return defaultFx(); }
}

const store = (s) => { try { return s || globalThis.localStorage || null; } catch { return null; } };

export function loadFx(storage) {
  try { const s = store(storage); return parseFx(s ? s.getItem(FX_STORAGE_KEY) : null); } catch { return defaultFx(); }
}
export function saveFx(st, storage) {
  try { const s = store(storage); if (!s) return false; s.setItem(FX_STORAGE_KEY, serializeFx(st)); return true; } catch { return false; }
}
