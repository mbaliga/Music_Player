// render.js — canvas2D rendering of the turntable.
//
// Two layers:
//   • MAT (mat.js) — the matte rubber slipmat with the embossed "Runout"
//     wordmark + brushed-metal rim. STATIC (a slipmat doesn't spin). Baked once.
//   • RECORD — the vinyl on top: a dark disc whose spiral groove is banded by
//     the audio envelope (the variable-width "track line"), plus a centre label.
//     This is what SPINS. Baked per track (its groove is the waveform).
//
// Everything is drawn in LOGICAL stage coordinates; drawFrame installs the
// device transform from the canvas size. Two LAYOUTS:
//   • cinematic   — landscape; the record is large and bleeds off the edges.
//   • utilitarian — portrait; the whole record + mat are visible.

import { clamp } from './model.js';
import { bakeMat } from './mat.js';

const TAU = Math.PI * 2;
const MAT_R = 362;          // mat sprite native disc radius (see mat.js)
const RECORD_RATIO = 0.86;  // record sits inside the mat; its rim shows around it

const BASE_ARM = 'translate(55,0) translate(500,500) scale(0.86) translate(-500,-500)';

const LAYOUTS = {
  // cinematic: wide/landscape, record large and cropped, arm swung in from the right.
  cinematic:   { stageW: 1280, stageH: 760, cx: 470, cy: 392, R: 452, armRot: 18 },
  // utilitarian: portrait, whole record visible, arm down the right.
  utilitarian: { stageW: 760, stageH: 880, cx: 370, cy: 445, R: 320, armRot: 0 },
};

let _layout = LAYOUTS.cinematic;
let _mat = null;

export function setLayout(name) { if (LAYOUTS[name]) _layout = LAYOUTS[name]; }
export function getLayoutName() { return _layout === LAYOUTS.utilitarian ? 'utilitarian' : 'cinematic'; }

// SVG arm transform: a similarity maps the authored arm (cinematic-portrait
// disc at 150,478,R362) onto this layout's disc, plus an optional swing about
// the disc centre so the same arm reads as horizontal in the landscape crop.
export function armTransform() {
  const s = _layout.R / MAT_R;
  const dx = _layout.cx - s * 150, dy = _layout.cy - s * 478;
  const inner = `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) scale(${s.toFixed(4)}) ${BASE_ARM}`;
  const A = _layout.armRot || 0;
  return A ? `rotate(${A} ${_layout.cx} ${_layout.cy}) ${inner}` : inner;
}

// The static mat — baked once.
export function bakeMatSprite() {
  if (!_mat) _mat = bakeMat();
  return _mat.sprite;
}

