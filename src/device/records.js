// ─────────────────────────────────────────────────────────────────────────────
// records.js — MediaStore rows -> Runout library tracks (pure; no DOM, no Capacitor).
//
// A native row (see DeviceLibraryPlugin.records) looks like
//   { id, name, title, artist, album, albumId, albumArtist, genre, track, cdTrack, disc, year, durationMs,
//     size, mime, modified, data, relativePath, volume, isMusic, isRingtone, isAlarm, isNotification, isPodcast }
// and becomes the same track shape library.js builds for folder scans
//   { id, file, title, artist, albumArtist, album, path, genre, trackNo, discNo, durationSec, size, coverUrl, hue, color }
// plus  source:'device', mediaId, uri, folder, year, mime, modified, volume, kind, needsTags.
//
// `path` is the folder path + file name ("Music/Artist/Album CD1/01 Intro.mp3") so albums.js
// (foldersOf / classifyAlbum / groupTracks) applies the CD1 / Disc N rule from real folder names.
// ─────────────────────────────────────────────────────────────────────────────
import { hashHue, hueToHex } from '../library.js';
import { addedMs } from '../library-model.js';

export const SOURCE_DEVICE = 'device';
export const UNKNOWN_ARTIST = 'Unknown Artist';   // the same bucket name library.js / albums.js already use

const AUDIO_EXT = /\.(mp3|flac|ogg|oga|m4a|m4b|aac|opus|wav|wma|aiff?|amr|mka|mid|midi)$/i;
const UNKNOWN_RE = /^\s*(<unknown>|unknown|\[unknown\]|null|undefined|none)?\s*$/i;

/** Blank, "<unknown>" and friends (MediaStore writes "<unknown>" for missing tags). */
export const isUnknown = (s) => typeof s !== 'string' || UNKNOWN_RE.test(s);
const clean = (s, max = 300) => (isUnknown(s) ? '' : s.replace(/\s+/g, ' ').trim().slice(0, max));

export function isAudioRow(row) {
  const mime = typeof row.mime === 'string' ? row.mime.toLowerCase() : '';
  if (mime.startsWith('audio/') || mime === 'application/ogg' || mime === 'application/x-flac') return true;
  return AUDIO_EXT.test(row.name || '');   // some providers label audio-only containers as video/mp4 or octet-stream
}

/** "/storage/emulated/0/Music/A/x.mp3" -> "Music/A/"  (API < 29, where RELATIVE_PATH does not exist). */
export function relativeFromData(data) {
  if (typeof data !== 'string' || !data) return '';
  let p = data.replace(/\\/g, '/');
  p = p.replace(/^\/(?:storage\/(?:emulated\/\d+|[0-9A-Za-z-]+)|sdcard\d*|mnt\/(?:sdcard|media_rw\/[^/]+))\//, '');
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i + 1) : '';
}

export function folderOf(row) {
  let rel = typeof row.relativePath === 'string' && row.relativePath ? row.relativePath : relativeFromData(row.data);
  rel = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel && !rel.endsWith('/')) rel += '/';
  return rel;
}

const stripExt = (n) => String(n || '').replace(/\.[^.]+$/, '');
const intOf = (v) => { const n = parseInt(String(v), 10); return Number.isFinite(n) && n >= 1 && n < 100000 ? n : 0; };

/** MediaStore packs disc+track in `track` as DTTT (1003 = disc 1 track 3); newer APIs also give CD_TRACK_NUMBER / DISC_NUMBER ("3/12", "1/2"). */
export function trackAndDisc(row) {
  let trackNo = intOf(row.cdTrack), discNo = intOf(row.disc);
  const packed = Number(row.track) | 0;
  if (!trackNo && packed > 0) {
    if (packed >= 1000) { trackNo = packed % 1000; if (!discNo) discNo = Math.floor(packed / 1000); } else trackNo = packed;
  }
  return { trackNo: trackNo || undefined, discNo: discNo || undefined };
}

/**
 * Stable id from the MediaStore _id ALONE: a re-tag or re-encode changes size / date_modified but it is the same song, so mixtape links, play counts
 * and the rest keep pointing at it. size + date_modified stay on the track as the CHANGE SIGNATURE (source.js re-reads a row when they move).
 * The first format, `d1-<id>-<size>-<mtime>`, moved on every re-tag: mediaIdOfDeviceId() reads the _id back out of either format, and fromStored()
 * migrates stored rows, so existing references survive.
 */
export function deviceTrackId(row) {
  return `d2-${Math.max(0, Math.trunc(Number(row.id) || 0)).toString(36)}`;
}
/** The MediaStore _id inside a device track id (old `d1-` or current `d2-` format), or null for any other id. */
export function mediaIdOfDeviceId(id) {
  const m = /^d[12]-([0-9a-z]+)(?:-|$)/.exec(String(id || ''));
  if (!m) return null;
  const n = parseInt(m[1], 36);
  return Number.isFinite(n) ? n : null;
}

