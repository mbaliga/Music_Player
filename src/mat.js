// mat.js — the turntable MAT renderer (ported from the reference design).
//
// The grooves are not a spiral: they are the offset outlines of the "Runout"
// wordmark, computed as a signed-distance field and shaded as a soft matte
// rubber height-field. A brushed-metal rim, a dark recessed groove, an engraved
// wordmark, a metallic spindle hub, grain and a vignette complete the slipmat.
//
// Expensive but baked ONCE into a square, disc-centred sprite so the platter can
// be rotate-blitted each frame (the wordmark spins like a real patterned mat).
// Baked at a FIXED internal resolution and scaled to the device at draw time, so
// the carefully-tuned constants never need re-tuning per screen.

const TAU = Math.PI * 2;

// ── Tuning (from the reference; disc re-centred into a square sprite) ──────────
const R       = 362;                 // disc radius (internal units)
const PAD     = 8;                    // rim breathing room in the sprite
const C       = R + PAD;              // sprite centre (and half-size)
const rInner  = 34;                   // spindle hub radius
const rings   = 26;                   // ridge count (lower = thicker grooves)
const EDGE    = { ridge: 333, flat: 349, groove: 353 }; // ridges→flat→groove→rim
const LIGHT   = { x: -0.7071, y: -0.7071 };
const LIGHT3  = { x: -0.45, y: -0.45, z: 0.772 };
const MATBASE = [70, 70, 80];
const SURF    = '#3c3c44';
const BUMP    = 1.8;
const AMB     = 0.62;
const SQ      = 1.5;
const GB      = 0.1;
const MARGIN  = 9;
const GRAIN   = 0.17;
const SIG     = 5;
const GS      = 1.5;

// Wordmark, offset from the spindle exactly as in the reference (word centre is
// +170 in x from the disc centre → the flowing, asymmetric fingerprint).
const WORD = { text: 'Runout', dx: 170, dy: 0, size: R * 0.19, weight: 800, round: 0.09 };
const WOB  = 0;

const cx = C, cy = C;                 // disc centre within the sprite
const wcx = C + WORD.dx, wcy = C + WORD.dy;

function wobble(x, y) {
  return WOB * (15 * Math.sin(x / 92 + y / 240 + 0.5)
              + 9 * Math.sin(x / 150 - y / 100 + 1.3)
              + 5 * Math.sin((x * 0.8 + y) / 58 + 2.1));
}

function stampWord(g, dx, dy, style, lw) {
  g.save();
  g.translate(wcx + dx, wcy + dy);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = WORD.weight + ' ' + WORD.size.toFixed(1) + 'px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  g.lineJoin = 'round'; g.lineCap = 'round';
  g.lineWidth = (lw !== undefined) ? lw : WORD.size * WORD.round;
  g.fillStyle = style; g.strokeStyle = style;
  if (g.lineWidth > 0) g.strokeText(WORD.text, 0, 0);
  g.fillText(WORD.text, 0, 0);
  g.restore();
}

const grainCanvas = (() => {
  const n = 220, c = document.createElement('canvas'); c.width = c.height = n;
  const g = c.getContext('2d'), img = g.createImageData(n, n);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (Math.random() * 40 - 20);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0); return c;
})();

// exact squared EDT (Felzenszwalb)
function edt1d(f, n) {
  const d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  let k = 0; v[0] = 0; z[0] = -1e20; z[1] = 1e20;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = 1e20;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const dx = q - v[k]; d[q] = dx * dx + f[v[k]]; }
  return d;
}
function edt2d(grid, W, H) {
  const tmp = new Float64Array(W * H), col = new Float64Array(H), row = new Float64Array(W);
  for (let x = 0; x < W; x++) { for (let y = 0; y < H; y++) col[y] = grid[y * W + x]; const d = edt1d(col, H); for (let y = 0; y < H; y++) tmp[y * W + x] = d[y]; }
  for (let y = 0; y < H; y++) { for (let x = 0; x < W; x++) row[x] = tmp[y * W + x]; const d = edt1d(row, W); for (let x = 0; x < W; x++) tmp[y * W + x] = d[x]; }
  return tmp;
}
function gaussBlur(src, W, H, sigma) {
  if (sigma <= 0) return src;
  const r = Math.max(1, Math.ceil(sigma * 3)), k = new Float64Array(2 * r + 1); let sum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let a = 0; for (let i = -r; i <= r; i++) { let xx = x + i; if (xx < 0) xx = 0; else if (xx >= W) xx = W - 1; a += src[y * W + xx] * k[i + r]; } tmp[y * W + x] = a; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let a = 0; for (let i = -r; i <= r; i++) { let yy = y + i; if (yy < 0) yy = 0; else if (yy >= H) yy = H - 1; a += tmp[yy * W + x] * k[i + r]; } out[y * W + x] = a; }
  return out;
}

