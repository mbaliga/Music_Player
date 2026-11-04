// ─────────────────────────────────────────────────────────────────────────────
// library-store.js — IndexedDB glue for the persisted library index + folder
// handles. Browser-only and deliberately thin: every decision lives in the pure
// libindex.js. Every call is best-effort (private windows, blocked storage,
// WebViews without IndexedDB or without File System Access): failures resolve to
// null/false, never throw, and the app simply behaves as it did before.
//
// Stores (db "runout-library", v1):
//   kv      key 'index'  -> libindex.js document (metadata only, no audio)
//   handles key = n      -> { name, handle }  (FileSystemDirectoryHandle)
//
// Permission safety: a stored handle is only ever READ with queryPermission().
// requestPermission() is called solely from a user gesture (the Re-link button),
// never at startup.
// ─────────────────────────────────────────────────────────────────────────────

const DB = 'runout-library';

function open() {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('kv');
        req.result.createObjectStore('handles', { autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve) => {
    try {
      const t = db.transaction(store, mode);
      let result;
      const r = fn(t.objectStore(store));
      if (r) r.onsuccess = () => { result = r.result; };
      t.oncomplete = () => resolve(result === undefined ? true : result);
      t.onerror = t.onabort = () => resolve(null);
    } catch { resolve(null); }
  });
}

export async function saveIndex(doc) {
  const db = await open();
  if (!db) return false;
  const ok = await tx(db, 'kv', 'readwrite', (s) => s.put(doc, 'index'));
  db.close();
  return ok !== null;
}

export async function loadIndex() {
  const db = await open();
  if (!db) return null;
  const doc = await tx(db, 'kv', 'readonly', (s) => s.get('index'));
  db.close();
  return doc === true ? null : doc;
}

/** Remember a picked folder. Skips handles we already hold (isSameEntry). */
export async function saveHandle(handle) {
  const db = await open();
  if (!db) return false;
  try {
    const existing = await loadHandles(db);
    for (const e of existing) {
      try { if (await e.handle.isSameEntry(handle)) { db.close(); return true; } } catch {}
    }
  } catch {}
  const ok = await tx(db, 'handles', 'readwrite', (s) => s.add({ name: handle.name, handle }));
  db.close();
  return ok !== null;
}

/** [{ name, handle }] (pass an open db to reuse it). */
export async function loadHandles(db0) {
  const db = db0 || await open();
  if (!db) return [];
  const all = await tx(db, 'handles', 'readonly', (s) => s.getAll());
  if (!db0) db.close();
  return Array.isArray(all) ? all.filter((e) => e && e.handle) : [];
}

export async function clearAll() {
  const db = await open();
  if (!db) return;
  await tx(db, 'kv', 'readwrite', (s) => s.clear());
  await tx(db, 'handles', 'readwrite', (s) => s.clear());
  db.close();
}
