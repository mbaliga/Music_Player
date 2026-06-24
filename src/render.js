// render.js — canvas2D rendering.
//
// Two performance rules:
//   1. The groove IS the waveform — spiral banded by windowed RMS so the disc
//      shows its own dynamics. Bake it ONCE per track.
//   2. Each frame = one rotated blit of the baked sprite + a fixed tonearm.
//      The platter turns under a stationary needle; the needle never redraws.

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

  // ── Disc base — dark glass with upper-left key light ──
  const base = g.createRadialGradient(cx - rOut * 0.35, cy - rOut * 0.35, rOut * 0.06, cx, cy, rOut);
  base.addColorStop(0, '#28283a');
  base.addColorStop(0.55, '#141420');
  base.addColorStop(1, '#0a0a0e');
  g.fillStyle = base;
  g.beginPath();
  g.arc(cx, cy, rOut, 0, Math.PI * 2);
  g.fill();

  // Subtle concentric sheen lines (pressed vinyl surface texture)
  for (let i = 0; i < 3; i++) {
    const sr = rIn + (rOut - rIn) * (0.25 + i * 0.25);
    g.strokeStyle = 'rgba(255,255,255,0.025)';
    g.lineWidth = 0.5;
    g.beginPath();
    g.arc(cx, cy, sr, 0, Math.PI * 2);
    g.stroke();
  }

  // ── Spiral groove banded by the envelope ──
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
    const bright = 0.18 + 0.55 * e;
    if (prevX !== null) {
      g.strokeStyle = `rgba(${Math.round(100 + 90 * e)},${Math.round(90 + 75 * e)},${Math.round(145 + 100 * e)},${bright})`;
      g.lineWidth = 0.7 + 1.9 * e;
      g.beginPath(); g.moveTo(prevX, prevY); g.lineTo(x, y); g.stroke();
    }
    prevX = x; prevY = y;
  }

  // ── Outer rim highlight (vinyl bevel catches light) ──
  const rim = g.createRadialGradient(cx, cy, rOut * 0.93, cx, cy, rOut);
  rim.addColorStop(0, 'rgba(255,255,255,0)');
  rim.addColorStop(0.5, 'rgba(255,255,255,0.02)');
  rim.addColorStop(1, 'rgba(255,255,255,0.07)');
  g.fillStyle = rim;
  g.beginPath(); g.arc(cx, cy, rOut, 0, Math.PI * 2); g.fill();

  // ── Label area (inside rIn) ──
  g.save();
  g.beginPath(); g.arc(cx, cy, rIn, 0, Math.PI * 2); g.clip();
  if (albumImage) {
    g.drawImage(albumImage, cx - rIn, cy - rIn, rIn * 2, rIn * 2);
  } else {
    const lab = g.createRadialGradient(cx, cy, 2, cx, cy, rIn);
    lab.addColorStop(0, '#a090ff');
    lab.addColorStop(0.5, VIOLET);
    lab.addColorStop(1, '#2e2560');
    g.fillStyle = lab;
    g.fillRect(cx - rIn, cy - rIn, rIn * 2, rIn * 2);
    // Faint label text ring
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.lineWidth = 0.5;
    g.beginPath(); g.arc(cx, cy, rIn * 0.82, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(cx, cy, rIn * 0.4, 0, Math.PI * 2); g.stroke();
  }
  g.restore();

  // Spindle hole
  g.fillStyle = '#000';
  g.beginPath(); g.arc(cx, cy, Math.max(3, rIn * 0.065), 0, Math.PI * 2); g.fill();
  // Spindle highlight
  g.strokeStyle = 'rgba(255,255,255,0.15)';
  g.lineWidth = 0.5;
  g.beginPath(); g.arc(cx, cy, Math.max(3, rIn * 0.065) + 1.5, 0, Math.PI * 2); g.stroke();

  return cv;
}

// ── Per-frame draw ───────────────────────────────────────────────────────────

