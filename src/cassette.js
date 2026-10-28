// ─────────────────────────────────────────────────────────────────────────────
// cassette.js — procedural cassette drawing on canvas2D (no image assets).
//
// Pure drawing: takes a style row from mixtape.js, a size and a state, paints
// one cassette. Reel radii come from mixtape.js:reelRadii (progress → radii);
// this file only scales and draws them. Shell patterns are keyed by
// style.pattern ('clear' | 'solid' | 'rays' | 'grid' | 'checker' | 'waves' |
// 'dots'); add a case in shellPattern() for a new one.
// ─────────────────────────────────────────────────────────────────────────────

import { reelRadii, fontById } from './mixtape.js';

const ASPECT = 1.6; // cassette body width : height (real: 100.4 x 63.8 mm)

// Reel pack size as fractions of cassette height (h); the window clips the pack.
const R_HUB = 0.075, R_MIN = 0.085;

/** Largest cassette rect that fits in (W,H), centred. */
export function cassetteRect(W, H, pad = 0) {
  let w = W - pad * 2, h = w / ASPECT;
  if (h > H - pad * 2) { h = H - pad * 2; w = h * ASPECT; }
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function shellPattern(ctx, s, x, y, w, h) {
  ctx.save();
  rr(ctx, x, y, w, h, h * 0.05); ctx.clip();
  const c2 = s.shell2;
  switch (s.pattern) {
    case 'rays': {
      const cx = x + w / 2, cy = y + h * 0.55;
      for (let i = 0; i < 24; i++) {
        ctx.fillStyle = i % 2 ? c2 : s.shell;
        ctx.beginPath(); ctx.moveTo(cx, cy);
        const a0 = (i / 24) * Math.PI * 2, a1 = ((i + 1) / 24) * Math.PI * 2;
        ctx.arc(cx, cy, w, a0, a1); ctx.closePath(); ctx.fill();
      }
      break;
    }
    case 'grid': {
      ctx.fillStyle = s.shell; ctx.fillRect(x, y, w, h);
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, c2);
      ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = s.stripe; ctx.globalAlpha = 0.55; ctx.lineWidth = Math.max(1, h * 0.006);
      for (let i = 0; i <= 16; i++) { const gx = x + (w / 16) * i; ctx.beginPath(); ctx.moveTo(gx, y + h * 0.7); ctx.lineTo(gx, y + h); ctx.stroke(); }
      for (let i = 0; i < 5; i++) { const gy = y + h * (0.7 + i * 0.075); ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x + w, gy); ctx.stroke(); }
      ctx.globalAlpha = 1;
      break;
    }
    case 'checker': {
      const n = 14, cs = w / n;
      for (let r = 0; r * cs < h; r++) for (let c = 0; c < n; c++) {
        ctx.fillStyle = (r + c) % 2 ? c2 : s.shell; ctx.fillRect(x + c * cs, y + r * cs, cs + 1, cs + 1);
      }
      break;
    }
    case 'waves': {
      ctx.fillStyle = s.shell; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = c2; ctx.lineWidth = h * 0.035; ctx.globalAlpha = 0.8;
      for (let k = 0; k < 7; k++) {
        ctx.beginPath();
        for (let i = 0; i <= 40; i++) {
          const px = x + (w / 40) * i, py = y + h * (0.08 + k * 0.15) + Math.sin(i * 0.5 + k) * h * 0.025;
          i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'dots': {
      ctx.fillStyle = s.shell; ctx.fillRect(x, y, w, h);
      ctx.fillStyle = c2;
      const step = h * 0.1;
      for (let r = 0, yy = y; yy < y + h + step; r++, yy += step)
        for (let xx = x + (r % 2) * step / 2; xx < x + w + step; xx += step) {
          ctx.beginPath(); ctx.arc(xx, yy, step * 0.28, 0, Math.PI * 2); ctx.fill();
        }
      break;
    }
    case 'clear': {
      const g = ctx.createLinearGradient(x, y, x + w, y + h);
      g.addColorStop(0, s.shell2); g.addColorStop(0.5, s.shell); g.addColorStop(1, s.shell2);
      ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
      break;
    }
    default: { // 'solid'
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, s.shell2); g.addColorStop(1, s.shell);
      ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    }
  }
  // soft top sheen on every shell
  const sh = ctx.createLinearGradient(0, y, 0, y + h * 0.5);
  sh.addColorStop(0, 'rgba(255,255,255,0.18)'); sh.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sh; ctx.fillRect(x, y, w, h * 0.5);
  ctx.restore();
}

function fitText(ctx, text, maxW, maxPx, font) {
  let px = maxPx;
  for (; px > 8; px -= 1) {
    ctx.font = `${font.style} ${font.weight} ${px}px ${font.css}`;
    if (ctx.measureText(text).width <= maxW) break;
  }
  return px;
}

function reel(ctx, cx, cy, rTape, rHub, angle, s) {
  // tape pack
  ctx.fillStyle = '#4a3324';
  ctx.beginPath(); ctx.arc(cx, cy, rTape, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, rTape - 1, 0, Math.PI * 2); ctx.stroke();
  // hub
  ctx.fillStyle = s.accent;
  ctx.beginPath(); ctx.arc(cx, cy, rHub, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#0c0c0e';
  ctx.beginPath(); ctx.arc(cx, cy, rHub * 0.62, 0, Math.PI * 2); ctx.fill();
  // six teeth (the visible spin)
  ctx.fillStyle = s.accent;
  for (let i = 0; i < 6; i++) {
    const a = angle + (i / 6) * Math.PI * 2;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(a);
    ctx.fillRect(rHub * 0.28, -rHub * 0.09, rHub * 0.36, rHub * 0.18);
    ctx.restore();
  }
}

/**
 * Paint one cassette into the rect (x,y,w,h).
 *   opts = { name, fontId, fontColor, progress (0..1), angle (rad), showName }
 */
export function drawCassette(ctx, style, rect, opts = {}) {
  const { x, y, w, h } = rect;
  const { name = '', fontId, fontColor = '#1a1a1f', progress = 0, angle = 0, showName = true } = opts;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = h * 0.08; ctx.shadowOffsetY = h * 0.03;
  rr(ctx, x, y, w, h, h * 0.05); ctx.fillStyle = style.shell; ctx.fill();
  ctx.restore();
  shellPattern(ctx, style, x, y, w, h);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = Math.max(1, h * 0.008);
  rr(ctx, x, y, w, h, h * 0.05); ctx.stroke();

  // label (top)
  const lx = x + w * 0.06, ly = y + h * 0.07, lw = w * 0.88, lh = h * 0.40;
  ctx.fillStyle = style.label; rr(ctx, lx, ly, lw, lh, h * 0.025); ctx.fill();
  ctx.fillStyle = style.stripe; ctx.fillRect(lx, ly + lh * 0.82, lw, lh * 0.10);
  ctx.fillStyle = 'rgba(0,0,0,0.12)'; // ruled lines like a hand-labelled J-card
  for (let i = 1; i <= 2; i++) ctx.fillRect(lx + lw * 0.04, ly + lh * (0.28 + i * 0.22), lw * 0.92, 1);
  if (showName) {
    const f = fontById(fontId);
    ctx.fillStyle = fontColor; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const px = fitText(ctx, name, lw * 0.9, lh * 0.42, f);
    ctx.font = `${f.style} ${f.weight} ${px}px ${f.css}`;
    ctx.fillText(name, lx + lw / 2, ly + lh * 0.42, lw * 0.9);
  }

  // window + reels (middle/bottom)
  const wx = x + w * 0.20, wy = y + h * 0.50, ww = w * 0.60, wh = h * 0.28;
  ctx.fillStyle = '#0a0a0c'; rr(ctx, wx, wy, ww, wh, wh / 2); ctx.fill();
  ctx.save(); rr(ctx, wx, wy, ww, wh, wh / 2); ctx.clip();
  const rMin = h * R_MIN * 0.6, rMax = (wh / 2) * 0.98; // pack can't exceed the window
  const r = reelRadii(progress, rMin, rMax);
  const hub = h * R_HUB * 0.55;
  const cy = wy + wh / 2, dx = ww * 0.28;
  reel(ctx, x + w / 2 - dx, cy, r.supply, hub, angle, style);
  reel(ctx, x + w / 2 + dx, cy, r.take, hub, angle, style);
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = Math.max(1, h * 0.008);
  rr(ctx, wx, wy, ww, wh, wh / 2); ctx.stroke();

  // bottom trapezoid + screws
  ctx.fillStyle = 'rgba(0,0,0,0.38)';
  ctx.beginPath();
  ctx.moveTo(x + w * 0.16, y + h); ctx.lineTo(x + w * 0.22, y + h * 0.84);
  ctx.lineTo(x + w * 0.78, y + h * 0.84); ctx.lineTo(x + w * 0.84, y + h); ctx.closePath(); ctx.fill();
  ctx.fillStyle = style.accent;
  for (const [fx, fy] of [[0.04, 0.06], [0.96, 0.06], [0.04, 0.94], [0.96, 0.94]]) {
    ctx.beginPath(); ctx.arc(x + w * fx, y + h * fy, h * 0.018, 0, Math.PI * 2); ctx.fill();
  }
  for (const fx of [0.30, 0.40, 0.60, 0.70]) {
    ctx.fillStyle = '#0a0a0c';
    ctx.beginPath(); ctx.arc(x + w * fx, y + h * 0.92, h * 0.02, 0, Math.PI * 2); ctx.fill();
  }
}
