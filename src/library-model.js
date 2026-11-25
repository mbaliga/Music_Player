// ─────────────────────────────────────────────────────────────────────────────
// library-model.js — pure, DOM-free helpers behind the merged library read-model.
//
// The LibraryManager (library.js) keeps `tracks` = every source merged. This module holds the logic that
// is easy to test on its own and that B (search index) / D (mixtape picker) can import without touching
// the DOM or IndexedDB:
//   filterDeviceTracks(tracks, prefs)   hide ringtones / short clips / excluded folders (reads library-prefs shape)
//   mergeSources(extraLists, folder)    ONE array; a folder track that a device track already stands for is dropped
//   deriveArtists(shelf)                [{ name, albumCount, trackCount, albums:[shelfId] }] from LibraryManager.albums()
//   deriveGenres(tracks)                [{ name, trackCount, albumCount }]
//   trackSource(t)                      'device' | 'folder'
// See docs/DEVICE_LIBRARY.md for the full read-model contract.
// ─────────────────────────────────────────────────────────────────────────────

export const trackSource = (t) => (t && t.source) || 'folder';

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const segs = (p) => String(p || '').replace(/\\/g, '/').split('/').map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Does `folder` ("Music/WhatsApp Audio/") contain the pattern's segments ("WhatsApp Audio", or "Android/media") contiguously? */
export function folderMatches(folder, pattern) {
  const f = segs(folder), p = segs(pattern);
  if (!p.length || p.length > f.length) return false;
  for (let i = 0; i + p.length <= f.length; i++) {
    let ok = true;
    for (let j = 0; j < p.length; j++) if (f[i + j] !== p[j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

/**
 * The extra fields every library track carries for the mixtape suggestions and search (the same names for BOTH sources):
 *   year   4-digit year from the tags (0 = unknown)
 *   added  "date added" in epoch ms: folder scan = file.lastModified (ms); device = MediaStore date_modified (seconds -> ms). 0 = unknown.
 * Pure; never throws.
 */
export function yearOf(v) { const y = Number(v); return Number.isFinite(y) && y >= 1000 && y < 3000 ? Math.trunc(y) : 0; }
export function addedMs(v, unit = 'ms') { const n = Number(v); if (!Number.isFinite(n) || n <= 0) return 0; return Math.trunc(unit === 's' ? n * 1000 : n); }
export function folderTrackFields(meta, file) { return { year: yearOf(meta && meta.year), added: addedMs(file && file.lastModified) }; }

/** Folder of a track: device tracks carry `folder`; folder-scan tracks derive it from `path`. */
export function folderOfTrack(t) {
  if (typeof t.folder === 'string') return t.folder;
  const p = String(t.path || '');
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i + 1) : '';
}

/**
 * Prefs-driven filter for DEVICE tracks (a folder the user picked by hand is never filtered).
 * prefs = { minDurationSec, excludeFolders[], includeFolders[] }. Order of precedence: system sounds (ringtone /
 * alarm / notification flags) always drop; includeFolders (when non-empty) must match; excludeFolders must not match;
 * a KNOWN duration below the minimum drops (unknown duration is kept: better a stray clip than a missing song).
 */
export function filterDeviceTracks(tracks, prefs = {}) {
  const min = Number.isFinite(prefs.minDurationSec) ? prefs.minDurationSec : 0;
  const ex = Array.isArray(prefs.excludeFolders) ? prefs.excludeFolders : [];
  const inc = Array.isArray(prefs.includeFolders) ? prefs.includeFolders : [];
  return tracks.filter((t) => {
    if (t.kind === 'ringtone' || t.kind === 'alarm' || t.kind === 'notification') return false;
    const folder = folderOfTrack(t);
    if (inc.length && !inc.some((p) => folderMatches(folder, p))) return false;
    if (ex.some((p) => folderMatches(folder, p))) return false;
    if (min > 0 && t.durationSec > 0 && t.durationSec < min) return false;
    return true;
  });
}

/** How many tracks the "hide short songs" preference alone is hiding (so the UI can say so instead of silently showing an empty shelf). */
export function countShortHidden(tracks, prefs = {}) {
  const min = Number.isFinite(prefs.minDurationSec) ? prefs.minDurationSec : 0;
  if (!(min > 0)) return 0;
  const ex = Array.isArray(prefs.excludeFolders) ? prefs.excludeFolders : [];
  const inc = Array.isArray(prefs.includeFolders) ? prefs.includeFolders : [];
  let n = 0;
  for (const t of tracks) {
    if (t.kind === 'ringtone' || t.kind === 'alarm' || t.kind === 'notification') continue;
    const folder = folderOfTrack(t);
    if (inc.length && !inc.some((p) => folderMatches(folder, p))) continue;
    if (ex.some((p) => folderMatches(folder, p))) continue;
    if (t.durationSec > 0 && t.durationSec < min) n++;
  }
  return n;
}

/** Content identity across sources (a folder scan and the device scan finding the same song). */
export function contentKey(t) {
  return [norm(t.title), norm(t.artist), norm(t.album), t.size | 0].join('\u0001');
}

/**
 * Merge registered-source tracks with folder-scan tracks into ONE array.
 *   - extra-source tracks (the device library) are de-duplicated by `id` (first wins);
 *   - a folder track is dropped when a source track already stands for it: same `id`, or (with a known size) the same
 *     title / artist / album / size. The device copy wins because it plays without a re-link.
 *   - folder tracks among themselves, and two copies of a song inside the device source, are NEVER collapsed
 *     (two real files stay two tracks, exactly as before sources existed).
 * Order: source tracks first (in the given order), then the surviving folder tracks.
 */
export function mergeSources(extraLists, folderTracks = []) {
  const ids = new Set();
  const keys = new Set();
  const extra = [];
  for (const list of extraLists) {
    for (const t of list) {
      if (!t || t.id == null || ids.has(t.id)) continue;
      ids.add(t.id); extra.push(t);
      if (t.size > 0) keys.add(contentKey(t));
    }
  }
  if (!extra.length) return folderTracks.slice();
  const keep = folderTracks.filter((t) => !(ids.has(t.id) || (t.size > 0 && keys.has(contentKey(t)))));
  return extra.concat(keep);
}

/** Artists (album-artist level, matching the shelf) from LibraryManager.albums() items. */
export function deriveArtists(shelf) {
  const m = new Map();
  for (const it of shelf) {
    if (it.unsorted) continue;   // untagged files are not an artist
    const name = it.artist || 'Unknown Artist';
    const k = norm(name);
    let a = m.get(k);
    if (!a) { a = { name, albumCount: 0, trackCount: 0, albums: [] }; m.set(k, a); }
    a.albumCount++; a.trackCount += it.tracks.length; a.albums.push(it.id);
  }
  return [...m.values()].sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base', numeric: true }));
}

/** Genres from tracks (blank genre is skipped, not bucketed). albumCount counts distinct album+artist pairs. */
export function deriveGenres(tracks) {
  const m = new Map();
  for (const t of tracks) {
    const g = String(t.genre || '').trim();
    if (!g) continue;
    const k = norm(g);
    let e = m.get(k);
    if (!e) { e = { name: g, trackCount: 0, albums: new Set() }; m.set(k, e); }
    e.trackCount++; e.albums.add(norm(t.albumArtist || t.artist) + '\0' + norm(t.album || folderOfTrack(t)));
  }
  return [...m.values()].map((e) => ({ name: e.name, trackCount: e.trackCount, albumCount: e.albums.size }))
    .sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));
}
