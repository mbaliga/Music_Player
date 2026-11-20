// ─────────────────────────────────────────────────────────────────────────────
// covers.js — album covers for the turntable library (docs/TURNTABLE_LIBRARY.md).
//
//   * procedural covers: the prototype's five painted styles, derived
//     deterministically from an album's `coverSeed` (hashSeed(artist+title));
//   * embedded artwork: coverBlobUrl(bytes, mime) turns tags.js cover bytes into
//     a tracked object URL (revoked by revokeCoverUrl / revokeAllCoverUrls);
//     the library component draws such an image DOWNSCALED (<= 512 px) into a
//     small canvas, so a full-size decoded bitmap is never kept per album;
//   * a small LRU cache of those canvases (hard cap on the number alive).
//
// Nothing here touches the DOM at import time. Everything that needs a canvas /
// Image / URL takes it as an injectable (tests use fakes).
// ─────────────────────────────────────────────────────────────────────────────

export const COVER_STYLE_COUNT = 5;
export const COVER_MAX_PX = 512;          // largest side of a cover canvas (memory cap)
export const COVER_CACHE_MAX = 20;        // canvases alive at once (the flow shows at most 9)
const FONT = '"Helvetica Neue",Helvetica,Arial,sans-serif';

/** FNV-1a (32-bit) over UTF-16 code units: stable across platforms. */
export function hashSeed(str) {
  const s = String(str ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** murmur3 finaliser: decorrelates the bits we read different fields from. */
function mix(x) {
  x = (x ^ (x >>> 16)) >>> 0; x = Math.imul(x, 0x85ebca6b) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0; x = Math.imul(x, 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * What a procedural cover looks like, from a seed alone.
 * -> { hue:[h0,h1], style:0..4, idx:0..4, name, footer }
 * `name` / `footer` are display strings (title, artist) drawn on the cover.
 * An album may carry its own `coverSpec` ({hue, style, idx?}) to override.
 */
export function coverSpec(seed, title = '', artist = '') {
  const m = mix((seed >>> 0) || 1);
  const m2 = mix(m ^ 0x9e3779b9);
  const h0 = m % 360;
  const h1 = (h0 + 30 + (m2 % 140)) % 360;
  return {
    hue: [h0, h1],
    style: (m2 >>> 8) % COVER_STYLE_COUNT,
    idx: (m >>> 12) % 5,
    name: String(title ?? ''),
    footer: String(artist ?? ''),
  };
}

/** Same, but honouring an album's own `coverSpec` override. */
export function specForAlbum(album) {
  const base = coverSpec(album.coverSeed, album.title, album.artist);
  const o = album.coverSpec;
  if (o && Array.isArray(o.hue) && o.hue.length === 2) {
    return { ...base, hue: [+o.hue[0] || 0, +o.hue[1] || 0], style: ((o.style | 0) % COVER_STYLE_COUNT + COVER_STYLE_COUNT) % COVER_STYLE_COUNT, idx: o.idx | 0 };
  }
  return base;
}

function fitText(g, text, maxW) {
  if (!g.measureText) return text;
  if (g.measureText(text).width <= maxW) return text;
  let lo = 0, hi = text.length;               // longest prefix that fits, plus an ellipsis
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + '…' : '…';
}

/**
 * Paint a procedural cover on a square S x S 2d context. Ported from the
 * prototype's paintCover: a diagonal gradient, one of five motifs, the album
 * name stacked word by word at the top left, a small footer line at the bottom.
 */
export function paintCover(g, S, spec) {
  if (!g) return;
  let k, x, y, r, q;
  const gr = g.createLinearGradient(0, 0, S, S);
  gr.addColorStop(0, 'hsl(' + spec.hue[0] + ',72%,60%)');
  gr.addColorStop(1, 'hsl(' + spec.hue[1] + ',62%,22%)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  switch (spec.style) {
    case 0:
      for (k = 0; k < 9; k++) {
        g.beginPath(); g.arc(S * .62, S * .58, S * (.08 + k * .055), 0, 7);
        g.strokeStyle = 'rgba(255,255,255,' + (.55 - k * .05) + ')'; g.lineWidth = 2; g.stroke();
      }
      g.fillStyle = 'rgba(255,255,255,.92)'; g.beginPath(); g.arc(S * .62, S * .58, S * .05, 0, 7); g.fill();
      break;
    case 1:
      for (k = 0; k < 14; k++) {
        g.beginPath();
        for (x = 0; x <= S; x += 6) {
          y = S * (.3 + k * .04) + Math.sin(x / S * 6.283 * 2 + k * .5) * S * .035;
          if (x) g.lineTo(x, y); else g.moveTo(x, y);
        }
        g.strokeStyle = 'rgba(255,255,255,' + (.15 + k * .04) + ')'; g.lineWidth = 2; g.stroke();
      }
      break;
    case 2:
      g.fillStyle = 'rgba(255,255,255,.88)'; g.beginPath(); g.arc(S * .5, S * .62, S * .28, Math.PI, 0); g.fill();
      for (k = 0; k < 6; k++) { g.fillStyle = 'rgba(0,0,0,' + (.1 + k * .05) + ')'; g.fillRect(0, S * (.62 + k * .06), S, S * .03); }
      break;
    case 3:
      for (r = 0; r < 6; r++) for (q = 0; q < 6; q++) {
        g.fillStyle = 'rgba(255,255,255,' + (((r * 7 + q * 3 + (spec.idx | 0)) % 5) * .07 + .05) + ')';
        g.fillRect(S * .12 + q * S * .13, S * .2 + r * S * .13, S * .1, S * .1);
      }
      break;
    default:
      g.fillStyle = 'rgba(0,0,0,.28)'; g.beginPath(); g.moveTo(0, S); g.lineTo(S, S * .35); g.lineTo(S, S); g.fill();
      g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 3; g.beginPath(); g.moveTo(0, S); g.lineTo(S, S * .35); g.stroke();
  }
  // album name, stacked by word (capped so a 5000-char title cannot run off the sleeve)
  const maxW = S * .86;
  g.fillStyle = 'rgba(255,255,255,.94)'; g.textBaseline = 'top';
  g.font = '700 ' + (S * .08) + 'px ' + FONT;
  const words = String(spec.name || '').toUpperCase().split(/\s+/).filter(Boolean).slice(0, 7);
  let ly = S * .07;
  for (const w of words) { g.fillText(fitText(g, w, maxW), S * .07, ly); ly += S * .09; }
  g.font = '400 ' + (S * .034) + 'px ' + FONT; g.fillStyle = 'rgba(255,255,255,.7)'; g.textBaseline = 'alphabetic';
  g.fillText(fitText(g, String(spec.footer || 'BALIGA').toUpperCase(), maxW), S * .07, S * .95);
}

/** Draw an image centre-cropped to fill the square S x S. */
export function drawImageCover(g, S, img) {
  const w = img.naturalWidth || img.width || 0, h = img.naturalHeight || img.height || 0;
  if (!g || !w || !h) return false;
  const side = Math.min(w, h);
  g.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, S, S);
  return true;
}

/** Canvas pixel size for a cover shown cs CSS px wide at a device pixel ratio: multiple of 64, within [128, max]. */
export function coverPixelSize(cs, dpr = 1, max = COVER_MAX_PX) {
  const want = Math.max(1, cs) * Math.min(2, Math.max(1, dpr || 1));
  return Math.max(128, Math.min(max, Math.ceil(want / 64) * 64));
}

/** Scale (w, h) down so the longer side is <= max. Never upscales. */
export function fitSize(w, h, max = COVER_MAX_PX) {
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0, scale: 1 };
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)), scale };
}

