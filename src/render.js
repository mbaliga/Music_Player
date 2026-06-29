// render.js — canvas2D rendering of the turntable MAT (the platter).
//
// The mat (matte rubber slipmat with the "Runout" wordmark embossed as
// fingerprint grooves + brushed-metal rim) is baked ONCE into a square,
// disc-centred sprite by mat.js. Each frame we rotate-blit that sprite so the
// platter spins under the (screen-fixed, SVG) tonearm.
//
// Everything is drawn in the reference's LOGICAL stage coordinates (760×1000);
// drawFrame installs the device transform from the canvas size, so the same
// composition scales to any screen without re-tuning. The disc bleeds off the
// left exactly as in the reference hero shot; the tonearm is a separate SVG
// overlay positioned in the same coordinate system (see index.html).

import { clamp } from './model.js';
import { bakeMat } from './mat.js';

export const STAGE = { w: 760, h: 1000 };
export const DISC = { cx: 150, cy: 478, R: 362, rInner: 34 };

let _mat = null;

// Kept name-compatible with the old API. The mat is independent of the audio
// envelope (groove = wordmark, not waveform), so the args are ignored.
export function bakeGroove() {
  if (!_mat) _mat = bakeMat();
  return _mat.sprite;
}

export function drawFrame(ctx, sprite, state, geom) {
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  // Logical (760×1000) → device px. Independent x/y scale; the stage element is
  // constrained to the 760/1000 aspect in CSS so the disc stays circular.
  ctx.setTransform(cw / STAGE.w, 0, 0, ch / STAGE.h, 0, 0);
  ctx.clearRect(0, 0, STAGE.w, STAGE.h);

  const half = sprite.width / 2; // sprite native disc+rim half-size == DISC.R+PAD
  ctx.save();
  ctx.translate(geom.cx, geom.cy);
  ctx.rotate(state.theta);
  ctx.drawImage(sprite, -half, -half);
  ctx.restore();

  // Wear dust haze over the platter (subtle).
  if (state.dust > 0.001) {
    ctx.save();
    ctx.globalAlpha = clamp(state.dust * 0.18, 0, 0.3);
    const haze = ctx.createRadialGradient(geom.cx, geom.cy, geom.rIn, geom.cx, geom.cy, geom.rOut);
    haze.addColorStop(0, 'rgba(170,170,200,0)');
    haze.addColorStop(1, 'rgba(170,170,200,0.5)');
    ctx.fillStyle = haze;
    ctx.beginPath(); ctx.arc(geom.cx, geom.cy, geom.rOut, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}

// Logical disc geometry (the device transform is applied per-frame in drawFrame
// and, for input, in main.js canvasPoint()).
export function makeGeometry() {
  return {
    stageW: STAGE.w, stageH: STAGE.h,
    cx: DISC.cx, cy: DISC.cy,
    rOut: DISC.R, rIn: DISC.rInner,
  };
}
