// library.js — music library management: scan folders, parse metadata, grid view.
//
// Two sources of audio files:
//   1. File System Access API (showDirectoryPicker) — recursive folder scan.
//   2. <input webkitdirectory> — fallback for WebViews / older Chrome.
//
// Metadata: inline ID3v2 parser (MP3) + FLAC Vorbis comment parser.
// Cover art → dominant hue → color-sort support.
// Grid view: CSS grid, pinch-to-zoom column count, sort by color/genre/A-Z.

// ── ID3 genre table (first 80 entries; covers nearly all real-world files) ──
const ID3_GENRES = [
  'Blues','Classic Rock','Country','Dance','Disco','Funk','Grunge','Hip-Hop',
  'Jazz','Metal','New Age','Oldies','Other','Pop','R&B','Rap','Reggae','Rock',
  'Techno','Industrial','Alternative','Ska','Death Metal','Pranks','Soundtrack',
  'Euro-Techno','Ambient','Trip-Hop','Vocal','Jazz+Funk','Fusion','Trance',
  'Classical','Instrumental','Acid','House','Game','Sound Clip','Gospel','Noise',
  'Alternative Rock','Bass','Soul','Punk','Space','Meditative','Instrumental Pop',
  'Instrumental Rock','Ethnic','Gothic','Darkwave','Techno-Industrial','Electronic',
  'Pop-Folk','Eurodance','Dream','Southern Rock','Comedy','Cult','Gangsta Rap',
  'Top 40','Christian Rap','Pop/Funk','Jungle','Native American','Cabaret',
  'New Wave','Psychedelic','Rave','Showtunes','Trailer','Lo-Fi','Tribal',
  'Acid Punk','Acid Jazz','Polka','Retro','Musical','Rock & Roll','Hard Rock',
];

// ── Tiny ID3v2 parser (MP3) ─────────────────────────────────────────────────
async function parseID3v2(file) {
  const maxRead = Math.min(file.size, 512 * 1024); // first 512 KB
  const buf = await file.slice(0, maxRead).arrayBuffer();
  const d = new Uint8Array(buf);

  if (d[0] !== 0x49 || d[1] !== 0x44 || d[2] !== 0x33) return null; // not ID3

  const majorVer = d[3];
  const flags = d[5];
  const tagSize = ((d[6] & 0x7f) << 21) | ((d[7] & 0x7f) << 14) |
                  ((d[8] & 0x7f) << 7)  |  (d[9] & 0x7f);

  let pos = 10;
  if (flags & 0x40) { // extended header
    const xs = majorVer === 4
      ? ((d[10] & 0x7f) << 21) | ((d[11] & 0x7f) << 14) | ((d[12] & 0x7f) << 7) | (d[13] & 0x7f)
      : (d[10] << 24) | (d[11] << 16) | (d[12] << 8) | d[13];
    pos += xs + (majorVer === 4 ? 0 : 4);
  }

  const end = Math.min(tagSize + 10, d.length);
  const result = {};
  const SHORT = majorVer === 2; // v2.2 uses 3-char IDs and 3-byte sizes

  const readText = (fd) => {
    if (!fd.length) return '';
    const enc = fd[0];
    const bytes = fd.slice(1);
    if (enc === 0) {
      let s = '';
      for (let i = 0; i < bytes.length && bytes[i] !== 0; i++)
        s += String.fromCharCode(bytes[i]);
      return s;
    }
    if (enc === 3) {
      const z = bytes.indexOf(0);
      try { return new TextDecoder('utf-8').decode(z >= 0 ? bytes.slice(0, z) : bytes); }
      catch { return ''; }
    }
    // UTF-16 (enc 1 = with BOM, enc 2 = BE without BOM)
    const le = enc === 1 && bytes[0] === 0xff && bytes[1] === 0xfe;
    const start = (enc === 1 && (bytes[0] === 0xff || bytes[0] === 0xfe)) ? 2 : 0;
    let s = '';
    for (let i = start; i + 1 < bytes.length; i += 2) {
      const cp = le ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1];
      if (cp === 0) break;
      s += String.fromCodePoint(cp);
    }
    return s;
  };

  while (pos + (SHORT ? 6 : 10) <= end) {
    const id = SHORT
      ? String.fromCharCode(d[pos], d[pos + 1], d[pos + 2])
      : String.fromCharCode(d[pos], d[pos + 1], d[pos + 2], d[pos + 3]);
    if (!id || d[pos] === 0) break; // padding

    const size = SHORT
      ? (d[pos + 3] << 16) | (d[pos + 4] << 8) | d[pos + 5]
      : majorVer === 4
        ? ((d[pos + 4] & 0x7f) << 21) | ((d[pos + 5] & 0x7f) << 14) | ((d[pos + 6] & 0x7f) << 7) | (d[pos + 7] & 0x7f)
        : (d[pos + 4] << 24) | (d[pos + 5] << 16) | (d[pos + 6] << 8) | d[pos + 7];

    const ds = pos + (SHORT ? 6 : 10);
    if (size <= 0 || ds + size > end) break;

    const fd = d.slice(ds, ds + size);
    pos = ds + size;

    if (id === 'TIT2' || id === 'TT2') result.title = readText(fd);
    else if (id === 'TPE1' || id === 'TP1') result.artist = readText(fd);
    else if (id === 'TPE2' || id === 'TP2') result.albumArtist = readText(fd);
    else if (id === 'TALB' || id === 'TAL') result.album = readText(fd);
    else if (id === 'TCON' || id === 'TCO') {
      let g = readText(fd);
      g = g.replace(/^\((\d+)\)(.*)$/, (_, n, rest) => rest.trim() || ID3_GENRES[+n] || g);
      result.genre = g.trim();
    } else if ((id === 'APIC' || id === 'PIC') && !result.coverBlob) {
      let i = 1; // skip encoding byte
      if (SHORT) {
        i += 3; // 3-char image format in v2.2
      } else {
        while (i < fd.length && fd[i] !== 0) i++;
        i++; // skip null
      }
      i++; // skip picture type
      const enc = fd[0];
      if (enc === 1 || enc === 2) {
        while (i + 1 < fd.length && !(fd[i] === 0 && fd[i + 1] === 0)) i += 2;
        i += 2;
      } else {
        while (i < fd.length && fd[i] !== 0) i++;
        i++;
      }
      if (i < fd.length) result.coverBlob = new Blob([fd.slice(i)]);
    }
  }

  return result;
}

