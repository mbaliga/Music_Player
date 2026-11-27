// camera.js — stage camera + zoom choreography. Pure.
//
// The stage (geometry.js) is viewed through a camera: landscape = the stage as is, portrait = rotated 90 deg clockwise (the screen's
// top is the stage's left edge). `camFor(k)` returns the SVG viewBox centre and the canvas matrix MX for scale k (k = 1 at rest,
// K1 = .56 when zoomed out). z in 0..1 is the zoom (0 = player, 1 = library); every layer's look is a pure function of z.

import { VB } from './geometry.js';

export const ZOOM = Object.freeze({
  K1: 0.56,            // camera scale at z >= .5
  PINCH_GAIN: 2.2,     // z = z0 - (ratio - 1) * PINCH_GAIN        (ON-DEVICE TUNABLE)
  SNAP_OUT: 0.35,      // from the player: pinch released beyond this -> zoom out           (ON-DEVICE TUNABLE)
  SNAP_IN: 0.65,       // from the library: released below this -> player                   (ON-DEVICE TUNABLE)
  WHEEL_GAIN: 0.012,   // Ctrl+wheel: z += deltaY * WHEEL_GAIN (deltaY > 0 = zoom out)
  WHEEL_IDLE_MS: 160,
  EASE_RATE: 6.5,      // exponential easing toward zT, per second
  EASE_RATE_REDUCED: 22,
  DISPLAY_Z: 0.35,     // the dot display is drawn only below this
});

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** smoothstep window: 0 below a, 1 above b */
export function sm(a, b, v) { v = clamp01((v - a) / (b - a)); return v * v * (3 - 2 * v); }
export const ease = (d) => d * d * (3 - 2 * d);

/**
 * Camera for scale k in a W x H viewport (optionally leaving `reserve` css px free at the bottom).
 * -> { s, s0, M:[a,b,c,d,e,f] (canvas matrix, CSS px), vcx, vcy (viewBox centre in stage units) }
 */
export function camFor(portrait, W, H, k, reserve = 0) {
  // `reserve` (css px, default 0): a strip at the BOTTOM of the viewport the stage leaves free (the seek bar's extra height); the stage is fitted into H - reserve
  // and centred there, so the SVG viewBox centre moves down by half of it (in stage units).
  const Hs = Math.max(1, H - Math.max(0, reserve));
  if (portrait) {
    const s0 = Math.min(W / 561, Hs / 1241), s = s0 * k;
    return { s, s0, M: [0, s, -s, 0, W / 2 + s * 265.5, Hs / 2 - s * 843], vcx: 280.5, vcy: 620.5 + (H - Hs) / (2 * s) };
  }
  const s0 = Math.min(W / VB.w, Hs / VB.h), s = s0 * k;
  return { s, s0, M: [s, 0, 0, s, W / 2 - s * 843, Hs / 2 - s * 265.5], vcx: 843, vcy: 265.5 + (H - Hs) / (2 * s) };
}