export function deviceUri(id) { return `content://media/external/audio/media/${id}`; }

const kindOf = (row) => (row.isRingtone ? 'ringtone' : row.isAlarm ? 'alarm' : row.isNotification ? 'notification' : row.isPodcast ? 'podcast' : 'music');

/**
 * One native row -> a library track. `makeFile(track)` supplies the DeviceFile (omit in pure tests).
 * Never throws on odd rows: missing fields degrade to the folder / file-name fallbacks.
 */
export function mapRow(row, { makeFile } = {}) {
  const folder = folderOf(row);
  const name = String(row.name || '');
  const artistTag = clean(row.artist, 200);
  const albumTag = clean(row.album, 300);
  const title = clean(row.title) || stripExt(name) || `Track ${row.id}`;
  const albumArtist = clean(row.albumArtist, 200);
  const artist = artistTag || albumArtist || UNKNOWN_ARTIST;
  let genre = clean(row.genre, 80);
  if (/^\(?\d+\)?$/.test(genre)) genre = '';   // a raw ID3v1 index we cannot name
  const { trackNo, discNo } = trackAndDisc(row);
  const year = Number(row.year) > 0 && Number(row.year) < 3000 ? Number(row.year) | 0 : 0;
  const durationSec = Number(row.durationMs) > 0 ? Math.round(row.durationMs) / 1000 : 0;
  const path = folder + name;
  const key = artist + (albumTag || folder || name);
  const hue = hashHue(key);
  const t = {
    id: deviceTrackId(row), source: SOURCE_DEVICE, mediaId: row.id, uri: deviceUri(row.id),
    title, artist, albumArtist, album: albumTag, path, folder, genre,
    size: Number(row.size) || 0, modified: Number(row.modified) || 0, added: addedMs(row.modified, 's'),   // date added = MediaStore date_modified (seconds) in epoch ms, same unit as a folder file's lastModified
    mime: String(row.mime || ''), volume: String(row.volume || ''),
    year, kind: kindOf(row), albumMediaId: Number(row.albumId) || 0,
    coverUrl: null, hue, color: hueToHex(hue), file: null,
    // MediaStore had nothing for artist AND album: worth reading the file's own tags.
    needsTags: !artistTag && !albumArtist && !albumTag,
  };
  if (trackNo) t.trackNo = trackNo;
  if (discNo) t.discNo = discNo;
  if (durationSec) t.durationSec = durationSec;
  if (makeFile) t.file = makeFile(t);
  return t;
}

/** Merge tags.js output (readFileTags) into a device track; only fills what MediaStore left blank. */
export function applyTags(t, meta) {
  if (!meta) return t;
  const out = { ...t, needsTags: false, tagged: true };
  if (meta.title && (isUnknown(t.title) || t.title === stripExt(baseName(t.path)))) out.title = meta.title;
  if (meta.artist && t.artist === UNKNOWN_ARTIST) out.artist = meta.artist;
  if (meta.albumArtist && !t.albumArtist) out.albumArtist = meta.albumArtist;
  if (meta.album && !t.album) out.album = meta.album;
  if (meta.genre && !t.genre) out.genre = meta.genre;
  if (meta.trackNo && !t.trackNo) out.trackNo = meta.trackNo;
  if (meta.discNo && !t.discNo) out.discNo = meta.discNo;
  if (meta.durationSec && !t.durationSec) out.durationSec = meta.durationSec;
  if (meta.year && !t.year) out.year = meta.year;
  if (out.artist !== t.artist || out.album !== t.album) {
    out.hue = hashHue(out.artist + (out.album || out.folder || baseName(out.path)));
    out.color = hueToHex(out.hue);
  }
  return out;
}

const baseName = (p) => String(p || '').slice(String(p || '').lastIndexOf('/') + 1);

/** A track -> the plain JSON stored in IndexedDB (no File, no blob URLs). */
export function toStored(t) {
  const { file, coverUrl, ...rest } = t; // eslint-disable-line no-unused-vars
  return rest;
}

/** Stored JSON -> a live track (re-attaching a DeviceFile). Returns null for unusable rows. */
export function fromStored(rec, { makeFile } = {}) {
  if (!rec || typeof rec !== 'object' || typeof rec.id !== 'string' || !Number.isFinite(rec.mediaId) || typeof rec.title !== 'string') return null;
  const t = { ...rec, coverUrl: null, file: null };
  if (!t.id.startsWith('d2-')) t.id = deviceTrackId({ id: t.mediaId });   // d1-<id>-<size>-<mtime> -> d2-<id> (mixtape refs still find it: resolveTracks reads the media id)
  if (!(t.added > 0) && t.modified > 0) t.added = addedMs(t.modified, 's');   // rows stored before `added` existed
  if (makeFile) t.file = makeFile(t);
  return t;
}
