// library.js — music library management: scan folders, parse metadata, merge sources (the ONE read-model).
//
// Two sources of audio files:
//   1. File System Access API (showDirectoryPicker) — recursive folder scan.
//   2. <input webkitdirectory> — fallback for WebViews / older Chrome.
//
// Metadata: tags.js (pure) reads ID3v2 / FLAC / Ogg / MP4 tags incl. track +
// disc numbers; libindex.js + library-store.js persist the scanned metadata
// (IndexedDB) so albums and mixtape refs survive a restart as "needs re-link".
// Cover art → dominant hue → color-sort support.
// The shelf is drawn by the Albums coverflow (src/turntable/library.js); the old grid view was removed.
// Albums: grouping + Vinyl/CD classification live in the pure albums.js; this
// file only collects tracks and serves them (tracks / albums()).

import { groupTracks, shelfItems } from './albums.js';
import { readFileTags } from './tags.js';
import { trackId, serializeIndex, parseIndex, mergeScanned, uniqueTrackIds, replaceByPath, pruneMissing, linkSummary } from './libindex.js';
import { saveIndex, loadIndex, saveHandle, loadHandles } from './library-store.js';
import { libraryPrefs } from './library-prefs.js';
import { trackSource, filterDeviceTracks, mergeSources, deriveArtists, deriveGenres, folderTrackFields, countShortHidden } from './library-model.js';

// ── Dominant hue extraction from album art ───────────────────────────────────
async function dominantHue(imageUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const S = 16;
      const cv = document.createElement('canvas');
      cv.width = S; cv.height = S;
      const c = cv.getContext('2d');
      c.drawImage(img, 0, 0, S, S);
      const px = c.getImageData(0, 0, S, S).data;
      let rW = 0, gW = 0, bW = 0, tot = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] < 64) continue;
        const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const sat = mx > 0 ? (mx - mn) / mx : 0;
        const wt = (px[i + 3] / 255) * (0.2 + sat * 3);
        rW += r * wt; gW += g * wt; bW += b * wt; tot += wt;
      }
      if (!tot) { resolve(0); return; }
      const r = rW / tot, g = gW / tot, b = bW / tot;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (d < 0.04) { resolve(0); return; }
      let h;
      if (mx === r) h = ((g - b) / d + 6) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      resolve(h * 60);
    };
    img.onerror = () => resolve(0);
    img.src = imageUrl;
  });
}

// Deterministic hue from a string (fallback when no album art).
export function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return (h % 360);
}

export function hueToHex(h) {
  const s = 0.45, l = 0.25;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60)      { r = c; g = x; b = 0; }
  else if (h < 120){ r = x; g = c; b = 0; }
  else if (h < 180){ r = 0; g = c; b = x; }
  else if (h < 240){ r = 0; g = x; b = c; }
  else if (h < 300){ r = x; g = 0; b = c; }
  else             { r = c; g = 0; b = x; }
  const hex = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// ── Parse a single audio file ────────────────────────────────────────────────
async function processFile(file) {
  let meta = null;
  try { meta = await readFileTags(file); } catch {}

  const name = file.name.replace(/\.[^.]+$/, '');
  const title  = meta?.title  || name;
  const artist = meta?.artist || meta?.albumArtist || 'Unknown Artist';
  // Album stays '' when untagged: albums.js falls back to the parent folder
  // (so "Some Album CD2/" folders classify and group correctly).
  const album  = meta?.album  || '';
  const albumArtist = meta?.albumArtist || '';
  const genre  = meta?.genre  || '';
  const path   = file.runoutPath || file.webkitRelativePath || '';
  const trackNo = meta?.trackNo, discNo = meta?.discNo, durationSec = meta?.durationSec;
  const size = file.size || 0;

  let coverUrl = null;
  if (meta?.cover?.data?.length) {
    coverUrl = URL.createObjectURL(new Blob([meta.cover.data], { type: meta.cover.mime || 'image/jpeg' }));
  }

  const hue = coverUrl ? await dominantHue(coverUrl) : hashHue(artist + (album || path || name));
  const color = hueToHex(hue);
  // a duration derived from MP3 frames is new information: keep it out of the id so libraries scanned before it existed keep their ids (and their mixtape links)
  const id = trackId({ title, artist, album, trackNo, discNo, size, durationSec: meta?.durationFromFrames ? undefined : durationSec });

  return { id, file, title, artist, albumArtist, album, path, genre, trackNo, discNo, durationSec, size, coverUrl, hue, color, ...(meta?.codec ? { codec: meta.codec } : null), ...folderTrackFields(meta, file) };
}

// ── Library manager ──────────────────────────────────────────────────────────
const AUDIO_RE = /\.(mp3|flac|ogg|m4a|aac|opus|wav|wma|aiff?)$/i;

