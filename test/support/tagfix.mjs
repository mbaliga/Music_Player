// tagfix.mjs — generates tiny tagged audio-like byte arrays for tags.js tests
// (and the Playwright fixtures). Not valid audio: just valid TAG structure
// followed by filler, which is all a tag reader looks at.
const enc = new TextEncoder();
export const cat = (...parts) => {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const o = new Uint8Array(n); let q = 0;
  for (const p of parts) { o.set(p, q); q += p.length; }
  return o;
};
const be32 = (n) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const le32 = (n) => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
const ss32 = (n) => Uint8Array.of((n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127);
const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 255)); // latin1 (MP4 '\u00a9nam' is one byte)
export const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9);

// ── ID3v2 ──
function id3Text(s, encoding) {
  if (encoding === 3) return cat(Uint8Array.of(3), enc.encode(s));
  if (encoding === 1) {
    const b = new Uint8Array(2 + s.length * 2); b[0] = 0xff; b[1] = 0xfe;
    for (let i = 0; i < s.length; i++) { b[2 + 2 * i] = s.charCodeAt(i) & 255; b[3 + 2 * i] = s.charCodeAt(i) >> 8; }
    return cat(Uint8Array.of(1), b);
  }
  if (encoding === 2) {
    const b = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) { b[2 * i] = s.charCodeAt(i) >> 8; b[2 * i + 1] = s.charCodeAt(i) & 255; }
    return cat(Uint8Array.of(2), b);
  }
  return cat(Uint8Array.of(0), Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 255)));
}
function id3Frame(ver, id, data) {
  if (ver === 2) return cat(ascii(id), Uint8Array.of(data.length >> 16, (data.length >> 8) & 255, data.length & 255), data);
  const size = ver === 4 ? ss32(data.length) : be32(data.length);
  return cat(ascii(id), size, Uint8Array.of(0, 0), data);
}
const IDS = {
  2: { title: 'TT2', artist: 'TP1', albumArtist: 'TP2', album: 'TAL', track: 'TRK', disc: 'TPA', genre: 'TCO' },
  3: { title: 'TIT2', artist: 'TPE1', albumArtist: 'TPE2', album: 'TALB', track: 'TRCK', disc: 'TPOS', genre: 'TCON' },
  4: { title: 'TIT2', artist: 'TPE1', albumArtist: 'TPE2', album: 'TALB', track: 'TRCK', disc: 'TPOS', genre: 'TCON' },
};
/** tags: {title, artist, albumArtist, album, track:'3/12', disc:'1/2', genre, cover:Uint8Array}; ver 2|3|4; encoding 0|1|2|3 */
export function makeMp3(tags, { ver = 3, encoding = 0, padding = 16, audioBytes = 2000, unsync = false } = {}) {
  const ids = IDS[ver];
  const frames = [];
  for (const k of ['title', 'artist', 'albumArtist', 'album', 'track', 'disc', 'genre']) {
    if (tags[k] != null) frames.push(id3Frame(ver, ids[k], id3Text(String(tags[k]), ver === 2 && encoding > 1 ? 0 : encoding)));
  }
  if (tags.cover) {
    frames.push(ver === 2
      ? id3Frame(2, 'PIC', cat(Uint8Array.of(0), ascii('JPG'), Uint8Array.of(3, 0), tags.cover))
      : id3Frame(ver, 'APIC', cat(Uint8Array.of(0), ascii('image/jpeg'), Uint8Array.of(0, 3, 0), tags.cover)));
  }
  let body = cat(...frames, new Uint8Array(padding));
  let flags = 0;
  if (unsync) { // naive: insert 00 after every FF (v2.3 whole-tag unsync)
    const o = []; for (const b of body) { o.push(b); if (b === 0xff) o.push(0); } body = Uint8Array.from(o); flags = 0x80;
  }
  const hdr = cat(ascii('ID3'), Uint8Array.of(ver, 0, flags), ss32(body.length));
  return cat(hdr, body, new Uint8Array(audioBytes).fill(0x55));
}

