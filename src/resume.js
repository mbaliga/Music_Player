// resume.js — "resume where you left off": what to remember, when to write it, and how to find it again. Pure (storage and timers are injected).
//
// The record is { v, albumId, trackId, index, t, view, at }. The TRACK ID is the truth (stable across rescans: d2-<mediaId> on the phone), the
// index is only a hint for an album whose ids are missing. A record is restored onto the platter PAUSED, never started. When anything it names
// is gone (album, track, file, unsupported format) resolve() answers null and the app starts as on a first run, with no message.
export const RESUME_KEY = 'runout.resume.v1';
const VIEWS = ['vinyl', 'cd'];
const num = (x) => (Number.isFinite(x) && x >= 0 ? x : 0);

/** Any parsed JSON -> a clean record, or null. Never throws. */
export function sanitize(raw) {
  try {
    if (!raw || typeof raw !== 'object' || typeof raw.albumId !== 'string' || !raw.albumId) return null;
    return {
      v: 1, albumId: raw.albumId.slice(0, 200),
      trackId: typeof raw.trackId === 'string' ? raw.trackId.slice(0, 200) : '',
      index: Math.max(0, Math.trunc(num(raw.index))), t: Math.round(num(raw.t) * 10) / 10,
      view: VIEWS.includes(raw.view) ? raw.view : 'vinyl', at: num(raw.at),
    };
  } catch { return null; }
}

export function load(storage) {
  try { return sanitize(JSON.parse(storage.getItem(RESUME_KEY))); } catch { return null; }
}
export function save(storage, rec) {
  try { if (!storage) return false; if (!rec) storage.removeItem(RESUME_KEY); else storage.setItem(RESUME_KEY, JSON.stringify(rec)); return true; } catch { return false; }
}

/**
 * Where does a record point in the current shelf? shelf = [{ id, tracks:[{ id, file, ... }] }] (library.albums()).
 * usable(track) -> boolean decides whether the track can be played right now (file present, format supported).
 * Returns { shelfIndex, trackIndex, t } or null. A position inside the last 3 s (or past the end) restarts the track at 0.
 */
export function resolve(rec, shelf, usable = (t) => !!(t && t.file)) {
  const r = sanitize(rec);
  if (!r || !Array.isArray(shelf)) return null;
  const shelfIndex = shelf.findIndex((a) => a && a.id === r.albumId);
  if (shelfIndex < 0) return null;
  const tracks = shelf[shelfIndex].tracks || [];
  let trackIndex = r.trackId ? tracks.findIndex((t) => t && t.id === r.trackId) : -1;
  if (trackIndex < 0 && !r.trackId && r.index < tracks.length) trackIndex = r.index;   // a record with no ids: the index is all there is
  if (trackIndex < 0 || !usable(tracks[trackIndex])) return null;
  const dur = Number(tracks[trackIndex].durationSec);
  let t = r.t;
  if (Number.isFinite(dur) && dur > 0 && t > dur - 3) t = 0;
  return { shelfIndex, trackIndex, t };
}

/** Worth showing a "Resume" chip for? (a record sitting at 0:00 of the first track is just the normal state). */
export const isMeaningful = (target) => !!target && (target.trackIndex > 0 || target.t >= 2);

/**
 * Throttled writer. snapshot() -> record | null (null = nothing resumable is on the platter: leave the stored record alone).
 *   tick()   call every frame (cheap): writes at most every minGapMs while the record changes
 *   flush()  write now (pause / hidden / pagehide)
 */
export function createSaver({ snapshot, write, now = () => Date.now(), minGapMs = 4000 } = {}) {
  let lastAt = -Infinity, lastKey = '';
  const doWrite = (force) => {
    let s = null;
    try { s = snapshot(); } catch { s = null; }
    if (!s) return false;
    const key = `${s.albumId}|${s.trackId}|${s.index}|${Math.round(s.t)}|${s.view}`;
    if (key === lastKey) return false;
    const t = now();
    if (!force && t - lastAt < minGapMs) return false;
    lastAt = t; lastKey = key;
    try { write({ ...s, at: t }); } catch { /* */ }
    return true;
  };
  return { tick: () => doWrite(false), flush: () => doWrite(true) };
}
