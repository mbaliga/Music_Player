// arm.js — tonearm pose + drag mapping on the linear-tracking carriage. Pure. (kinematics: geometry.js)
//
// placeArm(s, d): s = arm position along the stylus chord (0 outer .. 1 inner), d = deploy 0..1 (0 = parked flat in the slot,
// 1 = lowered at angle AD). e = ease(d); the carriage x runs from QPARK to QS - s*TRAVEL; the arm group is
// `translate(qx 80) rotate(180 - ang)` and the finger dimple sits DIMX along the arm.
import { AD, QY, QS, QPARK, TRAVEL, DIMX, DS, ARM_BAR } from './geometry.js';
import { ease } from './camera.js';

export function armPose(s, d) {
  const e = ease(Math.max(0, Math.min(1, d)));
  const ang = e * AD;
  const qx = QPARK + (QS - s * TRAVEL - QPARK) * e;
  return {
    qx, qy: QY, ang,
    rotDeg: 180 - ang * 180 / Math.PI,
    dimX: qx - Math.cos(ang) * DIMX,
    dimY: QY + Math.sin(ang) * DIMX,
    tipX: qx - Math.cos(ang) * DS,       // the (invisible) stylus
    tipY: QY + Math.sin(ang) * DS,
  };
}
export function armTransform(p) { return `translate(${p.qx.toFixed(2)} ${QY}) rotate(${p.rotDeg.toFixed(3)})`; }
export function dimpleTransform(p) { return `translate(${p.dimX.toFixed(2)} ${p.dimY.toFixed(2)})`; }

/** Dimple x when the arm is lowered at position s. */
export const dimpleX = (s) => QS - s * TRAVEL - Math.cos(AD) * DIMX;
/** Pointer x (stage units) -> arm position s, keeping the grab offset: grabDX = dimpleX(s0) - pointerX0. */
export function sFromPointer(px, grabDX) {
  const qx = px + grabDX + Math.cos(AD) * DIMX;
  return Math.max(0, Math.min(1, (QS - qx) / TRAVEL));
}
export const grabOffset = (s, px) => dimpleX(s) - px;

/** The arm bar's x-extent in stage units when parked (to prove it lies inside the slot). */
export function parkedExtent() {
  const p = armPose(0, 0);
  return { x0: p.qx - (ARM_BAR.x + ARM_BAR.w), x1: p.qx - ARM_BAR.x, y0: QY + ARM_BAR.y, y1: QY + ARM_BAR.y + ARM_BAR.h };
}