// ── Vorbis comment / FLAC / Ogg ──
export function vorbisComment(pairs, { prefix = new Uint8Array(0) } = {}) {
  const vendor = ascii('fixture');
  const items = pairs.map(([k, v]) => { const b = enc.encode(`${k}=${v}`); return cat(le32(b.length), b); });
  return cat(prefix, le32(vendor.length), vendor, le32(items.length), ...items);
}
export function makeFlac(pairs, { durationSec = 0, rate = 44100, cover = null, audioBytes = 3000 } = {}) {
  const blocks = [];
  const si = new Uint8Array(34);
  const samples = Math.round(durationSec * rate);
  si[10] = (rate >> 12) & 255; si[11] = (rate >> 4) & 255; si[12] = ((rate & 15) << 4) | (1 << 1) | 0; // 2ch, 16bit high bit
  si[13] = ((15 & 0xf) << 4) | (Math.floor(samples / 0x100000000) & 15);
  si.set(be32(samples >>> 0), 14);
  blocks.push([0, si]);
  blocks.push([4, vorbisComment(pairs)]);
  if (cover) {
    blocks.push([6, cat(be32(3), be32(10), ascii('image/jpeg'), be32(0), be32(0), be32(0), be32(0), be32(0), be32(cover.length), cover)]);
  }
  const out = [ascii('fLaC')];
  blocks.forEach(([t, b], i) => {
    out.push(Uint8Array.of((i === blocks.length - 1 ? 0x80 : 0) | t, b.length >> 16, (b.length >> 8) & 255, b.length & 255), b);
  });
  out.push(new Uint8Array(audioBytes).fill(0x33));
  return cat(...out);
}
function oggPage(seq, packets, { bos = false, serial = 1 } = {}) {
  const segs = []; const data = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { segs.push(255); n -= 255; }
    segs.push(n); data.push(p);
  }
  return cat(ascii('OggS'), Uint8Array.of(0, bos ? 2 : 0), new Uint8Array(8), le32(serial), le32(seq), new Uint8Array(4),
    Uint8Array.of(segs.length), Uint8Array.from(segs), ...data);
}
export function makeOgg(pairs, { opus = false } = {}) {
  const idp = opus ? cat(ascii('OpusHead'), new Uint8Array(11)) : cat(Uint8Array.of(1), ascii('vorbis'), new Uint8Array(23));
  const cm = opus ? vorbisComment(pairs, { prefix: ascii('OpusTags') })
    : cat(vorbisComment(pairs, { prefix: cat(Uint8Array.of(3), ascii('vorbis')) }), Uint8Array.of(1));
  return cat(oggPage(0, [idp], { bos: true }), oggPage(1, [cm]), new Uint8Array(500).fill(0x11));
}

// ── MP4 ──
const atom = (type, ...kids) => { const b = cat(...kids); return cat(be32(8 + b.length), ascii(type), b); };
const dataAtom = (type, payload) => atom('data', be32(type), be32(0), payload);
const utf8Item = (key, s) => atom(key, dataAtom(1, enc.encode(s)));
/** moovFirst=false puts a big mdat before moov (atoms are skipped by size). */
export function makeM4a(t, { durationSec = 0, timescale = 1000, moovFirst = true, cover = null } = {}) {
  const items = [];
  if (t.title != null) items.push(utf8Item('©nam', t.title));
  if (t.artist != null) items.push(utf8Item('©ART', t.artist));
  if (t.albumArtist != null) items.push(utf8Item('aART', t.albumArtist));
  if (t.album != null) items.push(utf8Item('©alb', t.album));
  if (t.genre != null) items.push(utf8Item('©gen', t.genre));
  if (t.track) items.push(atom('trkn', dataAtom(0, Uint8Array.of(0, 0, t.track[0] >> 8, t.track[0] & 255, 0, t.track[1] || 0, 0, 0))));
  if (t.disc) items.push(atom('disk', dataAtom(0, Uint8Array.of(0, 0, 0, t.disc[0], 0, t.disc[1] || 0))));
  if (cover) items.push(atom('covr', dataAtom(13, cover)));
  const mvhd = atom('mvhd', Uint8Array.of(0, 0, 0, 0), be32(0), be32(0), be32(timescale), be32(Math.round(durationSec * timescale)), new Uint8Array(80));
  const ilst = atom('ilst', ...items);
  const meta = atom('meta', Uint8Array.of(0, 0, 0, 0), atom('hdlr', new Uint8Array(24)), ilst);
  const moov = atom('moov', mvhd, atom('trak', new Uint8Array(40)), atom('udta', meta));
  const ftyp = atom('ftyp', ascii('M4A '), be32(0), ascii('M4A mp42isom'));
  const mdat = atom('mdat', new Uint8Array(5000).fill(0x77));
  return moovFirst ? cat(ftyp, moov, mdat) : cat(ftyp, mdat, moov);
}