// ── FLAC Vorbis comment + PICTURE parser ────────────────────────────────────
async function parseFLAC(file) {
  const maxRead = Math.min(file.size, 1024 * 1024);
  const buf = await file.slice(0, maxRead).arrayBuffer();
  const d = new Uint8Array(buf);

  if (d[0] !== 0x66 || d[1] !== 0x4c || d[2] !== 0x61 || d[3] !== 0x43) return null;

  const result = {};
  let pos = 4;

  while (pos + 4 <= d.length) {
    const header = d[pos];
    const last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const blockLen = (d[pos + 1] << 16) | (d[pos + 2] << 8) | d[pos + 3];
    pos += 4;
    const blockEnd = Math.min(pos + blockLen, d.length);
    const td = new TextDecoder('utf-8');

    if (type === 4) { // VORBIS_COMMENT
      let p = pos;
      const vendorLen = d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24);
      p += 4 + vendorLen;
      const count = d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24);
      p += 4;
      for (let i = 0; i < count && p + 4 <= blockEnd; i++) {
        const cLen = d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24);
        p += 4;
        if (p + cLen > blockEnd) break;
        const comment = td.decode(d.slice(p, p + cLen));
        p += cLen;
        const eq = comment.indexOf('=');
        if (eq < 0) continue;
        const key = comment.slice(0, eq).toUpperCase();
        const val = comment.slice(eq + 1);
        if (key === 'TITLE') result.title = val;
        else if (key === 'ARTIST') result.artist = val;
        else if (key === 'ALBUMARTIST') result.albumArtist = val;
        else if (key === 'ALBUM') result.album = val;
        else if (key === 'GENRE') result.genre = val;
      }
    } else if (type === 6 && !result.coverBlob) { // PICTURE
      let p = pos;
      const picType = (d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3];
      p += 4;
      const mimeLen = (d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3];
      p += 4 + mimeLen;
      const descLen = (d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3];
      p += 4 + descLen + 16; // skip width/height/depth/colors
      const dataLen = (d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3];
      p += 4;
      if (p + dataLen <= blockEnd) result.coverBlob = new Blob([d.slice(p, p + dataLen)]);
    }

    pos = blockEnd;
    if (last) break;
  }

  return result;
}

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
function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return (h % 360);
}

function hueToHex(h) {
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
  const ext = file.name.split('.').pop().toLowerCase();
  let meta = null;

  try {
    if (ext === 'mp3') meta = await parseID3v2(file);
    else if (ext === 'flac') meta = await parseFLAC(file);
  } catch {}

  const name = file.name.replace(/\.[^.]+$/, '');
  const title  = meta?.title  || name;
  const artist = meta?.artist || meta?.albumArtist || 'Unknown Artist';
  const album  = meta?.album  || name;
  const genre  = meta?.genre  || '';

  let coverUrl = null;
  if (meta?.coverBlob) {
    coverUrl = URL.createObjectURL(meta.coverBlob);
  }

  const hue = coverUrl ? await dominantHue(coverUrl) : hashHue(artist + album);
  const color = hueToHex(hue);

  return { file, title, artist, album, genre, coverUrl, hue, color };
}

// ── Library manager ──────────────────────────────────────────────────────────
export class LibraryManager {
  constructor() {
    this.tracks = [];
    this._albums = new Map(); // key → { artist, album, genre, coverUrl, color, hue, tracks }
  }

