// ─────────────────────────────────────────────────────────────────────────────
// device-file.js — a File-like object backed by chunked native reads.
//
// The rest of the app treats a library track's `file` as a browser File and only ever calls:
//   file.name / file.size / file.type / file.lastModified
//   file.slice(a, b).arrayBuffer()      (tags.js head/tail windows via fileReader)
//   file.arrayBuffer()                  (track.js loadFile -> decodeAudioData; queue preload)
// DeviceFile implements exactly that, so tags.js / track.js / queue / mixtape code run UNCHANGED.
// `stream()` is deliberately absent.
//
// The bytes come from backend.read({ id, offset, length }) -> { data: base64, bytes, eof } (the Capacitor
// DeviceLibrary.read call). Every read goes through ONE shared limiter so a library scan, a preload and a
// decode can never pile up unbounded base64 strings in the WebView:
//   chunkBytes       size of one native read (default 1 MiB; hard-capped at 4 MiB = the Java MAX_READ)
//   maxConcurrent    native reads in flight at once (default 3)
//   maxInflightBytes total bytes requested but not yet copied out (default 6 MiB)
// A failed chunk is retried once; a second failure rejects the whole read with a DeviceReadError and no
// further chunks are started for it. A short read (the file shrank under us) is also an error.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_CHUNK = 4 * 1024 * 1024;
export const DEFAULT_CHUNK = 1024 * 1024;
/** Largest single arrayBuffer() / bytes() read. Whole-file reads allocate the file in memory (and decode needs more); beyond this fail clearly. */
export const MAX_WHOLE_READ = 512 * 1024 * 1024;

export class DeviceReadError extends Error {
  constructor(message, { cause, id, offset } = {}) {
    super(message);
    this.name = 'DeviceReadError';
    this.id = id;
    this.offset = offset;
    if (cause) this.cause = cause;
  }
}

/** Weighted semaphore: at most `maxConcurrent` holders and `maxBytes` outstanding (one oversized holder may run alone). */
export function createReadLimiter({ maxConcurrent = 3, maxBytes = 6 * 1024 * 1024 } = {}) {
  let active = 0;
  let bytes = 0;
  let peakActive = 0;
  let peakBytes = 0;
  const waiters = [];
  const fits = (w) => active < maxConcurrent && (active === 0 || bytes + w <= maxBytes);
  function pump() {
    while (waiters.length && fits(waiters[0].w)) {
      const { w, resolve } = waiters.shift();
      active++; bytes += w;
      peakActive = Math.max(peakActive, active);
      peakBytes = Math.max(peakBytes, bytes);
      resolve(() => { active--; bytes -= w; pump(); });
    }
  }
  return {
    acquire(w) { return new Promise((resolve) => { waiters.push({ w, resolve }); pump(); }); },
    stats() { return { active, bytes, queued: waiters.length, peakActive, peakBytes }; },
  };
}

const defaultLimiter = createReadLimiter();

/** base64 -> bytes written into `target` at `at`; returns the byte count. Throws on a malformed string. */
export function decodeBase64Into(b64, target, at = 0) {
  if (!b64) return 0;
  const bin = atob(b64);
  const n = bin.length;
  if (at + n > target.length) throw new RangeError('chunk larger than the destination');
  for (let i = 0; i < n; i++) target[at + i] = bin.charCodeAt(i);
  return n;
}

// Blob.slice index semantics: undefined = default, NaN = 0, +-Infinity clamp, negatives count from the end.
const clampIdx = (v, size, dflt) => {
  if (v === undefined) return dflt;
  let n = Number(v);
  if (Number.isNaN(n)) n = 0;
  n = n === Infinity ? size : n === -Infinity ? 0 : Math.trunc(n);
  if (n < 0) n = Math.max(0, size + n);
  return Math.min(n, size);
};

