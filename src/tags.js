// ─────────────────────────────────────────────────────────────────────────────
// tags.js — small dependency-free audio tag reader (pure: no DOM, no Blob).
//
// Reads title / artist / albumArtist / album / genre / track + disc numbers
// (and totals), embedded cover bytes, and a duration when the container gives
// it away cheaply, from:
//   ID3v2.2/2.3/2.4 (mp3 and anything starting with "ID3"),
//   FLAC Vorbis comments + PICTURE + STREAMINFO duration,
//   Ogg Vorbis / Ogg Opus comments (cover art in ogg is ignored),
//   MP4/M4A "ilst" atoms (+ mvhd duration), moov before OR after mdat.
//
// Input is a `reader` = { size, read(offset, length) -> Promise<Uint8Array> },
// so the same code runs on a File (fileReader, browser) and on a byte array
// (bytesReader, tests). It reads only the head of the file (plus, for MP4,
// the moov atom wherever it is). Never throws: unreadable or unknown input
// yields {} (an empty result), a half-corrupt tag yields what parsed so far.
//
// Result: { title?, artist?, albumArtist?, album?, genre?, year?,
//           trackNo?, trackTotal?, discNo?, discTotal?, durationSec?,
//           cover?: { mime, data: Uint8Array } }       (absent = not in the file)
// ─────────────────────────────────────────────────────────────────────────────

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

// ── readers ──────────────────────────────────────────────────────────────────
export function bytesReader(u8) {
  return { size: u8.length, read: async (o, n) => u8.subarray(Math.max(0, o), Math.min(u8.length, o + n)) };
}

/** Browser: a File/Blob. */
export function fileReader(file) {
  return {
    size: file.size,
    read: async (o, n) => new Uint8Array(await file.slice(Math.max(0, o), Math.max(0, o) + n).arrayBuffer()),
  };
}

// ── small helpers ────────────────────────────────────────────────────────────
const u32be = (d, p) => d[p] * 0x1000000 + ((d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]);
const u32le = (d, p) => (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0;
const syncsafe = (d, p) => ((d[p] & 0x7f) << 21) | ((d[p + 1] & 0x7f) << 14) | ((d[p + 2] & 0x7f) << 7) | (d[p + 3] & 0x7f);
const fourcc = (d, p) => String.fromCharCode(d[p], d[p + 1], d[p + 2], d[p + 3]);

function utf8(bytes) {
  try { return new TextDecoder('utf-8').decode(bytes); } catch { return ''; }
}
function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
function utf16(bytes, defaultLE) {
  let le = defaultLE, start = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { le = true; start = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { le = false; start = 2; }
  let s = '';
  for (let i = start; i + 1 < bytes.length; i += 2) {
    s += String.fromCharCode(le ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]);
  }
  return s;
}

/** Strip NULs / trailing junk and whitespace. */
const clean = (s) => String(s).replace(/\u0000+$/g, '').replace(/^﻿/, '').trim();

/** "3/12" | "3" | " 03 " -> { n: 3, total: 12|undefined }; garbage -> null. */
export function parseNumberPair(text) {
  if (typeof text !== 'string') return null;
  const m = /^\s*(\d{1,5})\s*(?:(?:\/|of)\s*(\d{1,5}))?\s*$/i.exec(text);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!(n >= 1)) return null;
  const total = m[2] ? parseInt(m[2], 10) : undefined;
  return { n, total: total >= 1 ? total : undefined };
}

function setPair(out, noKey, totKey, text) {
  const p = parseNumberPair(text);
  if (!p) return;
  if (out[noKey] == null) out[noKey] = p.n;
  if (p.total != null && out[totKey] == null) out[totKey] = p.total;
}

function genreFromId3(g) {
  const m = /^\((\d+)\)(.*)$/.exec(g);
  if (m) return m[2].trim() || ID3_GENRES[+m[1]] || g;
  if (/^\d+$/.test(g)) return ID3_GENRES[+g] || g;
  return g;
}