/** Image MIME from magic bytes (the tags.js mime can be wrong or missing); null if unknown. */
export function sniffImageMime(b) {
  if (!b || b.length < 4) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

// ── object-URL lifecycle ─────────────────────────────────────────────────────
// Only URLs made HERE are tracked, and only those are ever revoked by this module
// (URLs minted elsewhere, e.g. library.js's, belong to their creator).
const tracked = new Set();
const defaultUrlApi = () => (typeof URL !== 'undefined' && URL.createObjectURL ? { create: (blob) => URL.createObjectURL(blob), revoke: (u) => URL.revokeObjectURL(u) } : null);

/**
 * Embedded artwork bytes -> a tracked object URL (null when there is nothing usable).
 * `api` ({create(blob), revoke(url), Blob?}) is injectable for tests.
 */
export function coverBlobUrl(bytes, mime, api = defaultUrlApi()) {
  if (!bytes || !bytes.length || !api) return null;
  const type = sniffImageMime(bytes) || (typeof mime === 'string' && /^image\//.test(mime) ? mime : 'image/jpeg');
  const BlobC = api.Blob || (typeof Blob !== 'undefined' ? Blob : null);
  if (!BlobC) return null;
  let url;
  try { url = api.create(new BlobC([bytes], { type })); } catch { return null; }
  if (url) { tracked.add(url); trackedApi.set(url, api); }
  return url || null;
}
const trackedApi = new Map();

export function isTrackedCoverUrl(url) { return tracked.has(url); }
export function trackedCoverUrlCount() { return tracked.size; }
/** Revoke one tracked URL. Returns true when it was ours. */
export function revokeCoverUrl(url) {
  if (!tracked.has(url)) return false;
  tracked.delete(url);
  const api = trackedApi.get(url); trackedApi.delete(url);
  try { api && api.revoke(url); } catch { /* already gone */ }
  return true;
}
export function revokeAllCoverUrls() { for (const u of [...tracked]) revokeCoverUrl(u); }

/**
 * Optional async step for artwork that is huge: decode and re-encode at <= max px,
 * revoke the original, return the new (tracked) URL. Falls back to the original
 * URL when the platform cannot do it. Browser-only (needs createImageBitmap + canvas).
 */
export async function downscaleCoverUrl(url, max = COVER_MAX_PX, env = {}) {
  try {
    const fetchFn = env.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    const mk = env.makeCanvas || (() => document.createElement('canvas'));
    const cib = env.createImageBitmap || (typeof createImageBitmap !== 'undefined' ? createImageBitmap : null);
    if (!fetchFn || !cib) return url;
    const blob = await (await fetchFn(url)).blob();
    const bmp = await cib(blob);
    const { w, h, scale } = fitSize(bmp.width, bmp.height, max);
    if (scale >= 1) { bmp.close && bmp.close(); return url; }
    const c = mk(); c.width = w; c.height = h;
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close && bmp.close();
    const out = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.86));
    c.width = c.height = 0;
    if (!out) return url;
    const api = defaultUrlApi();
    const nu = api.create(out); tracked.add(nu); trackedApi.set(nu, api);
    revokeCoverUrl(url);
    return nu;
  } catch { return url; }
}