/** A [start, end) window of a DeviceFile. Blob-like: size, type, slice(), arrayBuffer(), bytes(). */
export class DeviceBlob {
  constructor(file, start, end, type = '') {
    this._file = file; this._start = start; this._end = Math.max(start, end);
    this.size = this._end - this._start;
    this.type = type;
  }
  slice(start, end, type) {
    const s = clampIdx(start, this.size, 0), e = clampIdx(end, this.size, this.size);
    return new DeviceBlob(this._file, this._start + s, this._start + Math.max(s, e), type === undefined ? this.type : String(type));
  }
  async arrayBuffer() { return this._file._readRange(this._start, this._end); }
  async bytes() { return new Uint8Array(await this.arrayBuffer()); }
}

export class DeviceFile {
  /**
   * @param {object} o
   * @param {{read:Function}} o.backend   anything with read({id, offset, length}) -> Promise<{data, bytes, eof}>
   * @param {number|string} o.id          the MediaStore row id
   */
  constructor({ backend, id, name = '', size = 0, type = '', lastModified = 0, chunkBytes = DEFAULT_CHUNK, limiter = defaultLimiter, retries = 1 } = {}) {
    if (!backend || typeof backend.read !== 'function') throw new TypeError('DeviceFile needs a backend with read()');
    this._backend = backend; this._id = id; this._limiter = limiter; this._retries = retries;
    this._chunk = Math.max(16 * 1024, Math.min(MAX_CHUNK, chunkBytes | 0 || DEFAULT_CHUNK));
    this.name = String(name); this.size = Math.max(0, Number(size) || 0); this.type = String(type);
    this.lastModified = Number(lastModified) || 0;
    this.webkitRelativePath = '';
    this.deviceId = id;
    this.isDeviceFile = true;
    this.reads = 0;   // native reads issued (diagnostics / tests)
  }

  slice(start, end, type) {
    const s = clampIdx(start, this.size, 0), e = clampIdx(end, this.size, this.size);
    return new DeviceBlob(this, s, Math.max(s, e), type === undefined ? '' : String(type));
  }
  async arrayBuffer() { return this._readRange(0, this.size); }
  async bytes() { return new Uint8Array(await this.arrayBuffer()); }
  get [Symbol.toStringTag]() { return 'File'; }

  async _readChunk(offset, length) {
    let lastErr;
    for (let attempt = 0; attempt <= this._retries; attempt++) {
      const release = await this._limiter.acquire(length);
      try {
        this.reads++;
        const r = await this._backend.read({ id: this._id, offset, length });
        return r || {};
      } catch (e) {
        lastErr = e;
      } finally { release(); }
    }
    throw new DeviceReadError(`native read failed at ${offset} (+${length}) of ${this.name || this._id}: ${lastErr?.message || lastErr}`, { cause: lastErr, id: this._id, offset });
  }

  async _readRange(start, end) {
    const total = end - start;
    if (total <= 0) return new ArrayBuffer(0);
    if (total > MAX_WHOLE_READ) throw new DeviceReadError(`${this.name || this._id} is too large to load at once (${Math.round(total / 1048576)} MB; limit ${MAX_WHOLE_READ / 1048576} MB)`, { id: this._id, offset: start });
    const out = new Uint8Array(total);
    const chunks = [];
    for (let o = 0; o < total; o += this._chunk) chunks.push([o, Math.min(this._chunk, total - o)]);
    let next = 0, failed = null;
    const lanes = Math.min(chunks.length, 3);
    const lane = async () => {
      while (!failed && next < chunks.length) {
        const [rel, len] = chunks[next++];
        try {
          const r = await this._readChunk(start + rel, len);
          const got = decodeBase64Into(r.data || '', out, rel);
          if (got !== len) {
            throw new DeviceReadError(`short read at ${start + rel}: wanted ${len}, got ${got} (file changed?) for ${this.name || this._id}`, { id: this._id, offset: start + rel });
          }
        } catch (e) {
          failed = e instanceof DeviceReadError ? e : new DeviceReadError(`bad chunk at ${start + rel}: ${e?.message || e}`, { cause: e, id: this._id, offset: start + rel });
        }
      }
    };
    await Promise.all(Array.from({ length: lanes }, lane));
    if (failed) throw failed;
    return out.buffer;
  }
}
