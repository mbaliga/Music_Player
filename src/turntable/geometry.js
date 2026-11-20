// geometry.js — the turntable STAGE: coordinates, tonearm carriage kinematics and the groove spiral's radius/angle maps.
//
// Pure (no DOM / canvas / audio), ported unchanged from the owner's prototype (docs/TURNTABLE.md). Units are "stage units": the
// stage is the phone's visible landscape window, X in [222.5, 1463.5], Y in [-15, 546] (viewBox `222.5 -15 1241 561`, ~2.21:1).
// Portrait is the same stage rotated 90 degrees clockwise (see camera.js).
//
//   disc / mat centre  C = (278, 457), disc radius RDISC = 644 (mat 646)
//   tonearm            carriage Q slides along the slot centreline y = QY = 80; the arm is rigid, angle AD = 22 deg when deployed,
//                      pivot-to-stylus DS = 502; the stylus path is therefore a HORIZONTAL CHORD at TY = QY + sin(AD)*DS.
//   s in 0..1          arm position along that chord: 0 = outer groove (radius 612), 1 = inner (radius 268). Everything that used to be
//                      "radius" (src/model.js, tonearm.js) is expressed through rOf(s).

export const VB = Object.freeze({ x: 222.5, y: -15, w: 1241, h: 561 });
export const C = Object.freeze({ x: 278, y: 457 });
export const RDISC = 644;
export const RMAT = 646;
export const AD = 22 * Math.PI / 180;   // arm angle when deployed
export const DS = 502;                  // pivot -> stylus distance
export const PIN = 0;                   // no pin / cylinder on the arm
export const QY = 80;                   // carriage rail (the slot's centreline)
export const DIMX = 330;                // finger dimple: distance from the pivot along the arm
export const QPARK = 1393;              // carriage x when parked (arm flat in the slot)
export const TURNS = 12;                // spiral turns across the whole record
export const R_START = 612;             // outer groove radius (s = 0)
export const R_END = 268;               // inner groove radius (s = 1)

export const TY = QY + Math.sin(AD) * DS + Math.cos(AD) * PIN;           // y of the stylus chord
export const txAt = (r) => C.x + Math.sqrt(r * r - (TY - C.y) * (TY - C.y));   // x on the chord at disc radius r
export const TX0 = txAt(R_START);
export const TX1 = txAt(R_END);
export const QS = TX0 + Math.cos(AD) * DS - Math.sin(AD) * PIN;          // carriage x with the stylus at the outer groove
export const TRAVEL = TX0 - TX1;

const Dx = -Math.cos(AD), Dy = Math.sin(AD), Px = Math.sin(AD), Py = Math.cos(AD);

/** Carriage position for arm position s. */
export function Qp(s) { return { x: QS - s * TRAVEL, y: QY }; }
/** Stylus (needle tip) position for arm position s, deployed. */
export function Tp(s) {
  const qx = QS - s * TRAVEL;
  return { x: qx + Dx * DS + Px * PIN, y: QY + Dy * DS + Py * PIN };
}
/** Groove radius under the stylus. */
export function rOf(s) { const t = Tp(s); return Math.hypot(t.x - C.x, t.y - C.y); }
export const R_OUT = rOf(0);
export const R_IN = rOf(1);
/** radians of spiral angle per unit of radius: TURNS full turns between R_OUT and R_IN */
export const KTH = 2 * Math.PI * TURNS / (R_OUT - R_IN);
/** angle of groove point u (measured on the disc) */
export function thG(u) { return (R_OUT - rOf(u)) * KTH; }
/** angle of the stylus (screen) for arm position s */
export function thS(s) { const t = Tp(s); return Math.atan2(t.y - C.y, t.x - C.x); }
/** Disc rotation that keeps groove point s exactly under the stylus: phi(s) = thS(s) - thG(s). */
export function phiOf(s) { return thS(s) - thG(s); }

/** Control centres (stage units). Counter-rotated about these in portrait. */
export const BTN = Object.freeze({
  play: { x: 1321, y: 298 },
  b78: { x: 1215, y: 298 },   // ADDED (the app's 78 rpm): the free cell left of Play
  b33: { x: 1215, y: 378 },
  b45: { x: 1322, y: 378 },
  bm: { x: 1215, y: 454 },
  bp: { x: 1322, y: 454 },
});
export const DISP = Object.freeze({ x: 1050, y: 355, bezel: 108 });
/** the slot (tonearm-shaped stadium) outer rect */
export const SLOT = Object.freeze({ x: 843, y: 44, w: 594, h: 72, r: 36 });
/** bar of the arm in ITS local frame (x runs from the carriage toward the head) */
export const ARM_BAR = Object.freeze({ x: -36, y: -28, w: 578, h: 56 });
export const PORTRAIT_TRANSFORM = 'translate(561 0) rotate(90) translate(-222.5 15)';
