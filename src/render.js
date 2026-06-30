// render.js — canvas2D rendering of the turntable.
//
// Two layers:
//   • MAT (mat.js) — the matte rubber slipmat with the embossed "Runout"
//     wordmark + brushed-metal rim. STATIC. Baked once.
//   • RECORD — glossy black vinyl on top: fine concentric grooves whose
//     brightness/width is subtly modulated by the audio envelope (the dynamics),
//     a matte centre label, a glossy sheen. This is what SPINS.
//
// Geometry adapts to the ACTUAL canvas pixel box, so the disc is always circular
// regardless of the stage's aspect. A single similarity maps the authored SVG
// tonearm onto the disc, so the arm always lines up.

import { clamp } from './model.js';
import { bakeMat } from './mat.js';

const TAU = Math.PI * 2;
const MAT_R = 362;          // mat sprite native disc radius (see mat.js)
const RECORD_RATIO = 0.86;  // record sits inside the mat; its rim shows around it

const BASE_ARM = 'translate(55,0) translate(500,500) scale(0.86) translate(-500,-500)';

// Geometry is computed from the live canvas box (CSS px). Each layout returns
// the disc centre + radius (and an arm swing) as a function of width/height.
const LAYOUTS = {
  // Landscape hero: record large on the left, bleeding off; arm swung in right.
  cinematic: (W, H) => {
    const R = Math.min(H * 0.66, W * 0.42);
    return { W, H, cx: W * 0.32, cy: H * 0.5, R, armRot: 16 };
  },
  // Portrait: whole record + mat visible, arm down the right.
  utilitarian: (W, H) => {
    const R = Math.min(W * 0.45, H * 0.43);
    return { W, H, cx: W * 0.47, cy: H * 0.45, R, armRot: 0 };
  },
};

let _layoutName = 'cinematic';
let _mat = null;

export function setLayout(name) { if (LAYOUTS[name]) _layoutName = name; }
export function getLayoutName() { return _layoutName; }
export function makeGeometry(W, H) {
  const g = LAYOUTS[_layoutName](W, H);
  // Interaction radii follow the RECORD (the disc you actually grab), not the mat.
  g.rOut = g.R * RECORD_RATIO;
  g.rIn = g.rOut * 0.32;
  return g;
}

// SVG arm transform that places the authored arm (disc at 150,478,R362) onto the
// current disc, with an optional swing about the disc centre for the landscape crop.
export function armTransform(geom) {
  const s = geom.R / MAT_R;
  const dx = geom.cx - s * 150, dy = geom.cy - s * 478;
  const inner = `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) scale(${s.toFixed(4)}) ${BASE_ARM}`;
  const A = geom.armRot || 0;
  return A ? `rotate(${A} ${geom.cx.toFixed(2)} ${geom.cy.toFixed(2)}) ${inner}` : inner;
}

// The static mat — baked once.
export function bakeMatSprite() {
  if (!_mat) _mat = bakeMat();
  return _mat.sprite;
}

