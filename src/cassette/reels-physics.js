// ─────────────────────────────────────────────────────────────────────────────
// reels-physics.js — pure tape geometry + physics for the cassette reels.
//
// Ported from the owner's cassette-reels.js (Reels.packR / tapeD / frame loop),
// with the synthesized audio, fake 24 s tracks and own transport removed: here
// progress is an INPUT (Runout's real playback), never integrated.
//
//   * Area-conserving pack: what leaves one reel lands on the other, so
//     rLeft^2 + rRight^2 is constant. p = whole-tape progress, p = share on the
//     RIGHT (take-up) reel.
//   * Angular speed from linear tape speed: omega = v / r. Tape speed is the
//     same at both reels, so the small roll spins faster.
//   * Forward = counter-clockwise (negative SVG rotation).
//   * Side B is the physical mirror of side A: progress_B = 1 - progress_A.
//
// No DOM, no allocation in the per-frame functions (they return numbers).
// ─────────────────────────────────────────────────────────────────────────────

export const RH = 94;              // tape radius on an empty core, hub-art units (hub ring is 88)
export const OMEGA_MID = 4.4;      // rad/s of a hub at mid-pack in normal play (~0.7 rev/s)
export const MAX_HUB_STEP = 0.5;   // rad per frame: under half a tooth gap, so no wagon-wheel aliasing
export const MAX_ROLLER_STEP = 0.9;
export const TAPE_FILL = '#1d1c1e';

const BASE_M = { left: { x: 246, y: 225 }, right: { x: 562, y: 225 } };
const MARK_BASE = { x0: 341.6, x1: 464.6, y0: 206, y1: 244 };

/** Geometry families: glass, base-clear, base-opaque. */
export const FAMS = {
  glass: { key: 'glass', S: 0.46, R: 130, hit: 64, m: { left: { x: 174.5, y: 184.5 }, right: { x: 501.5, y: 184.5 } },
    tape: { L: { x: 71, y: 373 }, R: { x: 604, y: 373 }, rw: 9.5, fl: 195, fr: 479, px: 337, py: 356 },
    mark: { x0: 249.5, x1: 425.5, y0: 173.5, y1: 200.5 }, rr: 19.5 },
  baseClear: { key: 'base-clear', S: 31 / 88, R: 118, hit: 68, m: BASE_M,
    tape: { L: { x: 96, y: 452 }, R: { x: 712, y: 452 }, rw: 9, fl: 262, fr: 546, px: 404, py: 402 }, mark: MARK_BASE, rr: 20.5 },
  baseOpaque: { key: 'base', S: 31 / 88, R: 66, hit: 68, m: BASE_M, tape: null, mark: MARK_BASE, rr: 20.5 },
};

/** Style definition (or id-less shape) -> geometry family. */
export function famFor(st) {
  if (st && st.kind === 'Glass') return FAMS.glass;
  return st && st.clear ? FAMS.baseClear : FAMS.baseOpaque;
}

export const clamp01 = (p) => (p > 0 ? (p < 1 ? p : 1) : 0); // NaN -> 0

/** Mirror position for the other face of the tape (side B). */
export const mirrorProgress = (p) => 1 - clamp01(p);

/** Pack radius in HUB-ART units for a reel holding `share` (0..1) of the tape. */
export function rU(f, share) {
  const R = f.R / f.S;
  return Math.sqrt(RH * RH + share * (R * R - RH * RH));
}

/** Pack radius in cassette px. left holds 1-p, right holds p. */
export function packR(f, side, p) {
  const q = clamp01(p);
  return rU(f, side === 'left' ? 1 - q : q) * f.S;
}

/** Linear tape speed at normal play, hub-art units / s. */
export function playSpeed(f) { return OMEGA_MID * rU(f, 0.5); }

/**
 * Signed hub rotation (radians) for one frame. `mul` = playback speed
 * multiple of normal play (1 = play, 0 = stopped, negative = reverse,
 * ~±24 = wind). Forward (mul > 0) is counter-clockwise = negative.
 */
export function hubStep(f, side, p, mul, dt) {
  if (!mul || !(dt > 0)) return 0;
  const q = clamp01(p);
  const r = rU(f, side === 'left' ? 1 - q : q);
  const w = Math.abs(mul) * playSpeed(f) / r;           // omega = v / r
  const a = Math.min(MAX_HUB_STEP, w * dt);
  return mul > 0 ? -a : a;
}

/** Signed roller rotation for one frame (rollers turn with the tape run). */
export function rollerStep(f, mul, dt) {
  if (!mul || !(dt > 0)) return 0;
  const a = Math.min(MAX_ROLLER_STEP, Math.abs(mul) * playSpeed(f) * f.S * dt / 14);
  return mul > 0 ? -a : a;
}

export const toDeg = (a) => a * 57.29578;
export const fx = (v) => v.toFixed(2);

/** x of the amber position marker in the centre window. */
export function markerX(f, p) { return f.mark.x0 + clamp01(p) * (f.mark.x1 - f.mark.x0); }

/**
 * Tape path (clear + glass families): reel -> roller (wraps its outer side) ->
 * flat run -> bow up to the pressure pad -> mirror. Returns an SVG path string.
 */
export function tapeD(f, rL, rR) {
  const t = f.tape, TH = 2.5, k = TH + 2, rw = t.rw, yt = t.L.y + rw, cl = f.m.left, cr = f.m.right;
  const eL = rL + TH, eR = rR + TH;
  const dxl = t.L.x - cl.x, dyl = t.L.y - cl.y, dxr = t.R.x - cr.x, dyr = t.R.y - cr.y;
  const aL = Math.atan2(dyl, dxl) + Math.acos((eL - rw) / Math.hypot(dxl, dyl));
  const aR = Math.atan2(dyr, dxr) - Math.acos((eR - rw) / Math.hypot(dxr, dyr));
  const cL = Math.cos(aL), sL = Math.sin(aL), cR = Math.cos(aR), sR = Math.sin(aR);
  return 'M' + fx(cl.x + (eL - k) * cL) + ' ' + fx(cl.y + (eL - k) * sL) +
    ' L' + fx(t.L.x + rw * cL) + ' ' + fx(t.L.y + rw * sL) +
    ' A' + rw + ' ' + rw + ' 0 0 0 ' + t.L.x + ' ' + yt +
    ' L' + t.fl + ' ' + yt + ' L' + t.px + ' ' + t.py + ' L' + t.fr + ' ' + yt + ' L' + t.R.x + ' ' + yt +
    ' A' + rw + ' ' + rw + ' 0 0 0 ' + fx(t.R.x + rw * cR) + ' ' + fx(t.R.y + rw * sR) +
    ' L' + fx(cr.x + (eR - k) * cR) + ' ' + fx(cr.y + (eR - k) * sR);
}