// The spinning record — baked per track. Same sprite footprint as the mat so it
// drops in centred; the vinyl disc inside it is RECORD_RATIO of the mat radius.
export function bakeRecord(env, albumImage = null) {
  const size = _mat ? _mat.size : MAT_R * 2 + 16;
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const g = cv.getContext('2d');
  const cx = size / 2, cy = size / 2;
  const rOut = MAT_R * RECORD_RATIO;       // vinyl radius
  const rIn = rOut * 0.30;                  // label radius

  // Vinyl base — near-black, glossy, upper-left key light.
  const base = g.createRadialGradient(cx - rOut * 0.3, cy - rOut * 0.3, rOut * 0.05, cx, cy, rOut);
  base.addColorStop(0.0, '#17171d');
  base.addColorStop(0.5, '#0c0c11');
  base.addColorStop(1.0, '#040406');
  g.fillStyle = base;
  g.beginPath(); g.arc(cx, cy, rOut, 0, TAU); g.fill();

  // Spiral groove banded by the envelope — the VARIABLE-WIDTH track line.
  const turns = 46;
  const totalAngle = turns * TAU;
  const steps = Math.floor(turns * 260);
  g.lineCap = 'round';
  let px = null, py = null;
  for (let s = 0; s <= steps; s++) {
    const u = s / steps;
    const ang = u * totalAngle;
    const r = rOut - (rOut - rIn) * u;
    const x = cx + r * Math.cos(ang), y = cy + r * Math.sin(ang);
    const e = env && env.length ? env[Math.min(env.length - 1, Math.floor(u * env.length))] : 0.3;
    if (px !== null) {
      const w = 0.5 + 4.2 * e * e;                  // strong width modulation = the waveform
      const bright = 0.10 + 0.55 * e;
      const rC = Math.round(120 + 80 * e), gC = Math.round(110 + 70 * e), bC = Math.round(150 + 90 * e);
      g.strokeStyle = `rgba(${rC},${gC},${bC},${bright})`;
      g.lineWidth = w;
      g.beginPath(); g.moveTo(px, py); g.lineTo(x, y); g.stroke();
    }
    px = x; py = y;
  }

  // Glossy outer sheen (vinyl catches a soft highlight upper-left).
  const sheen = g.createRadialGradient(cx - rOut * 0.4, cy - rOut * 0.4, rOut * 0.1, cx, cy, rOut);
  sheen.addColorStop(0, 'rgba(255,255,255,0.05)');
  sheen.addColorStop(0.4, 'rgba(255,255,255,0)');
  g.fillStyle = sheen;
  g.beginPath(); g.arc(cx, cy, rOut, 0, TAU); g.fill();

  // Rim bevel.
  g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,0.06)';
  g.beginPath(); g.arc(cx, cy, rOut - 1, 0, TAU); g.stroke();
  g.lineWidth = 1.5; g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.beginPath(); g.arc(cx, cy, rOut, 0, TAU); g.stroke();

  // Centre label.
  g.save();
  g.beginPath(); g.arc(cx, cy, rIn, 0, TAU); g.clip();
  if (albumImage) {
    g.drawImage(albumImage, cx - rIn, cy - rIn, rIn * 2, rIn * 2);
  } else {
    const lab = g.createRadialGradient(cx - rIn * 0.2, cy - rIn * 0.2, 2, cx, cy, rIn);
    lab.addColorStop(0.0, '#a99bff');
    lab.addColorStop(0.55, '#7d6bef');
    lab.addColorStop(1.0, '#2c2360');
    g.fillStyle = lab; g.fillRect(cx - rIn, cy - rIn, rIn * 2, rIn * 2);
    g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = 0.6;
    g.beginPath(); g.arc(cx, cy, rIn * 0.62, 0, TAU); g.stroke();
    g.beginPath(); g.arc(cx, cy, rIn * 0.40, 0, TAU); g.stroke();
  }
  g.restore();

  // Dark separation ring around the label.
  g.strokeStyle = 'rgba(0,0,0,0.85)'; g.lineWidth = Math.max(2, rIn * 0.05);
  g.beginPath(); g.arc(cx, cy, rIn, 0, TAU); g.stroke();

  // Spindle hole.
  g.fillStyle = '#000';
  g.beginPath(); g.arc(cx, cy, Math.max(3, rIn * 0.07), 0, TAU); g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.2)'; g.lineWidth = 0.5;
  g.beginPath(); g.arc(cx, cy, Math.max(3, rIn * 0.07) + 1.3, 0, TAU); g.stroke();

  return cv;
}

export function drawFrame(ctx, sprites, state, geom) {
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  ctx.setTransform(cw / geom.stageW, 0, 0, ch / geom.stageH, 0, 0);
  ctx.clearRect(0, 0, geom.stageW, geom.stageH);

  const matScale = geom.rOut / MAT_R;

  // 1. Static mat (slipmat) — NOT rotated.
  if (sprites.mat) {
    const half = (sprites.mat.width / 2) * matScale;
    ctx.drawImage(sprites.mat, geom.cx - half, geom.cy - half, half * 2, half * 2);
  }

  // 2. Spinning record on top.
  if (sprites.record) {
    const half = (sprites.record.width / 2) * matScale;
    ctx.save();
    ctx.translate(geom.cx, geom.cy);
    ctx.rotate(state.theta);
    ctx.drawImage(sprites.record, -half, -half, half * 2, half * 2);
    ctx.restore();
  }

  // Wear dust haze over the record.
  if (state.dust > 0.001) {
    ctx.save();
    ctx.globalAlpha = clamp(state.dust * 0.18, 0, 0.3);
    const rr = geom.rOut * RECORD_RATIO;
    const haze = ctx.createRadialGradient(geom.cx, geom.cy, rr * 0.3, geom.cx, geom.cy, rr);
    haze.addColorStop(0, 'rgba(170,170,200,0)');
    haze.addColorStop(1, 'rgba(170,170,200,0.5)');
    ctx.fillStyle = haze;
    ctx.beginPath(); ctx.arc(geom.cx, geom.cy, rr, 0, TAU); ctx.fill();
    ctx.restore();
  }
}

export function makeGeometry() {
  return {
    stageW: _layout.stageW, stageH: _layout.stageH,
    cx: _layout.cx, cy: _layout.cy,
    rOut: _layout.R, rIn: _layout.R * RECORD_RATIO * 0.30,
  };
}
