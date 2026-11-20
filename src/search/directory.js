// directory.js — the ONLY network use of Search: the internet radio directory (Radio Browser), asked only when the user taps
// 'Search the internet radio directory for "..."'. Nothing here runs while typing, at startup, or when offline.
//
//   const dir = createDirectorySearch({ fetchImpl, isOnline })       (no request is made by creating it)
//   await dir.search('jazz')  -> { ok: true, stations: [Station], server } | { ok: false, kind: 'offline'|'unreachable'|'empty-query', error }
//
// It reuses src/radio.js unchanged (discoverServers, searchStations, parseStations: HTTPS streams only, no HLS, failing stations dropped).
import { discoverServers, searchStations } from '../radio.js';

export const DIRECTORY_LIMIT = 20;
export const OFFLINE_NOTE = 'You are offline. The internet radio directory needs a connection; everything above still works.';
export const clean = (q) => (typeof q === 'string' ? q.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) : '');

export function createDirectorySearch({ fetchImpl = (u, o) => fetch(u, o), isOnline = () => (typeof navigator === 'undefined' || navigator.onLine !== false), timeoutMs = 6000 } = {}) {
  let servers = null;
  let seq = 0;
  return {
    /** Latest call wins: an older response that arrives late resolves with { ok: false, kind: 'superseded' }. */
    async search(text) {
      const name = clean(text);
      if (!name) return { ok: false, kind: 'empty-query', error: 'Type something to search for.' };
      if (!isOnline()) return { ok: false, kind: 'offline', error: OFFLINE_NOTE };
      const mine = ++seq;
      try {
        if (!servers) servers = await discoverServers(fetchImpl);
        const r = await searchStations(fetchImpl, servers || [], { name, limit: DIRECTORY_LIMIT }, { isOnline, timeoutMs });
        if (mine !== seq) return { ok: false, kind: 'superseded', error: '' };
        if (!r.ok) return { ok: false, kind: r.kind, error: r.kind === 'offline' ? OFFLINE_NOTE : 'The internet radio directory is not reachable right now.' };
        return { ok: true, stations: r.stations.slice(0, DIRECTORY_LIMIT), server: r.server };
      } catch {
        return { ok: false, kind: 'unreachable', error: 'The internet radio directory is not reachable right now.' };
      }
    },
    cancel() { seq++; },
  };
}
