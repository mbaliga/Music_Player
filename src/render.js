// render.js — canvas2D rendering.
//
// Two performance rules:
//   1. The groove IS the waveform — spiral banded by windowed RMS so the disc
//      shows its own dynamics. Bake it ONCE per track onto a dark vinyl base.
//   2. Each frame = one rotated blit of the baked sprite + a screen-fixed,
//      photographic tonearm. The platter turns under a stationary arm.
//
// Aesthetic target: the phone is a glossy black slab. The record is matte
// black vinyl with subtle coloured groove banding; the tonearm is the hero —
// chunky brushed-aluminium with a polished pivot bearing and a heavy headshell.

import { radiusAtTime, clamp } from './model.js';

const VIOLET = '#8E7BFF';

// ── Groove sprite bake ───────────────────────────────────────────────────────

export function bakeGroove(env, geom, albumImage = null) {
  const { size, rOut, rIn, turns } = geom;
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const g = cv.getContext('2d');
  const cx = size / 2, cy = size / 2;

  // ── Disc base — MATTE BLACK vinyl with a soft upper-left key light ──
  const base = g.createRadialGradient(
    cx - rOut * 0.32, cy - rOut * 0.32, rOut * 0.05,
    cx, cy, rOut,
  );
  base.addColorStop(0.0, '#1b1b20');
  base.addColorStop(0.45, '#101014');
  base.addColorStop(0.8, '#0a0a0d');
  base.addColorStop(1.0, '#050507');
  g.fillStyle = base;
  g.beginPath(); g.arc(cx, cy, rOut, 0, Math.PI * 2); g.fill();

  // ── Fine concentric groove texture — this is what reads as real vinyl ──
  // Many faint dark/light rings catching the key light. Dense but very subtle.
  const ringCount = Math.floor((rOut - rIn) / 1.6);
  for (let i = 0; i < ringCount; i++) {
    const t = i / ringCount;
    const rr = rIn + (rOut - rIn) * t;
    g.strokeStyle = i % 2 === 0 ? 'rgba(255,255,255,0.018)' : 'rgba(0,0,0,0.22)';
    g.lineWidth = 0.6;
    g.beginPath(); g.arc(cx, cy, rr, 0, Math.PI * 2); g.stroke();
  }

  // ── Spiral groove banded by the envelope — KEEP the colour, but muted so the
  //    disc still reads as black vinyl (coloured banding, not light rays). ──
  const totalAngle = turns * Math.PI * 2;
  const steps = Math.floor(turns * 240);
  g.lineCap = 'round';
  let prevX = null, prevY = null;
  for (let s = 0; s <= steps; s++) {
    const u = s / steps;
    const ang = u * totalAngle;
    const r = rOut - (rOut - rIn) * u;
    const x = cx + r * Math.cos(ang);
    const y = cy + r * Math.sin(ang);
    const e = env.length ? env[Math.min(env.length - 1, Math.floor(u * env.length))] : 0.3;
    // Muted: low alpha, desaturated base lifting to violet only on loud passages.
    const alpha = 0.06 + 0.30 * e * e;
    if (prevX !== null) {
      const rC = Math.round(70 + 75 * e);
      const gC = Math.round(64 + 60 * e);
      const bC = Math.round(96 + 120 * e);
      g.strokeStyle = `rgba(${rC},${gC},${bC},${alpha})`;
      g.lineWidth = 0.6 + 1.4 * e;
      g.beginPath(); g.moveTo(prevX, prevY); g.lineTo(x, y); g.stroke();
    }
    prevX = x; prevY = y;
  }

  // ── Outer rim — the vinyl edge bevel catches a thin highlight ──
  const rim = g.createRadialGradient(cx, cy, rOut * 0.92, cx, cy, rOut);
  rim.addColorStop(0, 'rgba(255,255,255,0)');
  rim.addColorStop(0.55, 'rgba(255,255,255,0.015)');
  rim.addColorStop(0.92, 'rgba(255,255,255,0.06)');
  rim.addColorStop(1, 'rgba(0,0,0,0.5)');
  g.fillStyle = rim;
  g.beginPath(); g.arc(cx, cy, rOut, 0, Math.PI * 2); g.fill();

  // ── Centre label ──
  // A clear dark ring separates the label from the grooves (as on a real disc).
  g.save();
  g.beginPath(); g.arc(cx, cy, rIn, 0, Math.PI * 2); g.clip();
  if (albumImage) {
    g.drawImage(albumImage, cx - rIn, cy - rIn, rIn * 2, rIn * 2);
    const vg = g.createRadialGradient(cx, cy, rIn * 0.6, cx, cy, rIn);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.45)');
    g.fillStyle = vg;
    g.fillRect(cx - rIn, cy - rIn, rIn * 2, rIn * 2);
  } else {
    // No art: a restrained dark label, NOT a glowing orb.
    const lab = g.createRadialGradient(
      cx - rIn * 0.25, cy - rIn * 0.25, rIn * 0.08,
      cx, cy, rIn,
    );
    lab.addColorStop(0.0, '#23232e');
    lab.addColorStop(0.55, '#17171f');
    lab.addColorStop(1.0, '#0c0c12');
    g.fillStyle = lab;
    g.fillRect(cx - rIn, cy - rIn, rIn * 2, rIn * 2);
    g.strokeStyle = 'rgba(142,123,255,0.22)';
    g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, rIn * 0.86, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.05)';
    g.lineWidth = 0.5;
    g.beginPath(); g.arc(cx, cy, rIn * 0.55, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(cx, cy, rIn * 0.32, 0, Math.PI * 2); g.stroke();
  }
  g.restore();

  // Dark separation ring around the label.
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.lineWidth = Math.max(2, rIn * 0.045);
  g.beginPath(); g.arc(cx, cy, rIn, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.05)';
  g.lineWidth = 0.75;
  g.beginPath(); g.arc(cx, cy, rIn + g.lineWidth, 0, Math.PI * 2); g.stroke();

  // Spindle hole.
  const spR = Math.max(3, rIn * 0.06);
  g.fillStyle = '#000';
  g.beginPath(); g.arc(cx, cy, spR, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  g.lineWidth = 0.5;
  g.beginPath(); g.arc(cx, cy, spR + 1.3, 0, Math.PI * 2); g.stroke();

  return cv;
}