// The spinning record — glossy black vinyl. Same sprite footprint as the mat so
// it drops in centred; the vinyl disc inside is RECORD_RATIO of the mat radius.
export function bakeRecord(env, albumImage = null) {
  const size = _mat ? _mat.size : MAT_R * 2 + 16;
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const g = cv.getContext('2d');
  const cx = size / 2, cy = size / 2;
  const rOut = MAT_R * RECORD_RATIO;
  const rIn = rOut * 0.32;

  const sampleEnv = (u) => (env && env.length ? env[Math.min(env.length - 1, Math.floor(u * env.length))] : 0.3);

  // Glossy black base, upper-left key light.
  const base = g.createRadialGradient(cx - rOut * 0.28, cy - rOut * 0.28, rOut * 0.04, cx, cy, rOut);
  base.addColorStop(0.0, '#1d1d24');
  base.addColorStop(0.4, '#111116');
  base.addColorStop(0.8, '#0a0a0e');
  base.addColorStop(1.0, '#050507');
  g.fillStyle = base;
  g.beginPath(); g.arc(cx, cy, rOut, 0, TAU); g.fill();

  // Concentric grooves — clean rings (no spiral dashes). Brightness + width are
  // subtly modulated by the envelope so the dynamics read as faint banding,
  // with a hint of violet only on the loudest passages. This is the "track line".
  const N = Math.floor(rOut - rIn);
  for (let i = 0; i < N; i++) {
    const u = i / N;
    const r = rOut - (rOut - rIn) * u;
    const e = sampleEnv(u);
    // dark groove valley
    g.strokeStyle = 'rgba(0,0,0,0.30)';
    g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.stroke();
    // lit groove ridge (where light catches), lifted by loudness
    const lift = 0.02 + 0.10 * e * e;
    const vr = Math.round(196 + 30 * e), vg = Math.round(196 + 18 * e), vb = Math.round(212 + 40 * e);
    g.strokeStyle = `rgba(${vr},${vg},${vb},${lift})`;
    g.lineWidth = 0.6 + 1.1 * e;
    g.beginPath(); g.arc(cx, cy, r - 0.5, 0, TAU); g.stroke();
  }

  // Broad glossy sheen sweep (the signature vinyl highlight).
  g.save();
  g.beginPath(); g.arc(cx, cy, rOut, 0, TAU); g.clip();
  const sheen = g.createLinearGradient(cx - rOut, cy - rOut * 0.9, cx + rOut * 0.5, cy + rOut * 0.6);
  sheen.addColorStop(0.00, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.42, 'rgba(255,255,255,0.05)');
  sheen.addColorStop(0.50, 'rgba(255,255,255,0.085)');
  sheen.addColorStop(0.58, 'rgba(255,255,255,0.04)');
  sheen.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = sheen;
  g.fillRect(cx - rOut, cy - rOut, rOut * 2, rOut * 2);
  g.restore();

  // Rim bevel.
  g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,0.05)';
  g.beginPath(); g.arc(cx, cy, rOut - 1.2, 0, TAU); g.stroke();
  g.lineWidth = 1.5; g.strokeStyle = 'rgba(0,0,0,0.7)';
  g.beginPath(); g.arc(cx, cy, rOut, 0, TAU); g.stroke();

  // Matte centre label (NOT a glowing orb).
  g.save();
  g.beginPath(); g.arc(cx, cy, rIn, 0, TAU); g.clip();
  if (albumImage) {
    g.drawImage(albumImage, cx - rIn, cy - rIn, rIn * 2, rIn * 2);
  } else {
    g.fillStyle = '#6a5ecf';
    g.fillRect(cx - rIn, cy - rIn, rIn * 2, rIn * 2);
    const lsh = g.createLinearGradient(cx, cy - rIn, cx, cy + rIn);
    lsh.addColorStop(0, 'rgba(255,255,255,0.12)');
    lsh.addColorStop(0.5, 'rgba(255,255,255,0)');
    lsh.addColorStop(1, 'rgba(0,0,0,0.22)');
    g.fillStyle = lsh; g.fillRect(cx - rIn, cy - rIn, rIn * 2, rIn * 2);
    g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, rIn * 0.66, 0, TAU); g.stroke();
    g.beginPath(); g.arc(cx, cy, rIn * 0.42, 0, TAU); g.stroke();
  }
  g.restore();

  // Dark separation ring around the label.
  g.strokeStyle = 'rgba(0,0,0,0.85)'; g.lineWidth = Math.max(2, rIn * 0.05);
  g.beginPath(); g.arc(cx, cy, rIn, 0, TAU); g.stroke();

  // Spindle hole + chrome ring.
  const sp = Math.max(3, rIn * 0.07);
  g.fillStyle = '#000';
  g.beginPath(); g.arc(cx, cy, sp, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.28)'; g.lineWidth = 0.7;
  g.beginPath(); g.arc(cx, cy, sp + 1.2, 0, TAU); g.stroke();

  return cv;
}

export function drawFrame(ctx, sprites, state, geom) {
  // Uniform device scale (CSS px → device px) → the disc is always circular.
  const scale = ctx.canvas.width / geom.W;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, geom.W, geom.H);

  const matScale = geom.R / MAT_R;

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
    ctx.globalAlpha = clamp(state.dust * 0.16, 0, 0.28);
    const rr = geom.R * RECORD_RATIO;
    const haze = ctx.createRadialGradient(geom.cx, geom.cy, rr * 0.3, geom.cx, geom.cy, rr);
    haze.addColorStop(0, 'rgba(170,170,200,0)');
    haze.addColorStop(1, 'rgba(170,170,200,0.5)');
    ctx.fillStyle = haze;
    ctx.beginPath(); ctx.arc(geom.cx, geom.cy, rr, 0, TAU); ctx.fill();
    ctx.restore();
  }
}
