// ─────────────────────────────────────────────────────────────────────────────
// util.js — tiny shared helpers for the pure radio core.
//
// No DOM, no timers, no network, no Date.now(), no Math.random(): time and
// randomness are always injected (a clock value, a seed) so every test is
// deterministic. See README.md "pure vs adapter".
// ─────────────────────────────────────────────────────────────────────────────

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isStr = (v) => typeof v === 'string';
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const isInt = (v) => Number.isInteger(v);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const isIso = (v) => isStr(v) && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v) && Number.isFinite(Date.parse(v));

/** FNV-1a 32-bit string hash -> uint32 (seed derivation from ids). */
export function hashSeed(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** mulberry32: small seedable PRNG, () => [0,1). Same seed, same sequence, every platform. */
export function mulberry32(seed) {
  let a = (typeof seed === 'string' ? hashSeed(seed) : seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lowercase, strip diacritics/punctuation, collapse spaces: for fuzzy comparisons. */
export const normText = (s) => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Error collector for the hand-written validators. Every method returns whether the
 * value was acceptable, never throws, and appends "path: message" strings.
 */
export function checker() {
  const errors = [];
  const err = (path, msg) => { errors.push(`${path}: ${msg}`); return false; };
  const absent = (v, o) => v === undefined || (o.nullable && v === null);
  const c = {
    errors,
    err,
    result: () => ({ ok: errors.length === 0, errors }),
    obj(v, path, o = {}) {
      if (absent(v, o)) return o.optional || o.nullable ? true : err(path, 'required');
      return isObj(v) ? true : err(path, 'must be an object');
    },
    str(v, path, o = {}) {
      if (absent(v, o)) return o.optional || o.nullable ? true : err(path, 'required');
      if (!isStr(v)) return err(path, 'must be a string');
      if (v.length < (o.min ?? 0)) return err(path, o.min === 1 ? 'must not be empty' : `shorter than ${o.min}`);
      if (v.length > (o.max ?? Infinity)) return err(path, `longer than ${o.max} chars`);
      return true;
    },
    num(v, path, o = {}) {
      if (absent(v, o)) return o.optional || o.nullable ? true : err(path, 'required');
      if (!isNum(v)) return err(path, 'must be a finite number');
      if (o.int && !isInt(v)) return err(path, 'must be an integer');
      if (o.min !== undefined && v < o.min) return err(path, `below minimum ${o.min}`);
      if (o.max !== undefined && v > o.max) return err(path, `above maximum ${o.max}`);
      return true;
    },
    bool(v, path, o = {}) {
      if (absent(v, o)) return o.optional || o.nullable ? true : err(path, 'required');
      return typeof v === 'boolean' ? true : err(path, 'must be a boolean');
    },
    iso(v, path, o = {}) {
      if (absent(v, o)) return o.optional || o.nullable ? true : err(path, 'required');
      return isIso(v) ? true : err(path, 'must be an ISO date-time string');
    },
    oneOf(v, path, list, o = {}) {
      if (absent(v, o)) return o.optional || o.nullable ? true : err(path, 'required');
      return list.includes(v) ? true : err(path, `must be one of ${list.join('|')}`);
    },
    arr(v, path, o = {}) {
      if (absent(v, o)) return o.optional || o.nullable ? true : err(path, 'required');
      if (!Array.isArray(v)) return err(path, 'must be an array');
      // length problems are reported but the array is still returned for item checks
      if (v.length < (o.min ?? 0)) err(path, `needs at least ${o.min} item(s)`);
      if (v.length > (o.max ?? Infinity)) err(path, `more than ${o.max} items`);
      return true;
    },
    strArr(v, path, o = {}) {
      if (!c.arr(v, path, o) || !Array.isArray(v)) return false;
      let ok = true;
      v.forEach((x, i) => { if (!isStr(x)) ok = err(`${path}[${i}]`, 'must be a string'); });
      return ok;
    },
    version(v, path, expected = 1) {
      if (v === undefined) return err(`${path}.schemaVersion`, 'required');
      return v === expected ? true : err(`${path}.schemaVersion`, `unsupported version ${JSON.stringify(v)} (expected ${expected})`);
    },
    /** merge a nested validator result under a path prefix */
    nest(path, res) {
      for (const e of res.errors) errors.push(e.startsWith('$:') ? `${path}${e.slice(1)}` : `${path}.${e.replace(/^\$\./, '')}`);
      return res.ok;
    },
  };
  return c;
}

/** Wrap a validator so a bug or hostile input can never throw out of it. */
export function guarded(fn) {
  return (v) => {
    try { return fn(v); }
    catch (e) { return { ok: false, errors: [`validator failed: ${e && e.message ? e.message : String(e)}`] }; }
  };
}