// ── Per-frame draw ───────────────────────────────────────────────────────────

export function drawFrame(ctx, sprite, state, geom) {
  const { size, cx, cy, rOut, rIn } = geom;
  ctx.clearRect(0, 0, size, size);

  // Rotated blit of the baked disc.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(state.theta);
  ctx.drawImage(sprite, -size / 2, -size / 2);
  ctx.restore();

  // Atmosphere dust haze (wear).
  if (state.dust > 0.001) {
    ctx.save();
    ctx.globalAlpha = clamp(state.dust * 0.22, 0, 0.35);
    const haze = ctx.createRadialGradient(cx, cy, rIn, cx, cy, rOut);
    haze.addColorStop(0, 'rgba(170,170,200,0)');
    haze.addColorStop(1, 'rgba(170,170,200,0.5)');
    ctx.fillStyle = haze;
    ctx.beginPath(); ctx.arc(cx, cy, rOut, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  const r = radiusAtTime(state.t, state.T, rOut, rIn);
  drawTonearm(ctx, geom, r, state.lifted);
}

// ── Tonearm — photographic brushed-aluminium arm ─────────────────────────────
//
// Pivot bearing sits outside the disc at upper-right; the tube sweeps in a
// gentle curve down the right side to a heavy headshell whose stylus rests on
// the groove at radius `needleR`. The whole assembly floats on a soft shadow.

function drawTonearm(ctx, geom, needleR, lifted) {
  const { cx, cy, size, rOut } = geom;

  // Pivot bearing — outside the disc, upper-right.
  const P = { x: cx + rOut * 0.84, y: cy - rOut * 0.92 };

  // Stylus contact point on the disc (lower-right ~5 o'clock; only radius moves).
  const contactAngle = 1.05; // radians, canvas coords (down-right)
  const dirOut = { x: Math.cos(contactAngle), y: Math.sin(contactAngle) };
  const C = { x: cx + needleR * dirOut.x, y: cy + needleR * dirOut.y };

  // Headshell base — just outside the contact point along the radius.
  const Hb = { x: C.x + dirOut.x * size * 0.055, y: C.y + dirOut.y * size * 0.055 };

  // Curved tube as a quadratic bowed to the OUTSIDE (away from disc centre).
  const mid = { x: (P.x + Hb.x) / 2, y: (P.y + Hb.y) / 2 };
  const av = { x: Hb.x - P.x, y: Hb.y - P.y };
  const plen = Math.hypot(av.x, av.y) || 1;
  const perp = { x: -av.y / plen, y: av.x / plen };
  const bow = size * 0.11;
  const qA = { x: mid.x + perp.x * bow, y: mid.y + perp.y * bow };
  const qB = { x: mid.x - perp.x * bow, y: mid.y - perp.y * bow };
  const Q = Math.hypot(qA.x - cx, qA.y - cy) > Math.hypot(qB.x - cx, qB.y - cy) ? qA : qB;

  // Direction the arm enters the headshell (tangent at Hb).
  const headAngle = Math.atan2(Hb.y - Q.y, Hb.x - Q.x);

  const Wt = Math.max(5, size * 0.019); // tube thickness

  ctx.save();
  if (lifted) ctx.globalAlpha = 0.7;

  const tube = new Path2D();
  tube.moveTo(P.x, P.y);
  tube.quadraticCurveTo(Q.x, Q.y, Hb.x, Hb.y);

  // ── Soft drop shadow under the whole arm ──
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = size * 0.03;
  ctx.shadowOffsetX = size * 0.004;
  ctx.shadowOffsetY = size * 0.012;
  ctx.strokeStyle = 'rgba(20,20,24,1)';
  ctx.lineWidth = Wt;
  ctx.lineCap = 'round';
  ctx.stroke(tube);
  ctx.restore();

  // ── Tube as a cylinder: dark base → mid → bright specular line ──
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#26262e'; ctx.lineWidth = Wt;          ctx.stroke(tube);
  ctx.strokeStyle = '#6f6f7d'; ctx.lineWidth = Wt * 0.74;   ctx.stroke(tube);
  ctx.strokeStyle = '#b9b9c8'; ctx.lineWidth = Wt * 0.42;   ctx.stroke(tube);
  ctx.strokeStyle = 'rgba(245,246,252,0.95)'; ctx.lineWidth = Wt * 0.16; ctx.stroke(tube);

  // ── Counterweight — a short cylinder tucked DIRECTLY behind the pivot, along
  //    the arm's axis (drawn before the bearing so the puck overlaps its end). ──
  const tan = { x: Q.x - P.x, y: Q.y - P.y };
  const tlen = Math.hypot(tan.x, tan.y) || 1;
  const back = { x: -tan.x / tlen, y: -tan.y / tlen };
  const cw = { x: P.x + back.x * size * 0.052, y: P.y + back.y * size * 0.052 };
  drawRotatedCylinder(ctx, cw.x, cw.y, Math.atan2(tan.y, tan.x), size * 0.06, size * 0.036);

  // ── Pivot bearing — big polished chrome puck (the visual anchor) ──
  const Rb = size * 0.05;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = size * 0.02;
  ctx.shadowOffsetY = size * 0.006;
  ctx.fillStyle = '#1a1a22';
  ctx.beginPath(); ctx.arc(P.x, P.y, Rb, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  const brG = ctx.createRadialGradient(
    P.x - Rb * 0.4, P.y - Rb * 0.4, Rb * 0.05,
    P.x, P.y, Rb * 1.05,
  );
  brG.addColorStop(0.0, '#f6f6fe');
  brG.addColorStop(0.32, '#c4c4d6');
  brG.addColorStop(0.66, '#5e5e72');
  brG.addColorStop(1.0, '#1d1d29');
  ctx.fillStyle = brG;
  ctx.beginPath(); ctx.arc(P.x, P.y, Rb, 0, Math.PI * 2); ctx.fill();
  const inG = ctx.createRadialGradient(
    P.x - Rb * 0.25, P.y - Rb * 0.25, Rb * 0.03,
    P.x, P.y, Rb * 0.66,
  );
  inG.addColorStop(0.0, '#e8e8f4');
  inG.addColorStop(0.5, '#8a8a9c');
  inG.addColorStop(1.0, '#2a2a38');
  ctx.fillStyle = inG;
  ctx.beginPath(); ctx.arc(P.x, P.y, Rb * 0.62, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(P.x, P.y, Rb * 0.82, Math.PI * 1.05, Math.PI * 1.7); ctx.stroke();
  ctx.fillStyle = '#15151f';
  ctx.beginPath(); ctx.arc(P.x, P.y, Rb * 0.2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.beginPath(); ctx.arc(P.x - Rb * 0.07, P.y - Rb * 0.07, Rb * 0.07, 0, Math.PI * 2); ctx.fill();

  // ── Headshell — heavy angled block at the contact end ──
  ctx.save();
  ctx.translate(Hb.x, Hb.y);
  ctx.rotate(headAngle); // +x points inward toward C

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = size * 0.018;
  ctx.shadowOffsetY = size * 0.009;
  ctx.fillStyle = '#202028';
  roundRect(ctx, -size * 0.012, -Wt * 1.15, size * 0.07, Wt * 2.3, Wt * 0.5);
  ctx.fill();
  ctx.restore();

  const hsLen = size * 0.07;
  const hsHalf = Wt * 1.15;
  const hsG = ctx.createLinearGradient(0, -hsHalf, 0, hsHalf);
  hsG.addColorStop(0.0, '#cdcdde');
  hsG.addColorStop(0.4, '#ededf8');
  hsG.addColorStop(0.62, '#9a9aae');
  hsG.addColorStop(1.0, '#4a4a5a');
  ctx.fillStyle = hsG;
  roundRect(ctx, -size * 0.012, -hsHalf, hsLen, hsHalf * 2, Wt * 0.5);
  ctx.fill();

  // finger-lift tab
  ctx.fillStyle = '#d8d8e6';
  roundRect(ctx, -size * 0.012, -hsHalf - Wt * 0.6, Wt * 1.1, Wt * 0.8, Wt * 0.3);
  ctx.fill();

  // cartridge body
  ctx.fillStyle = '#121220';
  roundRect(ctx, hsLen * 0.5, -hsHalf * 0.7, hsLen * 0.5, hsHalf * 1.4, Wt * 0.25);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath(); ctx.arc(hsLen * 0.62, -hsHalf * 0.32, 1.4, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(hsLen * 0.62,  hsHalf * 0.32, 1.4, 0, Math.PI * 2); ctx.fill();

  ctx.restore(); // headshell

  // ── Stylus cantilever + glowing contact dot ──
  ctx.strokeStyle = lifted ? 'rgba(200,200,210,0.4)' : 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 1.4;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(Hb.x, Hb.y); ctx.lineTo(C.x, C.y); ctx.stroke();

  if (!lifted) {
    ctx.shadowColor = 'rgba(255,255,255,0.9)';
    ctx.shadowBlur = size * 0.014;
  }
  ctx.fillStyle = lifted ? '#7c7c8a' : '#ffffff';
  ctx.beginPath(); ctx.arc(C.x, C.y, Math.max(2, size * 0.006), 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;

  ctx.restore();
}

// Short polished cylinder (counterweight) centred at (x,y), long axis at `angle`.
function drawRotatedCylinder(ctx, x, y, angle, len, dia) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const grad = ctx.createLinearGradient(0, -dia / 2, 0, dia / 2);
  grad.addColorStop(0.0, '#5a5a6a');
  grad.addColorStop(0.32, '#e6e6f2');
  grad.addColorStop(0.6, '#9c9caf');
  grad.addColorStop(1.0, '#2c2c3a');
  ctx.fillStyle = grad;
  roundRect(ctx, -len / 2, -dia / 2, len, dia, dia * 0.45);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 0.8;
  for (const fx of [-0.18, 0.0, 0.18]) {
    ctx.beginPath();
    ctx.moveTo(len * fx, -dia * 0.42);
    ctx.lineTo(len * fx,  dia * 0.42);
    ctx.stroke();
  }
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ── Geometry ─────────────────────────────────────────────────────────────────

export function makeGeometry(size, turns = 34) {
  return { size, cx: size / 2, cy: size / 2, rOut: size * 0.46, rIn: size * 0.17, turns };
}
