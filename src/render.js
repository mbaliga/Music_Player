// render.js — canvas2D rendering of the turntable MAT (the platter).
//
// The mat (matte rubber slipmat with the "Runout" wordmark embossed as
// fingerprint grooves + brushed-metal rim) is baked ONCE into a square,
// disc-centred sprite by mat.js. Each frame we rotate-blit that sprite so the
// platter spins under the (screen-fixed, SVG) tonearm.
//
// Everything is drawn in LOGICAL stage coordinates; drawFrame installs the
// device transform from the canvas size. Two LAYOUTS share the same disc + arm
// assets via a single similarity transform:
//   • cinematic   — the disc is large and bleeds off the left (the hero crop).
//   • utilitarian — the disc is centred and fully visible with small margins.

import { clamp } from './model.js';
import { bakeMat } from './mat.js';

const MAT_R = 362; // the mat sprite's native disc radius (see mat.js)

// The tonearm SVG is authored for the cinematic disc at (150,478), R=362.
const BASE_ARM = 'translate(55,0) translate(500,500) scale(0.86) translate(-500,-500)';

const LAYOUTS = {
  cinematic:   { stageW: 760, stageH: 1000, cx: 150, cy: 478, R: 362 },
  utilitarian: { stageW: 760, stageH: 880,  cx: 370, cy: 445, R: 320 },
};

let _layout = LAYOUTS.cinematic;
let _mat = null;

export function setLayout(name) { if (LAYOUTS[name]) _layout = LAYOUTS[name]; }
export function getLayoutName() { return _layout === LAYOUTS.utilitarian ? 'utilitarian' : 'cinematic'; }

// The SVG arm transform that places the authored arm onto the current disc.
// A similarity maps the cinematic disc (150,478,R362) onto this layout's disc,
// so the arm and mat always stay aligned.
export function armTransform() {
  const s = _layout.R / MAT_R;
  const dx = _layout.cx - s * 150, dy = _layout.cy - s * 478;
  return `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) scale(${s.toFixed(4)}) ${BASE_ARM}`;
}

// Kept name-compatible with the old API; the mat ignores the audio envelope
// (groove = wordmark, not waveform) and bakes only once.
export function bakeGroove() {
  if (!_mat) _mat = bakeMat();
  return _mat.sprite;
}

export function drawFrame(ctx, sprite, state, geom) {
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  ctx.setTransform(cw / geom.stageW, 0, 0, ch / geom.stageH, 0, 0);
  ctx.clearRect(0, 0, geom.stageW, geom.stageH);

  const matScale = geom.rOut / MAT_R;
  const half = (sprite.width / 2) * matScale;
  ctx.save();
  ctx.translate(geom.cx, geom.cy);
  ctx.rotate(state.theta);
  ctx.drawImage(sprite, -half, -half, half * 2, half * 2);
  ctx.restore();

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

export function makeGeometry() {
  return {
    stageW: _layout.stageW, stageH: _layout.stageH,
    cx: _layout.cx, cy: _layout.cy,
    rOut: _layout.R, rIn: 34 * _layout.R / MAT_R,
  };
}