// ── ID3v2 ────────────────────────────────────────────────────────────────────
function id3Text(fd) {
  if (!fd.length) return [];
  const enc = fd[0];
  const body = fd.subarray(1);
  const parts = [];
  if (enc === 1 || enc === 2) {
    // split on UTF-16 double-NUL at an even offset
    let from = 0;
    for (let i = 0; i + 1 < body.length; i += 2) {
      if (body[i] === 0 && body[i + 1] === 0) { parts.push(body.subarray(from, i)); from = i + 2; }
    }
    if (from < body.length) parts.push(body.subarray(from));
    return parts.map((b) => clean(utf16(b, false))).filter((s) => s !== '');
  }
  let from = 0;
  for (let i = 0; i <= body.length; i++) {
    if (i === body.length || body[i] === 0) {
      if (i > from) parts.push(body.subarray(from, i));
      from = i + 1;
    }
  }
  return parts.map((b) => clean(enc === 3 ? utf8(b) : latin1(b))).filter((s) => s !== '');
}

function id3Picture(fd, short) {
  try {
    const enc = fd[0];
    let i = 1, mime = '';
    if (short) { mime = 'image/' + latin1(fd.subarray(1, 4)).toLowerCase().replace('jpg', 'jpeg'); i += 3; }
    else {
      const s = i;
      while (i < fd.length && fd[i] !== 0) i++;
      mime = latin1(fd.subarray(s, i)).toLowerCase(); i++;
    }
    i++; // picture type
    if (enc === 1 || enc === 2) {
      while (i + 1 < fd.length && !(fd[i] === 0 && fd[i + 1] === 0)) i += 2;
      i += 2;
    } else {
      while (i < fd.length && fd[i] !== 0) i++;
      i++;
    }
    if (i >= fd.length) return null;
    return { mime: mime && mime !== 'image/' ? mime : sniffImageMime(fd.subarray(i)), data: fd.slice(i) };
  } catch { return null; }
}

function sniffImageMime(d) {
  if (d[0] === 0xff && d[1] === 0xd8) return 'image/jpeg';
  if (d[0] === 0x89 && d[1] === 0x50) return 'image/png';
  if (d[0] === 0x47 && d[1] === 0x49) return 'image/gif';
  return 'image/jpeg';
}

