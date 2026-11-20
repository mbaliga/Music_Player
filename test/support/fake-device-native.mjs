// A fake of the native DeviceLibrary plugin (native/android/DeviceLibraryPlugin.java), same method names and
// result shapes. Pure ES module with no Node imports: the node tests AND the Playwright harness page use it.
//
//   const fake = createFakeNative({ rows: [...], bytesFor: (row) => Uint8Array, permission: 'prompt' });
//   fake.rows            the MediaStore table (mutate it, then call fake.touch() to bump the generation)
//   fake.calls           per-method call counts; fake.log = every call in order
//   fake.maxInflightReads / fake.fail(...) hooks for concurrency and error tests

export function makeRow(i, over = {}) {
  const id = 1000 + i;
  return {
    id, name: `Track ${i}.mp3`, title: `Track ${i}`, artist: 'Artist', album: 'Album', albumId: 7, albumArtist: '', genre: '',
    track: i + 1, cdTrack: '', disc: '', year: 2001, durationMs: 180000, size: 4000 + i, mime: 'audio/mpeg', modified: 1700000000 + i,
    data: '', relativePath: 'Music/Artist/Album/', volume: 'external_primary',
    isMusic: true, isRingtone: false, isAlarm: false, isNotification: false, isPodcast: false, ...over,
  };
}

export function createFakeNative({ rows = [], bytesFor = null, permission = 'prompt', afterRequest = 'granted', sdk = 34, art = {} } = {}) {
  const f = {
    rows, sdk, permission, afterRequest,
    calls: {}, log: [], listeners: new Map(), observing: false,
    failReads: 0,            // next N read() calls reject
    failReadAt: null,        // reject any read whose offset >= this
    readDelay: 0, inflightReads: 0, maxInflightReads: 0, bytesServed: 0,
    settingsOpened: 0, requested: 0,
    art,
  };
  const count = (n, a) => { f.calls[n] = (f.calls[n] || 0) + 1; f.log.push([n, a]); };
  const granted = () => f.permission === 'granted';
  const denyIfNeeded = () => { if (!granted()) { const e = new Error('permission'); e.code = 'denied'; throw e; } };
  const bytes = (row) => (bytesFor ? bytesFor(row) : new Uint8Array(row.size).map((_, i) => (i * 31 + row.id) & 255));
  const b64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };

  f.touch = () => { for (const fn of f.listeners.get('libraryChanged') || []) fn({}); };
  f.permissionStatus = async () => { count('permissionStatus'); return { state: f.permission, sdk: f.sdk }; };
  f.requestAccess = async () => {
    count('requestAccess'); f.requested++;
    if (f.permission === 'prompt' || f.permission === 'prompt-with-rationale') f.permission = f.afterRequest;
    return { state: f.permission, sdk: f.sdk };
  };
  f.openSettings = async () => { count('openSettings'); f.settingsOpened++; };
  f.generation = async () => {
    count('generation'); denyIfNeeded();
    let newest = 0;
    for (const r of f.rows) newest = Math.max(newest, r.modified);
    return { generation: `c|${f.rows.length}|${newest}|${f.genBump || 0}`, count: f.rows.length };
  };
  f.bump = () => { f.genBump = (f.genBump || 0) + 1; };
  f.signatures = async () => {
    count('signatures'); denyIfNeeded();
    const sig = [];
    for (const r of [...f.rows].sort((a, b) => a.id - b.id)) sig.push(r.id, r.size, r.modified);
    return { sig };
  };
  f.records = async ({ ids }) => {
    count('records', ids.length); denyIfNeeded();
    if (ids.length > 800) throw new Error('too many ids');
    const set = new Set(ids);
    return { items: f.rows.filter((r) => set.has(r.id)).map((r) => ({ ...r })) };
  };
  f.read = async ({ id, offset, length }) => {
    count('read'); denyIfNeeded();
    f.inflightReads++; f.maxInflightReads = Math.max(f.maxInflightReads, f.inflightReads);
    try {
      if (f.readDelay) await new Promise((r) => setTimeout(r, f.readDelay));
      if (f.failReads > 0) { f.failReads--; throw new Error('EIO'); }
      if (f.failReadAt !== null && offset >= f.failReadAt) throw new Error('EIO at offset');
      const row = f.rows.find((r) => r.id === id);
      if (!row) { const e = new Error('not found'); e.code = 'ENOENT'; throw e; }
      const all = bytes(row);
      const end = Math.min(all.length, offset + Math.min(length, 4 * 1024 * 1024));
      const part = all.subarray(Math.min(offset, all.length), end);
      f.bytesServed += part.length;
      return { data: b64(part), bytes: part.length, size: all.length, eof: end >= all.length };
    } finally { f.inflightReads--; }
  };
  f.art = async ({ id }) => { count('art'); denyIfNeeded(); return f.art[id] ? { data: f.art[id], mime: 'image/jpeg' } : { data: '' }; };
  f.addListener = async (name, fn) => {
    const set = f.listeners.get(name) || new Set(); set.add(fn); f.listeners.set(name, set);
    return { remove: () => set.delete(fn) };
  };
  f.startObserving = async () => { count('startObserving'); f.observing = true; };
  f.stopObserving = async () => { count('stopObserving'); f.observing = false; };
  return f;
}

// ── generated audio for the browser harness: a WAV with a sine tone, optionally behind an ID3v2.3 tag ──
export function makeWav(seconds = 2, freq = 440, rate = 22050) {
  const n = Math.floor(seconds * rate);
  const buf = new Uint8Array(44 + n * 2);
  const dv = new DataView(buf.buffer);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 9000), true);
  return buf;
}

/** ID3v2.3 header + TIT2/TPE1/TALB frames (latin1), then `rest` bytes. */
export function withId3(frames, rest = new Uint8Array(0), pad = 0) {
  const enc = (s) => Uint8Array.from([0, ...[...s].map((c) => c.charCodeAt(0) & 255)]);
  const parts = [];
  for (const [id, text] of Object.entries(frames)) {
    const body = enc(text);
    const h = new Uint8Array(10);
    for (let i = 0; i < 4; i++) h[i] = id.charCodeAt(i);
    new DataView(h.buffer).setUint32(4, body.length);
    parts.push(h, body);
  }
  if (pad) parts.push(new Uint8Array(pad));
  const size = parts.reduce((a, p) => a + p.length, 0);
  const head = Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127]);
  const out = new Uint8Array(10 + size + rest.length);
  out.set(head, 0);
  let o = 10;
  for (const p of parts) { out.set(p, o); o += p.length; }
  out.set(rest, o);
  return out;
}