let FIELD = null, SHADE = null;

function buildField() {
  const spacing = (R - rInner) / rings, x0 = cx - R, y0 = cy - R;
  const NX = Math.floor((2 * R) / GS) + 1, NY = NX;
  const mc = document.createElement('canvas'); mc.width = NX; mc.height = NY;
  const mg = mc.getContext('2d');
  mg.setTransform(1 / GS, 0, 0, 1 / GS, -x0 / GS, -y0 / GS);
  stampWord(mg, 0, 0, '#fff');
  const px = mg.getImageData(0, 0, NX, NY).data, INF = (NX + NY) * (NX + NY);
  const fOut = new Float64Array(NX * NY), fIn = new Float64Array(NX * NY);
  for (let k = 0; k < NX * NY; k++) { const t = px[k * 4 + 3] > 40; fOut[k] = t ? 0 : INF; fIn[k] = t ? INF : 0; }
  const dOut = edt2d(fOut, NX, NY), dIn = edt2d(fIn, NX, NY); const dSigned = new Float64Array(NX * NY);
  for (let k = 0; k < NX * NY; k++) dSigned[k] = (Math.sqrt(dOut[k]) - Math.sqrt(dIn[k])) * GS;
  let F = new Float32Array(NX * NY);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) { const idx = j * NX + i, ux = x0 + i * GS, uy = y0 + j * GS; F[idx] = dSigned[idx] + wobble(ux - cx, uy - cy); }
  F = gaussBlur(F, NX, NY, SIG / GS);
  const Fx = new Float32Array(NX * NY), Fy = new Float32Array(NX * NY);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const im = Math.max(0, i - 1), ip = Math.min(NX - 1, i + 1), jm = Math.max(0, j - 1), jp = Math.min(NY - 1, j + 1);
    Fx[j * NX + i] = (F[j * NX + ip] - F[j * NX + im]) / (2 * GS);
    Fy[j * NX + i] = (F[jp * NX + i] - F[jm * NX + i]) / (2 * GS);
  }
  FIELD = { F, dSigned, Fx, Fy, NX, NY, x0, y0, spacing };
}