/** Undo ID3 unsynchronisation (FF 00 -> FF). */
function unsync(d) {
  const out = new Uint8Array(d.length);
  let n = 0;
  for (let i = 0; i < d.length; i++) {
    out[n++] = d[i];
    if (d[i] === 0xff && d[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

async function parseId3(reader) {
  const head = await reader.read(0, 10);
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return null;
  const ver = head[3];
  if (ver < 2 || ver > 4) return {};
  const flags = head[5];
  const tagSize = syncsafe(head, 6);
  const total = Math.min(tagSize, Math.max(0, reader.size - 10), 16 * 1024 * 1024);
  let d = await reader.read(10, total);
  if (flags & 0x80 && ver < 4) d = unsync(d); // whole-tag unsync (v2.2/2.3)
  const out = {};
  const short = ver === 2;
  let pos = 0;
  if (flags & 0x40 && ver >= 3 && d.length >= 4) { // extended header
    pos = ver === 4 ? syncsafe(d, 0) : u32be(d, 0) + 4;
  }
  const hdr = short ? 6 : 10;
  while (pos + hdr <= d.length) {
    if (d[pos] === 0) break; // padding
    const id = short ? latin1(d.subarray(pos, pos + 3)) : fourcc(d, pos);
    const size = short ? (d[pos + 3] << 16) | (d[pos + 4] << 8) | d[pos + 5]
      : ver === 4 ? syncsafe(d, pos + 4) : u32be(d, pos + 4);
    const fflags = short ? 0 : d[pos + 9];
    const ds = pos + hdr;
    if (size <= 0 || ds + size > d.length) break;
    let fd = d.subarray(ds, ds + size);
    pos = ds + size;
    if (ver === 4) {
      if (fflags & 0x01) fd = fd.subarray(4);        // data length indicator
      if (fflags & 0x02) fd = unsync(fd);            // per-frame unsync
      if (fflags & 0x0c) continue;                   // compressed / encrypted: skip
    } else if (ver === 3 && (fflags & 0xc0)) continue; // compressed / encrypted
    switch (id) {
      case 'TIT2': case 'TT2': out.title ??= id3Text(fd)[0]; break;
      case 'TPE1': case 'TP1': out.artist ??= id3Text(fd)[0]; break;
      case 'TPE2': case 'TP2': out.albumArtist ??= id3Text(fd)[0]; break;
      case 'TALB': case 'TAL': out.album ??= id3Text(fd)[0]; break;
      case 'TRCK': case 'TRK': setPair(out, 'trackNo', 'trackTotal', id3Text(fd)[0]); break;
      case 'TPOS': case 'TPA': setPair(out, 'discNo', 'discTotal', id3Text(fd)[0]); break;
      case 'TYER': case 'TYE': case 'TDRC': {
        const y = /(\d{4})/.exec(id3Text(fd)[0] || '');
        if (y) out.year ??= parseInt(y[1], 10);
        break;
      }
      case 'TLEN': case 'TLE': {
        const ms = parseInt(id3Text(fd)[0], 10);
        if (ms > 0) out.durationSec ??= ms / 1000;
        break;
      }
      case 'TCON': case 'TCO': {
        const g = id3Text(fd)[0];
        if (g) out.genre ??= genreFromId3(g).trim();
        break;
      }
      case 'APIC': case 'PIC':
        if (!out.cover) { const c = id3Picture(fd, short); if (c) out.cover = c; }
        break;
      default: break;
    }
  }
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === '') delete out[k];
  return out;
}

// ── Vorbis comments (FLAC + Ogg) ─────────────────────────────────────────────
function parseVorbisComment(d, start, end) {
  const out = {};
  try {
    let p = start;
    const vendor = u32le(d, p); p += 4 + vendor;
    const count = u32le(d, p); p += 4;
    for (let i = 0; i < count && p + 4 <= end; i++) {
      const len = u32le(d, p); p += 4;
      if (p + len > end) break;
      const c = utf8(d.subarray(p, p + len)); p += len;
      const eq = c.indexOf('=');
      if (eq < 1) continue;
      const key = c.slice(0, eq).toUpperCase().replace(/[ _]/g, '');
      const val = clean(c.slice(eq + 1));
      if (!val) continue;
      switch (key) {
        case 'TITLE': out.title ??= val; break;
        case 'ARTIST': out.artist ??= val; break;
        case 'ALBUMARTIST': out.albumArtist ??= val; break;
        case 'ALBUM': out.album ??= val; break;
        case 'GENRE': out.genre ??= val; break;
        case 'TRACKNUMBER': case 'TRACK': setPair(out, 'trackNo', 'trackTotal', val); break;
        case 'TRACKTOTAL': case 'TOTALTRACKS': { const t = parseNumberPair(val); if (t) out.trackTotal ??= t.n; break; }
        case 'DISCNUMBER': case 'DISC': setPair(out, 'discNo', 'discTotal', val); break;
        case 'DISCTOTAL': case 'TOTALDISCS': { const t = parseNumberPair(val); if (t) out.discTotal ??= t.n; break; }
        case 'DATE': case 'YEAR': { const y = /(\d{4})/.exec(val); if (y) out.year ??= parseInt(y[1], 10); break; }
        default: break;
      }
    }
  } catch { /* keep what we have */ }
  return out;
}

async function parseFlac(reader) {
  const head = await reader.read(0, 4);
  if (head.length < 4 || fourcc(head, 0) !== 'fLaC') return null;
  const out = {};
  let pos = 4;
  for (let guard = 0; guard < 64; guard++) {
    const h = await reader.read(pos, 4);
    if (h.length < 4) break;
    const last = (h[0] & 0x80) !== 0;
    const type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    const bodyAt = pos + 4;
    if (type === 0 && len >= 18) { // STREAMINFO: 20-bit rate, 36-bit total samples
      const b = await reader.read(bodyAt, 18);
      const rate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      const samples = (b[13] & 0x0f) * 0x100000000 + u32be(b, 14);
      if (rate > 0 && samples > 0) out.durationSec = samples / rate;
    } else if (type === 4 && len <= 4 * 1024 * 1024) { // VORBIS_COMMENT
      const b = await reader.read(bodyAt, len);
      Object.assign(out, parseVorbisComment(b, 0, b.length));
    } else if (type === 6 && !out.cover && len <= 8 * 1024 * 1024) { // PICTURE
      const b = await reader.read(bodyAt, len);
      try {
        let p = 4; // picture type
        const ml = u32be(b, p); p += 4;
        const mime = latin1(b.subarray(p, p + ml)); p += ml;
        const dl = u32be(b, p); p += 4 + dl + 16;
        const n = u32be(b, p); p += 4;
        if (p + n <= b.length && n > 0) out.cover = { mime: mime || sniffImageMime(b.subarray(p)), data: b.slice(p, p + n) };
      } catch { /* ignore bad picture */ }
    }
    pos = bodyAt + len;
    if (last) break;
  }
  return out;
}

/** Walk the first Ogg pages, assembling packets 1 and 2 (identification + comments). */
async function parseOgg(reader) {
  const head = await reader.read(0, 4);
  if (head.length < 4 || fourcc(head, 0) !== 'OggS') return null;
  const MAX = 512 * 1024;
  const d = await reader.read(0, Math.min(reader.size, MAX));
  const packets = [];
  let cur = [];
  let pos = 0;
  while (pos + 27 <= d.length && fourcc(d, pos) === 'OggS' && packets.length < 2) {
    const nseg = d[pos + 26];
    const segs = d.subarray(pos + 27, pos + 27 + nseg);
    let p = pos + 27 + nseg;
    for (let i = 0; i < nseg && packets.length < 2; i++) {
      const l = segs[i];
      cur.push(d.subarray(p, p + l)); p += l;
      if (l < 255) { packets.push(concat(cur)); cur = []; }
    }
    pos = p;
  }
  if (packets.length < 2) return {};
  const [idp, cm] = packets;
  let out = {};
  if (cm[0] === 3 && latin1(cm.subarray(1, 7)) === 'vorbis') out = parseVorbisComment(cm, 7, cm.length);
  else if (latin1(cm.subarray(0, 8)) === 'OpusTags') out = parseVorbisComment(cm, 8, cm.length);
  void idp;
  return out;
}

function concat(parts) {
  if (parts.length === 1) return parts[0];
  const n = parts.reduce((a, b) => a + b.length, 0);
  const o = new Uint8Array(n);
  let p = 0;
  for (const b of parts) { o.set(b, p); p += b.length; }
  return o;
}

// ── MP4 / M4A ────────────────────────────────────────────────────────────────
/** Iterate atoms in d[start,end): cb(type, bodyStart, bodyEnd). */
function walkAtoms(d, start, end, cb) {
  let p = start;
  while (p + 8 <= end) {
    let size = u32be(d, p);
    const type = fourcc(d, p + 4);
    let hdr = 8;
    if (size === 1) { size = u32be(d, p + 8) * 0x100000000 + u32be(d, p + 12); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    if (cb(type, p + hdr, p + size) === false) return;
    p += size;
  }
}

function mp4DataAtom(d, s, e) { // -> { type, bytes } of the first 'data' child
  let found = null;
  walkAtoms(d, s, e, (t, bs, be) => {
    if (t === 'data' && be - bs >= 8) { found = { type: u32be(d, bs) & 0xffffff, bytes: d.subarray(bs + 8, be) }; return false; }
    return true;
  });
  return found;
}

function parseIlst(d, s, e, out) {
  walkAtoms(d, s, e, (t, bs, be) => {
    const da = mp4DataAtom(d, bs, be);
    if (!da) return true;
    const text = () => clean(utf8(da.bytes));
    switch (t) {
      case '©nam': out.title ??= text(); break;
      case '©ART': out.artist ??= text(); break;
      case 'aART': out.albumArtist ??= text(); break;
      case '©alb': out.album ??= text(); break;
      case '©gen': out.genre ??= text(); break;
      case '©day': { const y = /(\d{4})/.exec(text()); if (y) out.year ??= parseInt(y[1], 10); break; }
      case 'gnre': { const g = ID3_GENRES[(da.bytes[1] || 0) - 1]; if (g) out.genre ??= g; break; }
      case 'trkn': case 'disk': {
        const b = da.bytes; // 2 reserved, 2 number, 2 total
        const n = b.length >= 4 ? (b[2] << 8) | b[3] : 0;
        const tot = b.length >= 6 ? (b[4] << 8) | b[5] : 0;
        const nk = t === 'trkn' ? 'trackNo' : 'discNo', tk = t === 'trkn' ? 'trackTotal' : 'discTotal';
        if (n >= 1) out[nk] ??= n;
        if (tot >= 1) out[tk] ??= tot;
        break;
      }
      case 'covr':
        if (!out.cover && da.bytes.length) out.cover = { mime: da.type === 14 ? 'image/png' : 'image/jpeg', data: da.bytes.slice() };
        break;
      default: break;
    }
    return true;
  });
}

async function parseMp4(reader) {
  const head = await reader.read(0, 12);
  if (head.length < 12 || fourcc(head, 4) !== 'ftyp') return null;
  const out = {};
  let pos = 0;
  for (let guard = 0; guard < 4096 && pos + 8 <= reader.size; guard++) {
    const h = await reader.read(pos, 16);
    if (h.length < 8) break;
    let size = u32be(h, 0);
    const type = fourcc(h, 4);
    let hdr = 8;
    if (size === 1 && h.length >= 16) { size = u32be(h, 8) * 0x100000000 + u32be(h, 12); hdr = 16; }
    else if (size === 0) size = reader.size - pos;
    if (size < hdr) break;
    if (type === 'moov') {
      if (size > 32 * 1024 * 1024) break;
      const m = await reader.read(pos + hdr, size - hdr);
      walkAtoms(m, 0, m.length, (t, bs, be) => {
        if (t === 'mvhd') {
          const v = m[bs];
          const ts = v === 1 ? u32be(m, bs + 20) : u32be(m, bs + 12);
          const dur = v === 1 ? u32be(m, bs + 24) * 0x100000000 + u32be(m, bs + 28) : u32be(m, bs + 16);
          if (ts > 0 && dur > 0) out.durationSec = dur / ts;
        } else if (t === 'udta') {
          walkAtoms(m, bs, be, (t2, bs2, be2) => {
            if (t2 === 'meta') {
              walkAtoms(m, bs2 + 4, be2, (t3, bs3, be3) => { if (t3 === 'ilst') parseIlst(m, bs3, be3, out); return true; });
            }
            return true;
          });
        } else if (t === 'meta') { // some writers put meta directly under moov
          walkAtoms(m, bs + 4, be, (t3, bs3, be3) => { if (t3 === 'ilst') parseIlst(m, bs3, be3, out); return true; });
        }
        return true;
      });
      break;
    }
    pos += size;
  }
  return out;
}

// ── entry points ─────────────────────────────────────────────────────────────

/** Read tags from `reader`, picking the parser by magic bytes. Never throws. */
export async function readTags(reader) {
  const attempts = [parseId3, parseFlac, parseOgg, parseMp4];
  for (const fn of attempts) {
    try {
      const r = await fn(reader);
      if (r) {
        for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k];
        return r;
      }
    } catch { /* try the next format */ }
  }
  return {};
}

export const readFileTags = (file) => readTags(fileReader(file));
export const readBytesTags = (u8) => readTags(bytesReader(u8));
