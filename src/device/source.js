// ─────────────────────────────────────────────────────────────────────────────
// source.js — the DEVICE library source: permission, scan pipeline, persistence, change detection.
//
//   const dev = createDeviceSource({ native });          // native = the Capacitor DeviceLibrary plugin (or a fake)
//   dev.isAvailable()            false when native is null (web / desktop / tests: the folder picker stays)
//   await dev.restore()          -> tracks persisted by the last scan, playable immediately (first paint)
//   await dev.refreshPermission()/requestPermission()/openSettings()      (never loops, see below)
//   await dev.scan({ onProgress, onTracks, signal, force })  -> { added, updated, removed, total, unchanged, cancelled }
//   dev.tracks()                 current merged list of device tracks (unfiltered; library-model filters)
//   dev.onChange(fn)             fn(tracks) after every batch / scan end / tag pass chunk
//   dev.status                   scanStatus (status.js)
//   dev.getArt(trackOrAlbum, size) -> object URL | null (cached)
//   dev.startWatching()/attachResume(...)   MediaStore observer + rescan on app resume (throttled)
//
// SCAN = diff, not rebuild. One cheap native call returns every row's [id, size, modified] ("signatures"); the
// diff against the persisted index gives exactly which rows to fetch (new or changed) and which to drop
// (deleted). A cheap `generation` token short-circuits the whole thing when nothing changed. Rows are fetched
// and mapped in batches with a yield between batches (scheduler.yield), so 10k+ tracks never block the page;
// progress is { found, processed, total }. An aborted scan keeps what it fetched and is resumed by the next one.
//
// PERMISSION never loops: requestPermission() asks the OS at most once per call and only while the OS says it
// still can ('prompt' / 'prompt-with-rationale'); when it says 'denied' (permanent) it makes no native call and
// reports phase 'blocked', which the UI answers with "Open settings". Coming back from settings is picked up by
// refreshPermission() on app resume.
// ─────────────────────────────────────────────────────────────────────────────
import { mapRow, isAudioRow, applyTags, toStored, fromStored } from './records.js';
import { DeviceFile } from './device-file.js';
import { createScanStatus } from './status.js';
import { createDeviceStore, DEVICE_INDEX_VERSION } from './store.js';
import { libraryPrefs, registerCacheClearer } from '../library-prefs.js';
import { readFileTags } from '../tags.js';

export const defaultScheduler = {
  yield() {
    const s = globalThis.scheduler;
    if (s && typeof s.yield === 'function') return s.yield();
    return new Promise((r) => setTimeout(r, 0));
  },
};

export function phaseForPermission(state) {
  if (state === 'granted') return 'granted';
  if (state === 'prompt-with-rationale') return 'denied';   // refused once; Android will still show the dialog again
  if (state === 'denied') return 'blocked';                 // refused with "don't ask again": only app settings can fix it
  return 'needs-permission';                                // 'prompt' (never asked) and anything unexpected
}

export function parseSignatures(flat) {
  const m = new Map();
  if (!Array.isArray(flat)) return m;
  for (let i = 0; i + 2 < flat.length; i += 3) m.set(flat[i], { size: flat[i + 1], modified: flat[i + 2] });
  return m;
}

const errText = (e) => String(e?.message || e || 'unknown error').slice(0, 200);

