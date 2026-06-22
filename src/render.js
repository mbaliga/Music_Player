// ─────────────────────────────────────────────────────────────────────────────
// render.js — canvas2D rendering (spec §6).
//
// v0 uses canvas2D to validate FEEL, not look — the real glass/ferrofluid Hyle
// materials come in the WebGL/AGSL pass. Two performance rules from the spec are
// honored here:
//
//   1. The groove IS the waveform: the spiral is generated from the decoded
//      envelope (brightness/thickness banding by windowed RMS), so the disc
//      shows its own dynamics — you can aim the needle at the quiet intro / drop.
//   2. Bake the groove. The static spiral + banding is drawn ONCE into an
//      offscreen sprite; each frame is just a rotated blit of that layer plus
//      the screen-fixed needle. The platter rotates under a stationary needle.
//
// Light Hyle cues only (violet ramp #8E7BFF, soft upper-left key light): state
// is shown materially (spin speed, dust density), never as a "33" label.
// ─────────────────────────────────────────────────────────────────────────────

import { radiusAtTime, clamp } from './model.js';

const VIOLET = '#8E7BFF';

/**
 * Bake the static groove sprite once per track.
 *   env  — Float32Array RMS envelope in [0,1]
 *   geom — { size, cx, cy, rOut, rIn, turns }
 * Returns an offscreen canvas the size of the disc bounding box, centered.
 */
export function bakeGroove(env, geom, albumImage = null) {
  const { size, rOut, rIn, turns } = geom;
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const g = cv.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;

  // Disc base — dark glass with a soft upper-left key-light gradient.
  const grad = g.createRadialGradient(cx - rOut * 0.35, cy - rOut * 0.35, rOut * 0.1, cx, cy, rOut);
  grad.addColorStop(0, '#23232b');
  grad.addColorStop(1, '#0c0c10');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx, cy, rOut, 0, Math.PI * 2);
  g.fill();

  // ── The spiral groove, banded by the envelope ──
  // Walk one continuous spiral from rOut (t=0) inward to rIn (t=T). The spiral
  // parameter u = t/T indexes the envelope, so the groove brightness/thickness
  // tracks the music's loudness at that point in time.
  const totalAngle = turns * Math.PI * 2;
  const steps = Math.floor(turns * 240);
  g.lineCap = 'round';
  let prevX = null, prevY = null;
  for (let s = 0; s <= steps; s++) {
    const u = s / steps;                       // 0..1 == t/T
    const ang = u * totalAngle;
    const r = rOut - (rOut - rIn) * u;
    const x = cx + r * Math.cos(ang);
    const y = cy + r * Math.sin(ang);

    const e = env.length ? env[Math.min(env.length - 1, Math.floor(u * env.length))] : 0.3;
    // Banding: louder → brighter + slightly thicker groove wall.
    const bright = 0.18 + 0.55 * e;
    const width = 0.8 + 1.8 * e;
    if (prevX !== null) {
      g.strokeStyle = `rgba(${Math.round(120 + 80 * e)}, ${Math.round(110 + 70 * e)}, ${Math.round(160 + 95 * e)}, ${bright})`;
      g.lineWidth = width;
      g.beginPath();
      g.moveTo(prevX, prevY);
      g.lineTo(x, y);
      g.stroke();
    }
    prevX = x; prevY = y;
  }

  // ── Album label fills the inner disc (inside rIn) ──
  g.save();
  g.beginPath();
  g.arc(cx, cy, rIn, 0, Math.PI * 2);
  g.clip();
  if (albumImage) {
    g.drawImage(albumImage, cx - rIn, cy - rIn, rIn * 2, rIn * 2);
  } else {
    const lab = g.createRadialGradient(cx, cy, 2, cx, cy, rIn);
    lab.addColorStop(0, VIOLET);
    lab.addColorStop(1, '#3a2f6b');
    g.fillStyle = lab;
    g.fillRect(cx - rIn, cy - rIn, rIn * 2, rIn * 2);
  }
  g.restore();
  // Spindle hole.
  g.fillStyle = '#0c0c10';
  g.beginPath();
  g.arc(cx, cy, Math.max(3, rIn * 0.06), 0, Math.PI * 2);
  g.fill();

  return cv;
}

/**
 * Draw one frame.
 *   ctx     — visible canvas 2d context (sized geom.size square)
 *   sprite  — baked groove canvas from bakeGroove()
 *   state   — { theta, t, T, dust } where theta is platter angle (rad),
 *             t/T position the needle, dust ∈ [0,1] scales atmosphere haze
 *   geom    — same geometry object used for baking
 */
export function drawFrame(ctx, sprite, state, geom) {
  const { size, cx, cy, rOut, rIn } = geom;
  ctx.clearRect(0, 0, size, size);

  // Rotated blit of the baked platter — a single transformed draw.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(state.theta);
  ctx.drawImage(sprite, -size / 2, -size / 2);
  ctx.restore();

  // Atmosphere: dust/fog density on the glass scales with wear (spec §6/§7).
  if (state.dust > 0.001) {
    ctx.save();
    ctx.globalAlpha = clamp(state.dust * 0.25, 0, 0.4);
    const haze = ctx.createRadialGradient(cx, cy, rIn, cx, cy, rOut);
    haze.addColorStop(0, 'rgba(180,180,200,0)');
    haze.addColorStop(1, 'rgba(180,180,200,0.5)');
    ctx.fillStyle = haze;
    ctx.beginPath();
    ctx.arc(cx, cy, rOut, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ── Tonearm + needle, fixed in screen space (the platter turns under it) ──
  const r = radiusAtTime(state.t, state.T, rOut, rIn);
  drawTonearm(ctx, geom, r, state.lifted);
}

function drawTonearm(ctx, geom, needleR, lifted) {
  const { cx, cy, rOut, size } = geom;
  // Pivot at the upper-right, outside the disc.
  const pivot = { x: cx + rOut * 0.98, y: cy - rOut * 0.95 };
  // Needle sits on the disc directly above center at radius needleR (12 o'clock-ish).
  const needle = { x: cx + needleR * Math.cos(-Math.PI / 2.3), y: cy + needleR * Math.sin(-Math.PI / 2.3) };

  ctx.save();
  if (lifted) ctx.globalAlpha = 0.55;
  // Arm
  ctx.strokeStyle = '#cfd0d8';
  ctx.lineWidth = Math.max(4, size * 0.012);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pivot.x, pivot.y);
  ctx.lineTo(needle.x, needle.y);
  ctx.stroke();
  // Pivot (ferrofluid control point — drawn as a violet node)
  ctx.fillStyle = VIOLET;
  ctx.beginPath();
  ctx.arc(pivot.x, pivot.y, Math.max(6, size * 0.02), 0, Math.PI * 2);
  ctx.fill();
  // Headshell / needle tip
  ctx.fillStyle = lifted ? '#888' : '#fff';
  ctx.beginPath();
  ctx.arc(needle.x, needle.y, Math.max(4, size * 0.012), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Compute disc geometry for a given canvas pixel size. */
export function makeGeometry(size, turns = 34) {
  return {
    size,
    cx: size / 2,
    cy: size / 2,
    rOut: size * 0.46,
    rIn: size * 0.16,
    turns,
  };
}