export function drawFrame(ctx, sprite, state, geom) {
  const { size, cx, cy, rOut, rIn } = geom;
  ctx.clearRect(0, 0, size, size);

  // Rotated blit
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(state.theta);
  ctx.drawImage(sprite, -size / 2, -size / 2);
  ctx.restore();

  // Atmosphere dust haze (wear)
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

// ── Tonearm — skeuomorphic brushed-aluminium arm ─────────────────────────────

function drawTonearm(ctx, geom, needleR, lifted) {
  const { cx, cy, rOut, size } = geom;

  // Pivot — outside disc, upper-right
  const px = cx + rOut * 1.04;
  const py = cy - rOut * 0.88;

  // Stylus contact point on the disc
  const contactAngle = -Math.PI / 2.3;
  const nx = cx + needleR * Math.cos(contactAngle);
  const ny = cy + needleR * Math.sin(contactAngle);

  // Arm geometry
  const armAngle = Math.atan2(ny - py, nx - px);
  const armLen   = Math.hypot(nx - px, ny - py);
  const perpX = -Math.sin(armAngle);
  const perpY =  Math.cos(armAngle);
  const armW  = Math.max(5, size * 0.013);

  // Headshell endpoint (slightly past the needle, arm overshoots)
  const hx = nx + Math.cos(armAngle) * size * 0.028;
  const hy = ny + Math.sin(armAngle) * size * 0.028;

  // Counterweight (opposite side of pivot)
  const cwLen = armLen * 0.2;
  const cwx = px - Math.cos(armAngle) * cwLen;
  const cwy = py - Math.sin(armAngle) * cwLen;

  ctx.save();
  if (lifted) ctx.globalAlpha = 0.62;

  // Drop shadow (arm floating above disc)
  ctx.shadowColor = 'rgba(0,0,0,0.75)';
  ctx.shadowBlur   = size * 0.022;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = size * 0.008;

  // ── Arm tube — metallic gradient perpendicular to arm direction ──
  const armGrad = ctx.createLinearGradient(
    px + perpX * armW, py + perpY * armW,
    px - perpX * armW, py - perpY * armW,
  );
  armGrad.addColorStop(0.00, '#606070');
  armGrad.addColorStop(0.20, '#d0d0e0');
  armGrad.addColorStop(0.50, '#f2f2fc');
  armGrad.addColorStop(0.78, '#a8a8ba');
  armGrad.addColorStop(1.00, '#484858');
  ctx.strokeStyle = armGrad;
  ctx.lineWidth = armW;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(hx, hy); ctx.stroke();

  // ── Counterweight arm (slightly thinner) ──
  ctx.lineWidth = armW * 0.88;
  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(cwx, cwy); ctx.stroke();

  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

  // ── Counterweight — polished cylinder end-on ──
  const cwR = size * 0.027;
  const cwG = ctx.createRadialGradient(
    cwx - cwR * 0.38, cwy - cwR * 0.38, cwR * 0.04,
    cwx, cwy, cwR * 1.05,
  );
  cwG.addColorStop(0.0, '#e4e4f0');
  cwG.addColorStop(0.35, '#9090a8');
  cwG.addColorStop(0.72, '#3c3c50');
  cwG.addColorStop(1.0, '#141420');
  ctx.fillStyle = cwG;
  ctx.beginPath(); ctx.arc(cwx, cwy, cwR, 0, Math.PI * 2); ctx.fill();
  // Edge ring
  ctx.strokeStyle = 'rgba(255,255,255,0.13)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cwx, cwy, cwR * 0.75, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
  // Adjustment groove
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.arc(cwx, cwy, cwR * 0.45, 0, Math.PI * 2); ctx.stroke();

  // ── Headshell — wider angular piece at the needle end ──
  ctx.save();
  ctx.translate(nx, ny);
  ctx.rotate(armAngle);

  const hsW = armW * 1.65;
  const hsLen = size * 0.05;
  const hsGrad = ctx.createLinearGradient(0, -hsW, 0, hsW);
  hsGrad.addColorStop(0.0, '#b8b8cc');
  hsGrad.addColorStop(0.35, '#e8e8f8');
  hsGrad.addColorStop(0.6, '#9898b0');
  hsGrad.addColorStop(1.0, '#484858');
  ctx.fillStyle = hsGrad;
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(-hsLen * 0.22, -hsW * 0.5);
  ctx.lineTo( hsLen * 0.72, -hsW * 0.32);
  ctx.lineTo( hsLen * 0.72,  hsW * 0.32);
  ctx.lineTo(-hsLen * 0.22,  hsW * 0.5);
  ctx.closePath();
  ctx.fill(); ctx.stroke();

  // Cartridge body (dark block below the headshell)
  ctx.fillStyle = '#16162a';
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 0.5;
  const cL = hsLen * 0.52, cH = hsW * 0.62;
  ctx.beginPath();
  ctx.rect(-hsLen * 0.1, -cH / 2, cL, cH);
  ctx.fill(); ctx.stroke();
  // Cart screw dots
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.beginPath(); ctx.arc(0, -cH * 0.28, 1.5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(0,  cH * 0.28, 1.5, 0, Math.PI * 2); ctx.fill();

  ctx.restore();

  // ── Stylus cantilever (thin line from cartridge to contact point) ──
  ctx.strokeStyle = lifted ? 'rgba(200,200,200,0.35)' : 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 1.2;
  ctx.lineCap = 'round';
  const styl = size * 0.018;
  const sAngle = armAngle + Math.PI * 0.5; // points roughly toward disc
  ctx.beginPath();
  ctx.moveTo(nx, ny);
  ctx.lineTo(nx + Math.cos(sAngle) * styl, ny + Math.sin(sAngle) * styl);
  ctx.stroke();

  // ── Pivot bearing — polished chrome ──
  const brR = size * 0.024;
  const brG = ctx.createRadialGradient(
    px - brR * 0.42, py - brR * 0.42, brR * 0.04,
    px, py, brR * 1.1,
  );
  brG.addColorStop(0.0, '#f8f8ff');
  brG.addColorStop(0.28, '#c8c8e0');
  brG.addColorStop(0.62, '#585870');
  brG.addColorStop(1.0, '#181828');
  ctx.fillStyle = brG;
  ctx.beginPath(); ctx.arc(px, py, brR, 0, Math.PI * 2); ctx.fill();
  // Highlight arc
  ctx.strokeStyle = 'rgba(255,255,255,0.32)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(px, py, brR * 0.72, Math.PI * 1.1, Math.PI * 1.65); ctx.stroke();
  // Center pin
  ctx.fillStyle = '#0c0c1a';
  ctx.beginPath(); ctx.arc(px, py, brR * 0.17, 0, Math.PI * 2); ctx.fill();
  // Pin glint
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath(); ctx.arc(px - brR * 0.06, py - brR * 0.06, brR * 0.07, 0, Math.PI * 2); ctx.fill();

  // ── Needle contact — glows when playing ──
  if (!lifted) {
    ctx.shadowColor = 'rgba(255,255,255,0.95)';
    ctx.shadowBlur  = size * 0.016;
  }
  ctx.fillStyle = lifted ? '#808090' : '#ffffff';
  ctx.beginPath();
  ctx.arc(nx, ny, Math.max(2, size * 0.0065), 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.restore();
}

// ── Geometry ─────────────────────────────────────────────────────────────────

export function makeGeometry(size, turns = 34) {
  return { size, cx: size / 2, cy: size / 2, rOut: size * 0.46, rIn: size * 0.16, turns };
}