export class LibraryManager {
  constructor() {
    this._shelf = null; // cached shelfItems(groupTracks(tracks)); null = dirty
    this._folder = [];            // tracks from the folder picker / persisted folder index
    this._sources = new Map();    // registered extra sources (the Android device library): name -> source
    this._sourceAll = new Map();  // name -> that source's UNFILTERED tracks
    this._listeners = new Set();
    this._merged = [];
  }

  // `tracks` is the merged library (folder + registered sources, filtered, deduped). Assigning replaces the
  // FOLDER tracks only (that is what the folder code paths below do), then re-merges.
  get tracks() { return this._merged; }
  set tracks(v) { this._folder = (v || []).filter((t) => trackSource(t) === 'folder'); this._rebuild(); }

  // ── Source registry (docs/DEVICE_LIBRARY.md) ───────────────────────────────
  // A source = { name, isAvailable(), tracks(), onChange(fn), restore?(), scan?(opts) }. Its tracks join the
  // library, filtered by libraryPrefs (device tracks only) and deduped by id / content.
  registerSource(src) {
    if (!src || !src.name || this._sources.has(src.name)) return this;
    this._sources.set(src.name, src);
    this._sourceAll.set(src.name, src.tracks?.() || []);
    src.onChange?.((tracks) => { this._sourceAll.set(src.name, tracks); this._rebuild(); });
    if (!this._prefsOff) this._prefsOff = libraryPrefs.subscribe(() => this._rebuild());
    this._rebuild();
    return this;
  }
  getSource(name) { return this._sources.get(name) || null; }
  async restoreSources() { for (const s of this._sources.values()) { try { await s.restore?.(); } catch { /* best effort */ } } }
  async scanSources(opts) { const out = {}; for (const s of this._sources.values()) { try { out[s.name] = await s.scan?.(opts); } catch (e) { out[s.name] = { error: String(e?.message || e) }; } } return out; }

  _rebuild() {
    const p = libraryPrefs.get();
    const lists = [];
    for (const [name, all] of this._sourceAll) {
      if (!p.sources[name]) continue;
      lists.push(name === 'device' ? filterDeviceTracks(all, p) : all);
    }
    this._merged = mergeSources(lists, p.sources.folder ? this._folder : []);
    this._shortHidden = 0;
    for (const [name, all] of this._sourceAll) if (name === 'device' && p.sources[name]) this._shortHidden += countShortHidden(all, p);
    this._shelf = null;
    for (const fn of [...this._listeners]) { try { fn(this._merged); } catch { /* ignore */ } }
  }

  /** fn(tracks) after the merged library changes (a scan batch, a pref change, a restore). Returns unsubscribe. */
  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  // ── Read model (stable API for search / mixtape picker / settings; see library-model.js) ──
  getTracks() { return this._merged; }
  getAlbums(sortBy = 'artist') { return this.albums(sortBy); }
  getArtists() { return deriveArtists(this.albums('artist')); }
  getGenres() { return deriveGenres(this._merged); }
  /** Album art URL for a shelf item: the folder scan's cover, else the device source's MediaStore art (async). */
  async getAlbumArt(item, size = 256) {
    if (item?.coverUrl) return item.coverUrl;
    const dev = this._sources.get('device');
    return dev?.getArt ? dev.getArt(item, size) : null;
  }

  // Scan a directory (File System Access API or webkitdirectory fallback).
  async scan(onProgress) {
    let files;

    if (typeof window.showDirectoryPicker === 'function') {
      let dirHandle;
      try { dirHandle = await window.showDirectoryPicker({ mode: 'read' }); }
      catch { return; } // user cancelled
      saveHandle(dirHandle); // best-effort: lets "Re-link" skip the picker next session
      files = await collectFilesFromDir(dirHandle, [], dirHandle.name);
    } else {
      files = await pickFilesViaInput();
    }

    if (!files?.length) return;
    await this._ingest(files.filter(f => AUDIO_RE.test(f.name)), onProgress, true);   // a folder scan: the same folder again adds nothing twice
  }

  // Add files directly (drag-drop or file input).
  async addFiles(fileList, onProgress) {
    await this._ingest(Array.from(fileList).filter(f => AUDIO_RE.test(f.name)), onProgress);
  }

