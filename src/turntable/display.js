// display.js — the dot-matrix display: 5x7 font, the 25x25 dot grid, track pips, equaliser bars. Pure (the canvas draw is disc-draw.js).
//
// Grid DN = 12 (25 x 25 dots), pitch DP = 8 stage units, lit radius 3 (+ glow), unlit 2.3, bezel r = 108, usable radius 96.
// dispMode 0 = scrolling track name (rows -3..+3) + one pip per track on row +6; dispMode 1 = equaliser (13 bars, 2 columns apart).
// No progress ring (the owner removed it).

export const DN = 12, DP = 8, GRID = 2 * DN + 1;
export const R_USE = 96, R_BEZEL = 108, R_LIT = 3, R_UNLIT = 2.3, R_PIP = 2.8, R_GLOW = 5.6;
export const SCROLL_COLS_PER_SEC = 13;
export const FIT_CHARS = 4;   // letters that fit the 25-column window without scrolling
export const PIP_ROW = 6, PIP_MAX = 21;
export const EQ_BARS = 13, EQ_BINS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 19, 24, 29];

const FONT_SRC = {
  'A': '01110,10001,10001,11111,10001,10001,10001', 'B': '11110,10001,10001,11110,10001,10001,11110', 'C': '01110,10001,10000,10000,10000,10001,01110',
  'D': '11100,10010,10001,10001,10001,10010,11100', 'E': '11111,10000,10000,11110,10000,10000,11111', 'F': '11111,10000,10000,11110,10000,10000,10000',
  'G': '01110,10001,10000,10111,10001,10001,01111', 'H': '10001,10001,10001,11111,10001,10001,10001', 'I': '01110,00100,00100,00100,00100,00100,01110',
  'J': '00111,00010,00010,00010,00010,10010,01100', 'K': '10001,10010,10100,11000,10100,10010,10001', 'L': '10000,10000,10000,10000,10000,10000,11111',
  'M': '10001,11011,10101,10101,10001,10001,10001', 'N': '10001,11001,10101,10011,10001,10001,10001', 'O': '01110,10001,10001,10001,10001,10001,01110',
  'P': '11110,10001,10001,11110,10000,10000,10000', 'Q': '01110,10001,10001,10001,10101,10010,01101', 'R': '11110,10001,10001,11110,10100,10010,10001',
  'S': '01111,10000,10000,01110,00001,00001,11110', 'T': '11111,00100,00100,00100,00100,00100,00100', 'U': '10001,10001,10001,10001,10001,10001,01110',
  'V': '10001,10001,10001,10001,10001,01010,00100', 'W': '10001,10001,10001,10101,10101,10101,01010', 'X': '10001,10001,01010,00100,01010,10001,10001',
  'Y': '10001,10001,01010,00100,00100,00100,00100', 'Z': '11111,00001,00010,00100,01000,10000,11111',
  '0': '01110,10001,10011,10101,11001,10001,01110', '1': '00100,01100,00100,00100,00100,00100,01110', '2': '01110,10001,00001,00010,00100,01000,11111',
  '3': '11110,00001,00001,01110,00001,00001,11110', '4': '00010,00110,01010,10010,11111,00010,00010', '5': '11111,10000,11110,00001,00001,10001,01110',
  '6': '00110,01000,10000,11110,10001,10001,01110', '7': '11111,00001,00010,00100,01000,01000,01000', '8': '01110,10001,10001,01110,10001,10001,01110',
  '9': '01110,10001,10001,01111,00001,00010,01100',
  ' ': '00000,00000,00000,00000,00000,00000,00000', '.': '00000,00000,00000,00000,00000,01100,01100', '-': '00000,00000,00000,11111,00000,00000,00000',
  ',': '00000,00000,00000,00000,01100,00100,01000', "'": '01100,00100,01000,00000,00000,00000,00000', '(': '00010,00100,01000,01000,01000,00100,00010',
  ')': '01000,00100,00010,00010,00010,00100,01000', '!': '00100,00100,00100,00100,00100,00000,00100', '?': '01110,10001,00001,00010,00100,00000,00100',
  ':': '00000,01100,01100,00000,01100,01100,00000', '/': '00001,00001,00010,00100,01000,10000,10000', '_': '00000,00000,00000,00000,00000,00000,11111',
  '+': '00000,00100,00100,11111,00100,00100,00000', '&': '01100,10010,10100,01000,10101,10010,01101',
};
/** glyph -> 7 row bytes (bit 4 = leftmost column) */
export const FONT = Object.freeze(Object.fromEntries(Object.entries(FONT_SRC).map(([k, v]) => [k, v.split(',').map((r) => parseInt(r, 2))])));

