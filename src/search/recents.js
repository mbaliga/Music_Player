// recents.js — recent searches. Pure model + storage helpers. Local only, capped, versioned, never throws.
//   key  runout.search.recents.v1    value  { v: 1, items: [string] }  newest first
import { fold } from './fold.js';

export const RECENTS_KEY = 'runout.search.recents.v1';
export const RECENTS_VERSION = 1;
export const MAX_RECENTS = 8;
export const MAX_LEN = 80;
export const MIN_LEN = 2;

const clean = (t) => (typeof t === 'string' ? t.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN) : '');

export function parseRecents(text) {
  try {
    if (typeof text !== 'string' || !text || text.length > 20000) return [];
    const o = JSON.parse(text);
    if (!o || o.v !== RECENTS_VERSION || !Array.isArray(o.items)) return [];
    return normalise(o.items);
  } catch { return []; }
}
function normalise(items) {
  const out = [], seen = new Set();
  for (const it of items) {
    const t = clean(it);
    if (t.length < MIN_LEN) continue;
    const k = fold(t);
    if (seen.has(k)) continue;
    seen.add(k); out.push(t);
    if (out.length >= MAX_RECENTS) break;
  }
  return out;
}
export const serializeRecents = (items) => JSON.stringify({ v: RECENTS_VERSION, items: normalise(items) });

/** Add (or move to the top) a search. `remember === false` leaves the list alone. Returns a NEW list. */
export function addRecent(items, text, { remember = true } = {}) {
  const base = normalise(Array.isArray(items) ? items : []);
  if (!remember) return base;
  const t = clean(text);
  if (t.length < MIN_LEN) return base;
  const k = fold(t);
  return normalise([t, ...base.filter((x) => fold(x) !== k)]);
}
export const removeRecent = (items, text) => { const k = fold(clean(text)); return normalise((Array.isArray(items) ? items : []).filter((x) => fold(x) !== k)); };

export function loadRecents(storage) { try { return parseRecents(storage ? storage.getItem(RECENTS_KEY) : null); } catch { return []; } }
export function saveRecents(storage, items) { try { if (!storage) return false; storage.setItem(RECENTS_KEY, serializeRecents(items)); return true; } catch { return false; } }
export function clearRecents(storage) { try { if (storage) storage.removeItem(RECENTS_KEY); return true; } catch { return false; } }