// ── canvas cache ─────────────────────────────────────────────────────────────
/**
 * Small LRU of painted cover canvases. get(album, size) returns the canvas for an
 * album (painting it procedurally first, then drawing its coverUrl image over it
 * once loaded and calling onChange(album.id)). At most `max` canvases are alive;
 * an evicted canvas is shrunk to 0x0 so its backing store is freed at once.
 *   env = { makeCanvas(), loadImage(url) -> Promise<img>, onChange(id) }
 */
export function createCoverCache(env = {}) {
  const max = env.max || COVER_CACHE_MAX;
  const makeCanvas = env.makeCanvas || (() => document.createElement('canvas'));
  const loadImage = env.loadImage || ((url) => new Promise((res, rej) => {
    const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url;
  }));
  const map = new Map();                     // id -> entry, insertion order = LRU order
  let alive = true;

  function paint(e) {
    const c = e.canvas, S = e.size;
    c.width = S; c.height = S;
    const g = c.getContext && c.getContext('2d');
    if (!g) return;
    paintCover(g, S, specForAlbum(e.album));
    const url = e.album.coverUrl;
    if (!url) return;
    const token = ++e.token;
    loadImage(url).then((img) => {
      if (!alive || e.dead || e.token !== token) return;
      const g2 = c.getContext('2d');
      if (g2 && drawImageCover(g2, S, img)) env.onChange && env.onChange(e.album.id);
    }, () => { /* unreadable artwork: the painted cover stays */ });
  }
  function evict() {
    while (map.size > max) {
      const [id, e] = map.entries().next().value;
      map.delete(id); e.dead = true; e.canvas.width = e.canvas.height = 0;
    }
  }
  return {
    get(album, size) {
      if (!alive || !album) return null;
      let e = map.get(album.id);
      if (e) { map.delete(e.album.id); map.set(e.album.id, e); }          // touch
      if (!e || e.size !== size || e.album !== album) {
        if (!e) { e = { canvas: makeCanvas(), size, album, token: 0, dead: false }; }
        e.size = size; e.album = album;
        paint(e);
        map.set(album.id, e); evict();
      }
      return e.canvas;
    },
    /** Forget one album (its artwork URL changed / it was removed). */
    drop(id) { const e = map.get(id); if (e) { e.dead = true; e.canvas.width = e.canvas.height = 0; map.delete(id); } },
    clear() { for (const e of map.values()) { e.dead = true; e.canvas.width = e.canvas.height = 0; } map.clear(); },
    get size() { return map.size; },
    destroy() { this.clear(); alive = false; },
  };
}