/** screen rect of the stage window under matrix M */
export function rectOf(M) {
  const x1 = M[0] * VB.x + M[2] * VB.y + M[4], y1 = M[1] * VB.x + M[3] * VB.y + M[5];
  const x2 = M[0] * (VB.x + VB.w) + M[2] * (VB.y + VB.h) + M[4], y2 = M[1] * (VB.x + VB.w) + M[3] * (VB.y + VB.h) + M[5];
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

/** SVG viewBox string so SVG layers and the canvas agree: the viewport shows W/s x H/s stage units centred on (vcx, vcy). */
export function viewBoxFor(cam, W, H) {
  const vw = W / cam.s, vh = H / cam.s;
  return `${(cam.vcx - vw / 2).toFixed(2)} ${(cam.vcy - vh / 2).toFixed(2)} ${vw.toFixed(2)} ${vh.toFixed(2)}`;
}

/** Everything the zoom changes, as plain numbers (applied by stage.js). */
export function layers(z) {
  const cz = sm(0, 0.5, z);
  const g = Math.round(22 * sm(0, 0.4, z));
  return {
    k: 1 - (1 - ZOOM.K1) * cz,              // camera shrink: sm(0,.5,z) to K1
    matOpacity: 1 - sm(0.1, 0.5, z),
    controlsOpacity: 1 - clamp01(z * 3),
    topPointerEvents: z > 0.04 ? 'none' : '',
    frameOpacity: clamp01(z * 5) * (1 - sm(0.28, 0.5, z)),   // phone frame: peaks about z = .2, gone by .5
    libBgOpacity: sm(0.3, 0.55, z),
    libOpacity: sm(0.42, 0.6, z),
    libInteractive: z > 0.6,
    bg: [g, g, g + 3],                      // wrapper backdrop rgb
    showDisplay: z < ZOOM.DISPLAY_Z,
    displayAlpha: 1 - z / ZOOM.DISPLAY_Z,
  };
}

/**
 * Where the disc is drawn at zoom z: phase A (sm(0,.5)) lifts it off the platter to a hover point 0.62 * coverWidth above the slot
 * centre, shrinking to .46 * coverWidth radius, with a 6% bump; phase B (sm(.5,1)) lowers it into the slot (hidden behind the opaque cover).
 *   MX: current stage matrix; slot: screen rect {left,top,width,height} of the centre cover placeholder.
 * -> { rho, M } the full canvas matrix for the disc, or null at z ~ 0 (use MX as is).
 */
export function discPlacement(z, MX, slot, C, RDISC) {
  if (z <= 0.002) return null;
  const se = Math.hypot(MX[0], MX[1]);
  const Cx = MX[0] * C.x + MX[2] * C.y + MX[4], Cy = MX[1] * C.x + MX[3] * C.y + MX[5];
  const Tx = slot.left + slot.width / 2, Ty = slot.top + slot.height / 2;
  const Hy = Ty - 0.62 * slot.width, rt = 0.46 * slot.width;
  const rh = rt / (RDISC * se), eA = sm(0, 0.5, z), eB = sm(0.5, 1, z);
  const rho = (1 + (rh - 1) * eA) * (1 + 0.06 * Math.sin(Math.PI * clamp01(z / 0.3)));
  let px = Cx + (Tx - Cx) * eA, py = Cy + (Hy - Cy) * eA;
  px += (Tx - px) * eB; py += (Ty - py) * eB;
  return { rho, M: [rho * MX[0], rho * MX[1], rho * MX[2], rho * MX[3], rho * MX[4] + px - rho * Cx, rho * MX[5] + py - rho * Cy] };
}

// ── input -> z ───────────────────────────────────────────────────────────────
/** pinch: ratio = current finger distance / distance at the start. Fingers closing (ratio < 1) = zoom OUT (z up). */
export function pinchZ(z0, ratio, gain = ZOOM.PINCH_GAIN) { return clamp01(z0 - (ratio - 1) * gain); }
/** release: where z settles (1 or 0), with hysteresis from where the gesture began */
export function pinchSettle(z, z0) { const th = z0 < 0.5 ? ZOOM.SNAP_OUT : ZOOM.SNAP_IN; return z > th ? 1 : 0; }
export function wheelZ(z, deltaY, gain = ZOOM.WHEEL_GAIN) { return clamp01(z + deltaY * gain); }
export function wheelSettle(z) { return z > 0.5 ? 1 : 0; }
/** one easing step toward zT; reduced motion eases faster (zoom still works) */
export function easeZ(z, zT, dt, reduced = false) {
  if (z === zT) return z;
  const next = z + (zT - z) * Math.min(1, dt * (reduced ? ZOOM.EASE_RATE_REDUCED : ZOOM.EASE_RATE));
  return Math.abs(zT - next) < 0.002 ? zT : next;
}