/** Column bitmasks (bit r = row r, 0..6) for a string: 5 columns + 1 spacer per glyph, then 14 blank columns of tail. */
export function textCols(str) {
  const s = String(str).toUpperCase().replace(/[–—]/g, '-');
  const cols = [];
  for (let i = 0; i < s.length; i++) {
    const g = FONT[s[i]] || FONT['?'];
    for (let c = 0; c < 5; c++) { let v = 0; for (let r = 0; r < 7; r++) if ((g[r] >> (4 - c)) & 1) v |= 1 << r; cols.push(v); }
    cols.push(0);
  }
  for (let i = 0; i < 14; i++) cols.push(0);
  return cols;
}
/** tiny single-entry cache so the hot loop never rebuilds columns */
let _cStr = null, _cCols = null;
export function textColsCached(str) { if (_cStr !== str) { _cCols = textCols(str); _cStr = str; } return _cCols; }

/** scroll offset (columns) at time t seconds */
export const scrollOffset = (tSec, nCols) => Math.floor(tSec * SCROLL_COLS_PER_SEC) % nCols;

/** Write the scrolling name into rows -3..3 of `lit` (Uint8Array GRID*GRID, 1 = lit). */
export function fillName(lit, cols, off) {
  const L = cols.length;
  for (let i = -DN; i <= DN; i++) {
    const col = cols[(((i + DN + off) % L) + L) % L];
    for (let r = -3; r <= 3; r++) if ((col >> (r + 3)) & 1) lit[(r + DN) * GRID + (i + DN)] = 1;
  }
}

/**
 * Track pips: which columns on row +6 and which is current. Spacing 2 columns when <= 10 tracks, 1 column up to 21, and beyond 21 the
 * album is MAPPED onto 21 pips (the current track maps proportionally). One track = no pips.
 * -> { n, spacing, current, cols:[col offsets from the centre] }
 */
export function pipLayout(trackCount, trackIndex) {
  if (!(trackCount > 1)) return { n: 0, spacing: 0, current: -1, cols: [] };
  const n = Math.min(trackCount, PIP_MAX), sp = n <= 10 ? 2 : 1;
  const current = Math.min(n - 1, Math.round(trackIndex * (n - 1) / Math.max(1, trackCount - 1)));
  const cols = [];
  for (let q = 0; q < n; q++) cols.push(Math.round((q - (n - 1) / 2) * sp));
  return { n, spacing: sp, current, cols };
}
/** bright = current (1), dim = others (2) */
export function fillPips(lit, pips) {
  for (let q = 0; q < pips.n; q++) lit[(PIP_ROW + DN) * GRID + (pips.cols[q] + DN)] = q === pips.current ? 1 : 2;
}

/** Equaliser: vals (0..1 per bar) -> bars from the bottom, a peak-hold dot per bar; `hold` decays 0.02 per call. */
export function fillEq(lit, vals, hold) {
  for (let b = 0; b < EQ_BARS; b++) {
    hold[b] = Math.max(vals[b], hold[b] - 0.02);
    const h = Math.round(vals[b] * GRID), ph = Math.round(hold[b] * GRID), ci = -DN + 2 * b;
    for (let j = 0; j < h; j++) lit[(DN - j) * GRID + (ci + DN)] = 1;
    if (ph > 0 && ph <= GRID) lit[(DN - ph + 1) * GRID + (ci + DN)] = 1;
  }
}
/** analyser bytes (fft 64) -> 13 bar levels */
export function eqFromBytes(bytes, out) { for (let b = 0; b < EQ_BARS; b++) out[b] = Math.min(1, (bytes[EQ_BINS[b]] || 0) / 230); return out; }
/** no live analyser (idle / parked): a gentle synthetic wobble driven by the envelope level */
export function eqFake(level, tSec, out) { for (let b = 0; b < EQ_BARS; b++) out[b] = Math.max(0, Math.min(1, level * (0.55 + 0.45 * Math.sin(tSec * 5 + b * 1.7)))); return out; }

/** is grid cell (i, j) inside the lit-radius circle? */
export const inDisc = (i, j) => (i * DP) * (i * DP) + (j * DP) * (j * DP) <= R_USE * R_USE;