function samp(arr, gx, gy, NX, NY) {
  if (gx < 0) gx = 0; if (gy < 0) gy = 0; if (gx > NX - 1.001) gx = NX - 1.001; if (gy > NY - 1.001) gy = NY - 1.001;
  const i = gx | 0, j = gy | 0, fx = gx - i, fy = gy - j;
  const a = arr[j * NX + i], b = arr[j * NX + i + 1], c = arr[(j + 1) * NX + i], d = arr[(j + 1) * NX + i + 1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

function shadeMat() {
  const { F, dSigned, Fx, Fy, NX, NY, x0, y0, spacing } = FIELD;
  const M = 2, BW = NX * M, BH = NY * M, GSb = GS / M;
  const buf = document.createElement('canvas'); buf.width = BW; buf.height = BH;
  const bx = buf.getContext('2d'), img = bx.createImageData(BW, BH), D = img.data;
  for (let j = 0; j < BH; j++) for (let i = 0; i < BW; i++) {
    const ux = x0 + i * GSb, uy = y0 + j * GSb, r = Math.hypot(ux - cx, uy - cy), o4 = (j * BW + i) * 4;
    const gx = (ux - x0) / GS, gy = (uy - y0) / GS, ds = samp(dSigned, gx, gy, NX, NY);
    if (r > EDGE.ridge || ds < MARGIN) { D[o4 + 3] = 0; continue; }
    const f = samp(F, gx, gy, NX, NY) - MARGIN, ph = TAU * f / spacing, cph = Math.cos(ph), sph = Math.sin(ph);
    const cc = SQ * cph - GB, hgt = cc > 1 ? 1 : (cc < -1 ? -1 : cc), ss = (cc >= 1 || cc <= -1) ? 0 : (SQ * sph);
    let nx = samp(Fx, gx, gy, NX, NY), ny = samp(Fy, gx, gy, NX, NY); const gm = Math.hypot(nx, ny) || 1; nx /= gm; ny /= gm;
    const slope = BUMP * ss; let Nx = -slope * nx, Ny = -slope * ny, Nz = 1; const nl = Math.sqrt(Nx * Nx + Ny * Ny + 1); Nx /= nl; Ny /= nl; Nz /= nl;
    let diff = Nx * LIGHT3.x + Ny * LIGHT3.y + Nz * LIGHT3.z; if (diff < 0) diff = 0;
    const occ = 0.80 + 0.20 * hgt; let val = (AMB + (1 - AMB) * diff) * occ;
    val += Math.pow(diff, 16) * 0.07 * (0.5 + 0.5 * hgt);
    D[o4] = Math.min(255, MATBASE[0] * val); D[o4 + 1] = Math.min(255, MATBASE[1] * val); D[o4 + 2] = Math.min(255, MATBASE[2] * val); D[o4 + 3] = 255;
  }
  bx.putImageData(img, 0, 0); return buf;
}

function paintMat(g) {
  const x0 = FIELD.x0, y0 = FIELD.y0;
  const ring = (rIn, rOut, style) => { g.beginPath(); g.arc(cx, cy, rOut, 0, TAU, false); g.arc(cx, cy, rIn, 0, TAU, true); g.fillStyle = style; g.fill('evenodd'); };

  g.save(); g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.clip();
  g.fillStyle = SURF; g.fillRect(cx - R - 4, cy - R - 4, (R + 4) * 2, (R + 4) * 2);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(SHADE, x0, y0, 2 * R, 2 * R);

  g.save(); g.beginPath(); g.arc(cx, cy, EDGE.flat, 0, TAU); g.clip();
  g.globalCompositeOperation = 'overlay'; g.globalAlpha = GRAIN;
  g.fillStyle = g.createPattern(grainCanvas, 'repeat'); g.fillRect(cx - R, cy - R, R * 2, R * 2);
  g.restore();

  ring(EDGE.ridge, EDGE.flat, SURF);

  if (WORD.text) {
    const OB = 1.7, lw = WORD.size * WORD.round;
    stampWord(g, OB, OB, '#0a0a0c', lw);
    stampWord(g, -OB, -OB, '#5c5c66', lw);
    stampWord(g, 0, 0, '#2b2b32', lw);
  }

  g.beginPath(); g.arc(cx, cy, rInner, 0, TAU); g.fillStyle = '#17171a'; g.fill();
  let sp = g.createRadialGradient(cx + LIGHT.x * 3, cy + LIGHT.y * 3, 0.5, cx, cy, 8);
  sp.addColorStop(0, '#d6d8dc'); sp.addColorStop(0.5, '#8a8c91'); sp.addColorStop(1, '#34353a');
  g.fillStyle = sp; g.beginPath(); g.arc(cx, cy, 8, 0, TAU); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.5)'; g.beginPath(); g.arc(cx + LIGHT.x * 2, cy + LIGHT.y * 2, 1.7, 0, TAU); g.fill();

  g.save(); g.beginPath(); g.arc(cx, cy, EDGE.flat, 0, TAU); g.clip();
  let vig = g.createRadialGradient(cx, cy, R * 0.55, cx, cy, EDGE.flat);
  vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,0.26)');
  g.fillStyle = vig; g.fillRect(cx - R, cy - R, R * 2, R * 2);
  g.restore();

  ring(EDGE.flat, EDGE.groove, '#0b0b0d');

  const cg = g.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  cg.addColorStop(0.00, '#dfe2e7'); cg.addColorStop(0.20, '#9da1a9'); cg.addColorStop(0.42, '#54575e');
  cg.addColorStop(0.58, '#787c84'); cg.addColorStop(0.78, '#b4b8c0'); cg.addColorStop(1.00, '#33353b');
  ring(EDGE.groove, R, cg);
  g.lineWidth = 1.2; g.strokeStyle = 'rgba(255,255,255,0.22)'; g.beginPath(); g.arc(cx, cy, EDGE.groove + 1.2, 0, TAU); g.stroke();
  g.lineWidth = 1.0; g.strokeStyle = 'rgba(0,0,0,0.5)'; g.beginPath(); g.arc(cx, cy, R - 0.6, 0, TAU); g.stroke();

  g.restore();
}

// Build the field + shade + paint the mat once into a square, disc-centred
// sprite. Returns { sprite, size, R, rInner, EDGE } — geometry the app needs.
export function bakeMat() {
  if (!FIELD) { buildField(); SHADE = shadeMat(); }
  const size = C * 2;
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  paintMat(cv.getContext('2d'));
  return { sprite: cv, size, R, rInner, EDGE: { ...EDGE } };
}