  // Scan a directory (File System Access API or webkitdirectory fallback).
  async scan(onProgress) {
    let files;

    if (typeof window.showDirectoryPicker === 'function') {
      let dirHandle;
      try { dirHandle = await window.showDirectoryPicker({ mode: 'read' }); }
      catch { return; } // user cancelled
      files = await collectFilesFromDir(dirHandle);
    } else {
      files = await pickFilesViaInput();
    }

    if (!files?.length) return;

    const AUDIO = /\.(mp3|flac|ogg|m4a|aac|opus|wav|wma|aiff?)$/i;
    const audioFiles = files.filter(f => AUDIO.test(f.name));
    let done = 0;

    for (const f of audioFiles) {
      try {
        const track = await processFile(f);
        this.tracks.push(track);
        const key = `${track.artist}\0${track.album}`;
        if (!this._albums.has(key)) {
          this._albums.set(key, {
            artist: track.artist, album: track.album,
            genre: track.genre, coverUrl: track.coverUrl,
            color: track.color, hue: track.hue,
            tracks: [],
          });
        }
        this._albums.get(key).tracks.push(track);
      } catch {}
      done++;
      onProgress?.(done, audioFiles.length);
    }
  }

  // Add files directly (drag-drop or file input).
  async addFiles(fileList, onProgress) {
    const AUDIO = /\.(mp3|flac|ogg|m4a|aac|opus|wav|wma|aiff?)$/i;
    const files = Array.from(fileList).filter(f => AUDIO.test(f.name));
    let done = 0;
    for (const f of files) {
      try {
        const track = await processFile(f);
        this.tracks.push(track);
        const key = `${track.artist}\0${track.album}`;
        if (!this._albums.has(key)) {
          this._albums.set(key, {
            artist: track.artist, album: track.album,
            genre: track.genre, coverUrl: track.coverUrl,
            color: track.color, hue: track.hue,
            tracks: [],
          });
        }
        this._albums.get(key).tracks.push(track);
      } catch {}
      done++;
      onProgress?.(done, files.length);
    }
  }

  albums(sortBy = 'artist') {
    const list = [...this._albums.values()];
    if (sortBy === 'color')  list.sort((a, b) => a.hue - b.hue);
    else if (sortBy === 'genre') list.sort((a, b) => (a.genre || 'zzz').localeCompare(b.genre || 'zzz') || a.album.localeCompare(b.album));
    else if (sortBy === 'album') list.sort((a, b) => a.album.localeCompare(b.album));
    else list.sort((a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album));
    return list;
  }

  get isEmpty() { return this._albums.size === 0; }
}

// ── File collection helpers ──────────────────────────────────────────────────
async function collectFilesFromDir(handle, acc = []) {
  for await (const [, entry] of handle.entries()) {
    if (entry.kind === 'file') acc.push(await entry.getFile());
    else if (entry.kind === 'directory') await collectFilesFromDir(entry, acc);
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

// ── Grid view component ──────────────────────────────────────────────────────
export class GridView {
  constructor(container, library, onSelect) {
    this._container = container;
    this._lib = library;
    this._onSelect = onSelect;
    this._sort = 'artist';
    this._cellSize = 130;

    this._pinchDist = null;
    this._pinchCell = 130;
    container.addEventListener('touchstart', this._onTouchStart.bind(this), { passive: true });
    container.addEventListener('touchmove',  this._onTouchMove.bind(this),  { passive: true });
    container.addEventListener('touchend',   () => { this._pinchDist = null; }, { passive: true });
  }

  setSort(sort) { this._sort = sort; this.render(); }

  render() {
    const albums = this._lib.albums(this._sort);
    this._container.innerHTML = '';
    this._container.style.setProperty('--cell', this._cellSize + 'px');

    if (!albums.length) {
      this._container.innerHTML = '<div class="grid-empty">No music yet — tap "Scan" to add albums.</div>';
      return;
    }

    for (const alb of albums) {
      const card = document.createElement('div');
      card.className = 'alb-card';
      card.style.setProperty('--alb-color', alb.color);

      const art = document.createElement('div');
      art.className = 'alb-art';
      if (alb.coverUrl) {
        const img = document.createElement('img');
        img.src = alb.coverUrl;
        img.alt = alb.album;
        img.loading = 'lazy';
        art.appendChild(img);
      }

      const info = document.createElement('div');
      info.className = 'alb-info';
      info.innerHTML = `
        <div class="alb-name">${esc(alb.album)}</div>
        <div class="alb-artist">${esc(alb.artist)}</div>`;

      card.appendChild(art);
      card.appendChild(info);
      card.addEventListener('click', () => {
        const first = alb.tracks[0];
        if (first) this._onSelect(first.file, alb.album, alb.artist);
      });
      this._container.appendChild(card);
    }
  }

  _onTouchStart(e) {
    if (e.touches.length !== 2) return;
    this._pinchDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY,
    );
    this._pinchCell = this._cellSize;
  }

  _onTouchMove(e) {
    if (e.touches.length !== 2 || !this._pinchDist) return;
    const d = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY,
    );
    this._cellSize = Math.round(Math.min(240, Math.max(80, this._pinchCell * (d / this._pinchDist))));
    this._container.style.setProperty('--cell', this._cellSize + 'px');
  }
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