  async _ingest(audioFiles, onProgress, rescan = false) {
    let done = 0;
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      // A scanned file REPLACES the persisted needs-re-link entry with its id. A folder RE-scan also replaces the row that held the same path
      // (a modified file is not a second row); the same song in two folders keeps one row each, with their own ids.
      let base = this._folder, add;
      if (rescan) {
        const paths = new Set(batch.map((t) => t.path).filter(Boolean));
        add = uniqueTrackIds(base.filter((t) => !(t.path && paths.has(t.path))), batch);   // ids are made unique against the rows that STAY
        const r = replaceByPath(base, add); base = r.out; add = r.rest;
      } else add = uniqueTrackIds(base, batch);
      this.tracks = mergeScanned(base, add);
      batch = [];
      this._shelf = null;
    };
    for (const f of audioFiles) {
      try { batch.push(await processFile(f)); } catch {}
      done++;
      if (batch.length >= 25) flush();
      onProgress?.(done, audioFiles.length);
    }
    flush();
    // a finished folder re-pick: files that were deleted from it since the last pick leave the library
    if (rescan && audioFiles.length) { const kept = pruneMissing(this._folder, audioFiles.map((f) => f.runoutPath || f.webkitRelativePath || '').filter(Boolean)); if (kept.length !== this._folder.length) { this.tracks = kept; this._shelf = null; } }
    this._persist();
  }

  // ── Persisted index (metadata only; see libindex.js) ──────────────────────
  _persist() {
    saveIndex(serializeIndex(this._folder, Date.now())).catch(() => {});
  }

  /** Load the persisted index at startup. Restored tracks are `relink: true`. */
  async restore() {
    if (this._folder.length) return 0;
    const restored = parseIndex(await loadIndex());
    if (restored.length) { this.tracks = restored; this._shelf = null; }
    return restored.length;
  }

  get linkSummary() { return linkSummary(this._folder); }

  /**
   * Re-link persisted tracks to real files. MUST be called from a user gesture.
   * Tries stored File System Access handles first (a prompt for read access at
   * most; never silently), then falls back to the folder picker. Resolves with
   * the new linkSummary.
   */
  async relink(onProgress) {
    try {
      const handles = await loadHandles();
      let any = false;
      for (const { name, handle } of handles) {
        try {
          let perm = await handle.queryPermission({ mode: 'read' });
          if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'read' });
          if (perm !== 'granted') continue;
          const files = await collectFilesFromDir(handle, [], handle.name || name);
          await this._ingest(files.filter((f) => AUDIO_RE.test(f.name)), onProgress);
          any = true;
        } catch {}
      }
      if (!any) await this.scan(onProgress);
    } catch {}
    return this.linkSummary;
  }

  // Shelf items (a vinyl = one item, each CD disc = one item), shaped for the
  // grid: album-level display fields come from the first track that has them.
  albums(sortBy = 'artist') {
    if (!this._shelf) {
      this._shelf = shelfItems(groupTracks(this.tracks)).map((it) => {
        const pick = (k) => it.tracks.find((t) => t[k])?.[k];
        return {
          id: it.id, kind: it.kind, album: it.label, artist: it.album.artist,
          genre: pick('genre') || '', coverUrl: pick('coverUrl') || null,
          color: it.tracks[0].color, hue: it.tracks[0].hue, tracks: it.tracks, unsorted: !!it.album.unsorted,
        };
      });
    }
    const list = [...this._shelf];
    const last = (a, b) => (a.unsorted ? 1 : 0) - (b.unsorted ? 1 : 0);   // "Unsorted (folder)" always sorts after real albums
    if (sortBy === 'color')  list.sort((a, b) => last(a, b) || a.hue - b.hue);
    else if (sortBy === 'genre') list.sort((a, b) => last(a, b) || (a.genre || 'zzz').localeCompare(b.genre || 'zzz') || a.album.localeCompare(b.album));
    else if (sortBy === 'album') list.sort((a, b) => last(a, b) || a.album.localeCompare(b.album));
    else list.sort((a, b) => last(a, b) || a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album));
    return list;
  }

  /** songs hidden only because they are shorter than the "hide short songs" setting */
  get shortHidden() { return this._shortHidden || 0; }

  get isEmpty() { return this.tracks.length === 0; }
}

// ── File collection helpers ──────────────────────────────────────────────────
async function collectFilesFromDir(handle, acc = [], prefix = '') {
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind === 'file') {
      const f = await entry.getFile();
      // File System Access files carry no folder path; stamp one so albums.js
      // can read disc labels out of folder names (e.g. "Album CD2/").
      try { Object.defineProperty(f, 'runoutPath', { value: `${prefix}/${name}` }); } catch {}
      acc.push(f);
    } else if (entry.kind === 'directory') {
      await collectFilesFromDir(entry, acc, `${prefix}/${name}`);
    }
  }
  return acc;
}

function pickFilesViaInput() {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.accept = 'audio/*';
    inp.setAttribute('webkitdirectory', '');
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', () => {
      document.body.removeChild(inp);
      resolve(Array.from(inp.files));
    });
    inp.addEventListener('cancel', () => { document.body.removeChild(inp); resolve([]); });
    inp.click();
  });
}