export function createDeviceSource({
  native,
  prefs = libraryPrefs,
  store = native ? createDeviceStore() : null,
  status = createScanStatus(),
  scheduler = defaultScheduler,
  readTags = readFileTags,
  batchSize = 400,
  tagConcurrency = 2,
  chunkBytes,
  limiter,
  minRescanGapMs = 30000,
  now = () => Date.now(),
  document: doc = globalThis.document,
} = {}) {
  const listeners = new Set();
  const index = new Map();          // mediaId -> track
  const skipped = new Map();        // mediaId -> "size:modified" for rows we deliberately ignore (non-audio)
  let generation = '';
  let permission = 'unknown';
  let scanning = null;              // in-flight scan promise
  let dirty = false;                // a libraryChanged arrived while scanning: rescan once afterwards
  let askInFlight = null;
  let lastScanAt = 0;
  let observerOn = false;
  const stats = { scans: 0, fetched: 0, tagFiles: 0, tagReads: 0, yields: 0 };
  const artCache = new Map();

  const makeFile = (t) => new DeviceFile({ backend: native, id: t.mediaId, name: String(t.path || '').split('/').pop(), size: t.size, type: t.mime, lastModified: (t.modified || 0) * 1000, chunkBytes, limiter });
  const list = () => [...index.values()];
  const emit = () => { const l = list(); for (const fn of [...listeners]) { try { fn(l); } catch { /* ignore */ } } };
  const yieldNow = async () => { stats.yields++; await scheduler.yield(); };

  async function persist(partial = false) {
    if (!store) return false;
    return store.save({ version: DEVICE_INDEX_VERSION, generation: partial ? '' : generation, savedAt: now(), tracks: list().map(toStored), skipped: [...skipped] });
  }

  function setPermission(state) {
    permission = state;
    const p = phaseForPermission(state);
    if (p === 'granted') {
      if (['needs-permission', 'denied', 'blocked', 'unavailable', 'error'].includes(status.get().phase)) status.set({ phase: 'idle', permission: state });
      else status.set({ permission: state });
    } else status.set({ phase: p, permission: state });
    return p;
  }

  const api = {
    name: 'device',
    status,
    stats: () => ({ ...stats }),
    isAvailable: () => !!native,
    tracks: list,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** Load the persisted index. Tracks come back with live DeviceFiles: no re-link step. */
    async restore() {
      if (!native || !store) return [];
      if (index.size) return list();
      const doc2 = await store.load();
      if (!doc2) return [];
      for (const rec of doc2.tracks) { const t = fromStored(rec, { makeFile }); if (t) index.set(t.mediaId, t); }
      for (const [k, v] of Array.isArray(doc2.skipped) ? doc2.skipped : []) skipped.set(k, v);
      generation = typeof doc2.generation === 'string' ? doc2.generation : '';
      lastScanAt = Number(doc2.savedAt) || 0;
      status.set({ trackCount: index.size, lastScanAt });
      emit();
      return list();
    },

    // ── permission ────────────────────────────────────────────────────────
    async refreshPermission() {
      if (!native) { status.set({ phase: 'unavailable' }); return 'unavailable'; }
      try {
        const r = await native.permissionStatus();
        return setPermission(r?.state || 'prompt');
      } catch (e) { status.set({ phase: 'error', error: errText(e) }); return 'error'; }
    },
    /** Ask once. Resolves to 'granted' | 'denied' | 'blocked' | 'needs-permission' | 'error'. */
    requestPermission() {
      if (!native) return Promise.resolve('unavailable');
      if (askInFlight) return askInFlight;
      askInFlight = (async () => {
        try {
          const cur = phaseForPermission((await native.permissionStatus())?.state);
          if (cur === 'granted' || cur === 'blocked') return setPermission(cur === 'blocked' ? 'denied' : 'granted');   // blocked: do NOT call the OS again
          const r = await native.requestAccess();
          return setPermission(r?.state || 'denied');
        } catch (e) { status.set({ phase: 'error', error: errText(e) }); return 'error'; }
        finally { askInFlight = null; }
      })();
      return askInFlight;
    },
    async openSettings() { try { await native?.openSettings(); return true; } catch { return false; } },

    // ── change detection ──────────────────────────────────────────────────
    async generation() { return (await native.generation())?.generation || ''; },

    /** Subscribe to the MediaStore observer (debounced natively). Returns a stop function. */
    async startWatching(onChange) {
      if (!native || observerOn) return () => {};
      let handle = null;
      try {
        handle = await native.addListener('libraryChanged', () => {
          // A change that lands while a scan runs may not be in that scan's signatures: remember it, rescan once when the scan ends.
          if (scanning) { dirty = true; return; }
          try { onChange ? onChange() : api.scan().catch(() => {}); } catch { /* ignore */ }
        });
        await native.startObserving();
        observerOn = true;
      } catch { return () => {}; }
      return () => { observerOn = false; try { handle?.remove?.(); native.stopObserving(); } catch { /* ignore */ } };
    },

    /** Rescan when the app returns to the foreground, throttled; honours prefs.rescanOnResume. Returns a detach function. */
    attachResume({ target = doc, win = globalThis, onScan } = {}) {
      if (!native || !target || typeof target.addEventListener !== 'function') return () => {};
      const handler = async () => {
        if (target.visibilityState && target.visibilityState !== 'visible') return;
        if (!prefs.get().rescanOnResume || !prefs.get().sources.device) return;
        if (permission !== 'granted') {                    // perhaps the user just allowed it in app settings
          if (await api.refreshPermission() !== 'granted') return;
        }
        if (scanning || now() - lastScanAt < minRescanGapMs) return;
        try { const r = await api.scan(); onScan?.(r); } catch { /* status already carries the error */ }
      };
      target.addEventListener('visibilitychange', handler);
      win?.addEventListener?.('focus', handler);
      return () => { target.removeEventListener('visibilitychange', handler); win?.removeEventListener?.('focus', handler); };
    },

    // ── scan ──────────────────────────────────────────────────────────────
    scan(opts = {}) {
      if (scanning) return scanning;
      scanning = runScan(opts).finally(() => {
        scanning = null;
        if (dirty) { dirty = false; Promise.resolve().then(() => api.scan().catch(() => {})); }   // one trailing rescan for changes seen mid-scan
      });
      return scanning;
    },
    get scanning() { return !!scanning; },

    async clear() {
      index.clear(); skipped.clear(); generation = ''; lastScanAt = 0;
      for (const u of artCache.values()) { try { if (u) URL.revokeObjectURL(u); } catch { /* ignore */ } }
      artCache.clear();
      await store?.clear();
      status.set({ trackCount: 0, lastScanAt: 0, found: 0, processed: 0, total: 0 });
      emit();
    },

    /**
     * Album art as an object URL (or null). `target` = a device track, a MediaStore id, or a shelf item
     * ({ tracks }) (the first few tracks are tried). Cached per MediaStore album.
     */
    async getArt(target, size = 256) {
      if (!native) return null;
      const cand = target && Array.isArray(target.tracks) ? target.tracks : target && typeof target === 'object' ? [target] : [{ mediaId: target }];
      for (const t of cand.slice(0, 3)) {
        const id = t?.mediaId;
        if (!Number.isFinite(id)) continue;
        const key = `${t.albumMediaId || `t${id}`}@${size}`;
        if (artCache.has(key)) { const u = artCache.get(key); if (u) return u; continue; }
        let url = null;
        try {
          const r = await native.art({ id, size });
          if (r?.data) {
            const bin = atob(r.data); const u8 = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            url = URL.createObjectURL(new Blob([u8], { type: r.mime || 'image/jpeg' }));
          }
        } catch { url = null; }
        artCache.set(key, url);
        if (url) return url;
      }
      return null;
    },
  };

  async function runScan({ onProgress, onTracks, signal, force = false } = {}) {
    const summary = { added: 0, updated: 0, removed: 0, total: index.size, unchanged: false, cancelled: false };
    if (!native) return summary;
    stats.scans++;
    try {
      if (permission !== 'granted') {
        const p = await api.refreshPermission();
        if (p !== 'granted') return summary;
      }
      const gen = await api.generation();
      if (!force && generation && gen === generation && index.size) {
        summary.unchanged = true; lastScanAt = now();
        status.set({ phase: status.get().phase === 'scanning' ? 'idle' : status.get().phase, lastScanAt, trackCount: index.size });
        return summary;
      }
      status.set({ phase: 'scanning', found: index.size, processed: 0, total: 0, error: '' });
      const sig = parseSignatures((await native.signatures())?.sig);
      const total = sig.size;
      // Deleted rows (and skipped rows that vanished).
      for (const id of [...index.keys()]) if (!sig.has(id)) { index.delete(id); summary.removed++; }
      for (const id of [...skipped.keys()]) if (!sig.has(id)) skipped.delete(id);
      const todo = [];
      for (const [id, s] of sig) {
        const have = index.get(id);
        if (have) { if (have.size === s.size && have.modified === s.modified) continue; }
        else if (skipped.get(id) === `${s.size}:${s.modified}`) continue;
        todo.push(id);
      }
      let processed = total - todo.length;
      status.set({ found: total, total, processed });
      onProgress?.({ found: total, processed, total });
      if (summary.removed) emit();

      for (let i = 0; i < todo.length; i += batchSize) {
        if (signal?.aborted) { summary.cancelled = true; break; }
        const ids = todo.slice(i, i + batchSize);
        const r = await native.records({ ids });
        const batch = [];
        for (const row of Array.isArray(r?.items) ? r.items : []) {
          if (!isAudioRow(row)) { skipped.set(row.id, `${row.size}:${row.modified}`); continue; }
          const t = mapRow(row, { makeFile });
          if (index.has(row.id)) summary.updated++; else summary.added++;
          index.set(row.id, t);
          batch.push(t);
        }
        stats.fetched += ids.length;
        processed += ids.length;
        status.set({ processed, trackCount: index.size });
        onProgress?.({ found: total, processed, total });
        onTracks?.(batch);
        emit();
        await yieldNow();
      }
      summary.total = index.size;
      if (!summary.cancelled) { generation = gen; lastScanAt = now(); }
      status.set({ phase: 'idle', trackCount: index.size, lastScanAt: now(), processed: total, total });
      await persist(summary.cancelled);
      emit();
      if (!summary.cancelled) await tagPass(signal);
    } catch (e) {
      summary.error = errText(e);
      status.set({ phase: e?.code === 'denied' || /permission/i.test(errText(e)) ? 'needs-permission' : 'error', error: errText(e) });
      if (summary.error && status.get().phase === 'needs-permission') { permission = 'unknown'; }
    }
    return summary;
  }

  /** Read the file's own tags for tracks MediaStore had nothing for (artist AND album blank). Background, 2 at a time. */
  async function tagPass(signal) {
    if (!prefs.get().parseUntagged) return;
    const todo = list().filter((t) => t.needsTags && t.file);
    if (!todo.length) return;
    status.set({ phase: 'tagging', tagged: 0, taggingTotal: todo.length });
    let done = 0, next = 0;
    const lane = async () => {
      while (next < todo.length && !signal?.aborted) {
        const t = todo[next++];
        const before = t.file.reads;
        let meta = null;
        try { meta = await readTags(t.file, { duration: false }); } catch { meta = null; }
        stats.tagFiles++; stats.tagReads += t.file.reads - before;
        if (index.get(t.mediaId) === t) index.set(t.mediaId, applyTags(t, meta || {}));
        done++;
        if (done % 25 === 0) { status.set({ tagged: done }); emit(); await yieldNow(); }
      }
    };
    await Promise.all(Array.from({ length: tagConcurrency }, lane));
    status.set({ phase: 'idle', tagged: done, trackCount: index.size });
    await persist(false);
    emit();
  }

  registerCacheClearer(() => api.clear());
  if (!native) status.set({ phase: 'unavailable' });
  return api;
}
