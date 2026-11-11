// ─────────────────────────────────────────────────────────────────────────────
// libindex.js — pure model for the PERSISTED library index.
//
// A browser cannot keep audio files across sessions, but it can keep their
// metadata. The index stores one small record per scanned track (tags, path,
// size, duration, colour; NEVER audio, never cover art) so albums and mixtape
// refs resolve at startup with no re-scan. A restored track has no File: it is
// marked `relink: true` ("needs re-link") and plays only after the user re-picks
// the folder (or grants a stored File System Access handle; see library-store.js).
//
// Stable track id = hash of normalised tags + file size + container duration
// (when the tags give one). Re-scanning the same file yields the same id; a
// re-tag or re-encode changes it (mixtapes then fall back to tag matching).
//
// Pure + portable (no DOM / IndexedDB here; tested in test/libindex.test.mjs).
// Never throws on bad persisted data.
// ─────────────────────────────────────────────────────────────────────────────

export const INDEX_VERSION = 1;
export const MAX_INDEX_TRACKS = 50000;

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** FNV-1a 32-bit with a caller-chosen offset basis. */
function fnv1a(str, basis) {
  let h = basis >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Stable id from tags + size/duration. Two independent 32-bit hashes (64 bits
 * total) keep collisions negligible for any personal library.
 * input = { title, artist, album, trackNo?, discNo?, size?, durationSec? }
 */
export function trackId(t) {
  const dur = Number.isFinite(t.durationSec) && t.durationSec > 0 ? Math.round(t.durationSec) : 0;
  const key = [norm(t.title), norm(t.artist), norm(t.album), t.trackNo | 0, t.discNo | 0, t.size | 0, dur].join('\u0001');
  const a = fnv1a(key, 0x811c9dc5).toString(16).padStart(8, '0');
  const b = fnv1a(key, 0x9747b28c).toString(16).padStart(8, '0');
  return `t1-${a}${b}`;
}

const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
const posInt = (v) => (Number.isInteger(v) && v >= 1 && v < 100000 ? v : undefined);

/** A live library track -> the plain record we persist. */
export function snapshotTrack(t) {
  const rec = {
    id: t.id || trackId(t),
    title: str(t.title), artist: str(t.artist), albumArtist: str(t.albumArtist),
    album: str(t.album), path: str(t.path, 1000), genre: str(t.genre, 80),
    size: Number.isFinite(t.size) ? t.size : 0,
    hue: Number.isFinite(t.hue) ? Math.round(t.hue) : 0,
    color: typeof t.color === 'string' && /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#222233',
  };
  if (Number.isFinite(t.durationSec) && t.durationSec > 0) rec.durationSec = Math.round(t.durationSec * 1000) / 1000;
  const tn = posInt(t.trackNo), dn = posInt(t.discNo);
  if (tn) rec.trackNo = tn;
  if (dn) rec.discNo = dn;
  return rec;
}

/** A persisted record -> a library track with no File ("needs re-link"). */
export function restoreTrack(rec) {
  const t = {
    id: rec.id, title: rec.title, artist: rec.artist, albumArtist: rec.albumArtist,
    album: rec.album, path: rec.path, genre: rec.genre, size: rec.size,
    hue: rec.hue, color: rec.color, coverUrl: null, file: null, relink: true,
  };
  if (rec.durationSec) t.durationSec = rec.durationSec;
  if (rec.trackNo) t.trackNo = rec.trackNo;
  if (rec.discNo) t.discNo = rec.discNo;
  return t;
}

/** Library tracks -> the document stored in IndexedDB. */
export function serializeIndex(tracks, now = 0) {
  return {
    version: INDEX_VERSION,
    savedAt: now,
    tracks: tracks.slice(0, MAX_INDEX_TRACKS).map(snapshotTrack),
  };
}

/**
 * Stored document (object, or JSON text) -> restored tracks. Never throws.
 * A missing/corrupt/newer-version document yields [] (callers then simply see
 * an empty library, exactly as on first run). Bad rows are dropped.
 */
export function parseIndex(raw) {
  try {
    if (typeof raw === 'string') raw = JSON.parse(raw);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    if (!Number.isInteger(raw.version) || raw.version < 1 || raw.version > INDEX_VERSION) return [];
    if (!Array.isArray(raw.tracks)) return [];
    const out = [];
    const seen = new Set();
    for (const r of raw.tracks) {
      if (!r || typeof r !== 'object' || typeof r.title !== 'string' || !r.title) continue;
      const rec = snapshotTrack({ ...r, id: typeof r.id === 'string' && r.id ? r.id.slice(0, 64) : undefined });
      if (seen.has(rec.id)) continue;
      seen.add(rec.id);
      out.push(restoreTrack(rec));
    }
    return out;
  } catch { return []; }
}

/**
 * Add freshly scanned tracks to `existing`. A scanned track REPLACES a
 * needs-re-link entry with the same id (that is the re-link); anything else is
 * appended. Existing live tracks are never replaced (a duplicate file stays a
 * duplicate). Returns a new array.
 */
export function mergeScanned(existing, scanned) {
  const out = existing.slice();
  const relinkAt = new Map();
  out.forEach((t, i) => { if (t.relink && t.id) relinkAt.set(t.id, i); });
  for (const s of scanned) {
    const i = s.id ? relinkAt.get(s.id) : undefined;
    if (i !== undefined) { out[i] = s; relinkAt.delete(s.id); } else out.push(s);
  }
  return out;
}

/** { linked, needsRelink } counts, for status text. */
export function linkSummary(tracks) {
  let needsRelink = 0;
  for (const t of tracks) if (t.relink && !t.file) needsRelink++;
  return { linked: tracks.length - needsRelink, needsRelink };
}
