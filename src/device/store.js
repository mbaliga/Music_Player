// store.js — IndexedDB glue for the persisted DEVICE index (db "runout-device"). Thin and best-effort like
// library-store.js: every call resolves (null/false on failure), nothing throws. The document is
//   { version, generation, savedAt, tracks: [ stored device tracks (records.toStored) ] }
// Kept apart from the folder index (libindex.js) on purpose: that format stays untouched, and a device
// track needs no "re-link" (its bytes are one native call away), so it must not enter that format.
export const DEVICE_DB = 'runout-device';
export const DEVICE_INDEX_VERSION = 1;

function open(idb) {
  return new Promise((resolve) => {
    try {
      if (!idb) return resolve(null);
      const req = idb.open(DEVICE_DB, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('kv'); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}
function run(db, mode, fn) {
  return new Promise((resolve) => {
    try {
      const t = db.transaction('kv', mode);
      let result;
      const r = fn(t.objectStore('kv'));
      if (r) r.onsuccess = () => { result = r.result; };
      t.oncomplete = () => resolve(result === undefined ? true : result);
      t.onerror = t.onabort = () => resolve(null);
    } catch { resolve(null); }
  });
}

export function createDeviceStore({ indexedDB: idb = globalThis.indexedDB } = {}) {
  return {
    async save(doc) {
      const db = await open(idb); if (!db) return false;
      const ok = await run(db, 'readwrite', (s) => s.put(doc, 'index'));
      db.close(); return ok !== null;
    },
    async load() {
      const db = await open(idb); if (!db) return null;
      const doc = await run(db, 'readonly', (s) => s.get('index'));
      db.close();
      if (!doc || doc === true || doc.version !== DEVICE_INDEX_VERSION || !Array.isArray(doc.tracks)) return null;
      return doc;
    },
    async clear() {
      const db = await open(idb); if (!db) return false;
      const ok = await run(db, 'readwrite', (s) => s.clear());
      db.close(); return ok !== null;
    },
  };
}

/** In-memory store with the same shape (tests; also the fallback when IndexedDB is unavailable). */
export function createMemoryStore() {
  let doc = null;
  return {
    async save(d) { doc = JSON.parse(JSON.stringify(d)); return true; },
    async load() { return doc ? JSON.parse(JSON.stringify(doc)) : null; },
    async clear() { doc = null; return true; },
  };
}
