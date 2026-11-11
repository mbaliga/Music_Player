// ─────────────────────────────────────────────────────────────────────────────
// play-history.js — a minimal local play-history store for the offline host.
//
// Why: the app had no play history (only a wear counter). "You" moments ("you keep coming back to…")
// need one, and the data never leaves the device. Metadata only: track id -> {n, last}.
//   • versioned (`v: 1`); an unreadable / newer / corrupt blob is ignored, never thrown on
//   • capped: at most MAX_TRACKS tracks (least-recently-played evicted), RECENT_MAX recent ids
//   • storage is injected (anything with getItem/setItem) and fully try/caught
// Pure helpers return NEW objects; the host decides when to save.
// ─────────────────────────────────────────────────────────────────────────────

export const HISTORY_KEY = 'runout.radio.offline.history.v1';
export const HISTORY_VERSION = 1;
export const MAX_TRACKS = 1000;
export const RECENT_MAX = 50;

export const emptyHistory = () => ({ v: HISTORY_VERSION, tracks: {}, recent: [], sessions: 0, firstMs: null });

const isId = (s) => typeof s === 'string' && s.length > 0 && s.length <= 80;
const posInt = (n) => Number.isInteger(n) && n >= 0 && n < 1e9;

/** Parse a stored blob. Anything unexpected -> an empty history. */
export function parseHistory(raw) {
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!j || typeof j !== 'object' || j.v !== HISTORY_VERSION || !j.tracks || typeof j.tracks !== 'object') return emptyHistory();
    const tracks = {};
    for (const [id, r] of Object.entries(j.tracks)) {
      if (!isId(id) || !r || !posInt(r.n) || !Number.isFinite(r.last)) continue;
      tracks[id] = { n: r.n, last: r.last };
      if (Object.keys(tracks).length >= MAX_TRACKS) break;
    }
    return {
      v: HISTORY_VERSION, tracks,
      recent: Array.isArray(j.recent) ? j.recent.filter(isId).slice(-RECENT_MAX) : [],
      sessions: posInt(j.sessions) ? j.sessions : 0,
      firstMs: Number.isFinite(j.firstMs) ? j.firstMs : null,
    };
  } catch { return emptyHistory(); }
}

export const serializeHistory = (h) => JSON.stringify(h);

/** Record one play at nowMs. Evicts the least recently played track when over the cap. */
export function recordPlay(h, trackId, nowMs) {
  if (!isId(trackId) || !Number.isFinite(nowMs)) return h;
  const prev = h.tracks[trackId];
  const tracks = { ...h.tracks, [trackId]: { n: (prev ? prev.n : 0) + 1, last: nowMs } };
  const ids = Object.keys(tracks);
  if (ids.length > MAX_TRACKS) {
    ids.sort((a, b) => tracks[a].last - tracks[b].last);
    for (const id of ids.slice(0, ids.length - MAX_TRACKS)) delete tracks[id];
  }
  return { ...h, tracks, recent: [...h.recent, trackId].slice(-RECENT_MAX), firstMs: h.firstMs ?? nowMs };
}

export const recordSession = (h) => ({ ...h, sessions: h.sessions + 1 });

export function loadHistory(storage) {
  try { return parseHistory(storage.getItem(HISTORY_KEY)); } catch { return emptyHistory(); }
}
export function saveHistory(storage, h) {
  try { storage.setItem(HISTORY_KEY, serializeHistory(h)); return true; } catch { return false; }
}
export function clearHistory(storage) {
  try { storage.removeItem(HISTORY_KEY); return true; } catch { return false; }
}

export const playCount = (h, id) => (h.tracks[id] ? h.tracks[id].n : 0);
export const lastPlayedAgoSec = (h, id, nowMs) => (h.tracks[id] ? Math.max(0, Math.round((nowMs - h.tracks[id].last) / 1000)) : null);
export const totalPlays = (h) => Object.values(h.tracks).reduce((a, r) => a + r.n, 0);

/** Top n [{id, n}] by play count (ties: more recent first, then id). Only tracks played at least minPlays times. */
export function mostPlayed(h, n = 3, minPlays = 2) {
  return Object.entries(h.tracks).filter(([, r]) => r.n >= minPlays)
    .sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([id, r]) => ({ id, n: r.n }));
}
