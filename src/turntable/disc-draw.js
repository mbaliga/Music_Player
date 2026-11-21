// disc-draw.js — canvas painting of the record (body, waveform spiral, label, spindle), the dot-matrix display and the seek ghost.
// Ported from the prototype's drawDisc / drawDisplay. All coordinates are STAGE units; the caller sets the canvas transform.
//
// Hot-loop rule: nothing is allocated per frame here. The ribbon points live in one Float32Array, the display bitmap in one
// Uint8Array, gradients are built once, strings come from small precomputed tables.
import { C, RDISC, DISP, rOf, Tp, phiOf } from './geometry.js';
import { M, makeTables, makeEnv, fillRibbon, playIndex, highlightRange, highlightAlpha, BUMP_STEP } from './spiral.js';
import * as D from './display.js';

const TAU7 = 7;   // > 2*PI, the prototype's full-circle sweep
const HI_STR = Array.from({ length: 33 }, (_, i) => `rgba(255,255,255,${(i / 32 * 0.55).toFixed(3)})`);

export class DiscPainter {
  constructor() {
    this.tables = makeTables();
    this.env = makeEnv();
    this.pts = new Float32Array(M * 4);
    this.lit = new Uint8Array(D.GRID * D.GRID);
    this.eqHold = new Float32Array(D.EQ_BARS);
    this.eqVals = new Float32Array(D.EQ_BARS);
    this.label = null;       // Image, set by the stage once rasterised
    this.labelArt = null;    // canvas: the current album's own label (label-art.js); the default art above when null
    this._g = null;          // cached gradients, per context
    this._ctx = null;
  }

  _grads(ctx) {
    if (this._ctx === ctx && this._g) return this._g;
    const body = ctx.createRadialGradient(C.x - 90, C.y - 140, 40, C.x, C.y, RDISC);
    body.addColorStop(0, '#18181b'); body.addColorStop(0.55, '#0d0d0f'); body.addColorStop(1, '#09090a');
    let cone = null;
    if (ctx.createConicGradient) {
      cone = ctx.createConicGradient(-0.55, C.x, C.y);
      cone.addColorStop(0, 'rgba(255,255,255,0)'); cone.addColorStop(0.07, 'rgba(255,255,255,.075)'); cone.addColorStop(0.14, 'rgba(255,255,255,0)');
      cone.addColorStop(0.5, 'rgba(255,255,255,0)'); cone.addColorStop(0.57, 'rgba(255,255,255,.06)'); cone.addColorStop(0.64, 'rgba(255,255,255,0)');
      cone.addColorStop(1, 'rgba(255,255,255,0)');
    }
    const spindle = ctx.createRadialGradient(C.x - 5, C.y - 6, 1, C.x, C.y, 17);
    spindle.addColorStop(0, '#c4c4c8'); spindle.addColorStop(0.6, '#7d7d82'); spindle.addColorStop(1, '#55555a');
    const bezel = ctx.createLinearGradient(-60, -90, 60, 90);
    bezel.addColorStop(0, 'rgba(200,200,210,.42)'); bezel.addColorStop(0.5, 'rgba(120,120,130,.18)'); bezel.addColorStop(1, 'rgba(200,200,210,.30)');
    const haze = ctx.createRadialGradient(C.x, C.y, RDISC * 0.86 * 0.3, C.x, C.y, RDISC * 0.86);
    haze.addColorStop(0, 'rgba(170,170,200,0)'); haze.addColorStop(1, 'rgba(170,170,200,0.5)');
    this._ctx = ctx; this._g = { body, cone, spindle, bezel, haze };
    return this._g;
  }

  _ribbon(ctx, i0, i1, fill) {
    if (i1 <= i0) return;
    const p = this.pts;
    ctx.beginPath();
    ctx.moveTo(p[4 * i0], p[4 * i0 + 1]);
    for (let i = i0 + 1; i <= i1; i++) ctx.lineTo(p[4 * i], p[4 * i + 1]);
    for (let i = i1; i >= i0; i--) ctx.lineTo(p[4 * i + 2], p[4 * i + 3]);
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  }

  /** s = playhead 0..1 (the disc is rotated so the playhead sits under the stylus); wv = waveform amount 0..1; dust 0..1 wear haze */
  drawDisc(ctx, s, wv = 1, dust = 0) {
    const g = this._grads(ctx);
    const phi = phiOf(s);
    ctx.save();
    ctx.beginPath(); ctx.arc(C.x, C.y, RDISC, 0, TAU7); ctx.fillStyle = g.body; ctx.fill();
    if (g.cone) { ctx.beginPath(); ctx.arc(C.x, C.y, RDISC, 0, TAU7); ctx.fillStyle = g.cone; ctx.fill(); }
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.11)'; ctx.beginPath(); ctx.arc(C.x, C.y, RDISC - 1.5, 0, TAU7); ctx.stroke();
    ctx.lineWidth = 14; ctx.strokeStyle = 'rgba(255,255,255,.022)'; ctx.beginPath(); ctx.arc(C.x, C.y, RDISC - 12, 0, TAU7); ctx.stroke();
    if (wv > 0 || true) {   // the spiral is always drawn (wv only scales the playhead magnification)
      fillRibbon(this.pts, this.tables, this.env, s, wv, phi);
      const iS = playIndex(s);
      this._ribbon(ctx, 0, iS, 'rgba(128,128,140,.62)');
      this._ribbon(ctx, iS, M - 1, 'rgba(214,214,224,.88)');
      const [a0, a1] = highlightRange(iS);
      for (let j = a0; j < a1; j += BUMP_STEP) {
        const j1 = Math.min(a1, j + BUMP_STEP), al = highlightAlpha((j + j1) / 2 / (M - 1), s, wv);
        if (al > 0.01) this._ribbon(ctx, j, j1, HI_STR[Math.min(32, Math.round(al / 0.55 * 32))]);
      }
    }
    // label + spindle
    ctx.beginPath(); ctx.arc(C.x, C.y, 226, 0, TAU7); ctx.fillStyle = '#0b0b0c'; ctx.fill();
    ctx.save(); ctx.translate(C.x, C.y); ctx.rotate(phi);
    const lab = this.labelArt || this.label;
    if (lab) ctx.drawImage(lab, -217, -217, 434, 434);
    ctx.restore();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.arc(C.x, C.y, 216, 0, TAU7); ctx.stroke();
    ctx.beginPath(); ctx.arc(C.x, C.y, 17, 0, TAU7); ctx.fillStyle = g.spindle; ctx.fill();
    if (dust > 0.001) {   // the old wear haze, kept: more plays = a faint dusty rim
      ctx.globalAlpha = Math.min(0.28, dust * 0.16);
      ctx.beginPath(); ctx.arc(C.x, C.y, RDISC * 0.86, 0, TAU7); ctx.fillStyle = g.haze; ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  /**
   * The dot-matrix display. opts = { portrait, active, mode (0 name+pips / 1 EQ), name, trackCount, trackIndex, now (ms), vals (EQ 0..1 x13 | null) }
   */
  drawDisplay(ctx, o) {
    const g = this._grads(ctx), lit = this.lit;
    ctx.save(); ctx.translate(DISP.x, DISP.y); if (o.portrait) ctx.rotate(-Math.PI / 2);
    ctx.beginPath(); ctx.arc(0, 0, D.R_BEZEL, 0, TAU7); ctx.fillStyle = '#030304'; ctx.fill();
    ctx.lineWidth = 2.2; ctx.strokeStyle = g.bezel; ctx.beginPath(); ctx.arc(0, 0, 107, 0, TAU7); ctx.stroke();
    let any = false;
    if (o.active) {
      lit.fill(0); any = true;
      if (o.mode === 0) {
        const cols = D.textColsCached(o.name || '');
        D.fillName(lit, cols, D.scrollOffset(o.now / 1000, cols.length));
        D.fillPips(lit, D.pipLayout(o.trackCount, o.trackIndex));
      } else if (o.vals) D.fillEq(lit, o.vals, this.eqHold);
    }
    const R2 = D.R_USE * D.R_USE, W2 = D.GRID, P = D.DP;
    ctx.fillStyle = '#17171a'; ctx.beginPath();
    for (let j = -D.DN; j <= D.DN; j++) for (let i = -D.DN; i <= D.DN; i++) { const x = i * P, y = j * P; if (x * x + y * y > R2) continue; ctx.moveTo(x + D.R_UNLIT, y); ctx.arc(x, y, D.R_UNLIT, 0, TAU7); }
    ctx.fill();
    if (any) {
      ctx.fillStyle = '#e6e6ec'; ctx.beginPath();
      for (let j = -D.DN; j <= D.DN; j++) for (let i = -D.DN; i <= D.DN; i++) { if (lit[(j + D.DN) * W2 + (i + D.DN)] !== 1) continue; const x = i * P, y = j * P; if (x * x + y * y > R2) continue; ctx.moveTo(x + D.R_LIT, y); ctx.arc(x, y, D.R_LIT, 0, TAU7); }
      ctx.fill();
      ctx.fillStyle = '#5b5b64'; ctx.beginPath();
      for (let j = -D.DN; j <= D.DN; j++) for (let i = -D.DN; i <= D.DN; i++) { if (lit[(j + D.DN) * W2 + (i + D.DN)] !== 2) continue; const x = i * P, y = j * P; ctx.moveTo(x + D.R_PIP, y); ctx.arc(x, y, D.R_PIP, 0, TAU7); }
      ctx.fill();
      ctx.globalAlpha = 0.16; ctx.fillStyle = '#e6e6ec'; ctx.beginPath();
      for (let j = -D.DN; j <= D.DN; j++) for (let i = -D.DN; i <= D.DN; i++) { if (lit[(j + D.DN) * W2 + (i + D.DN)] !== 1) continue; const x = i * P, y = j * P; if (x * x + y * y > R2) continue; ctx.moveTo(x + D.R_GLOW, y); ctx.arc(x, y, D.R_GLOW, 0, TAU7); }
      ctx.fill(); ctx.globalAlpha = 1;
    } else { ctx.fillStyle = 'rgba(230,230,240,.35)'; ctx.beginPath(); ctx.arc(0, 0, 3, 0, TAU7); ctx.fill(); }
    ctx.restore();
  }

  /**
   * Silent-seek ghost (the old needle-fx overlay, re-expressed on the chord): a dashed ring at the groove radius under the stylus
   * position `s`, a marker on the chord, a pill label, and after a set-down an expanding ripple.
   *   ghost = { s, label, gap }, drop = { s, t (0..1) } | null
   */
  drawGhost(ctx, ghost, drop, portrait) {
    if (!ghost && !drop) return;
    ctx.save();
    if (ghost) {
      const r = rOf(ghost.s), p = Tp(ghost.s);
      ctx.strokeStyle = ghost.gap ? 'rgba(255,214,140,0.85)' : 'rgba(170,150,255,0.8)';
      ctx.lineWidth = ghost.gap ? 3 : 2; ctx.setLineDash([9, 9]);
      ctx.beginPath(); ctx.arc(C.x, C.y, r, 0, TAU7); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = ghost.gap ? '#ffd68c' : '#b9acff'; ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, TAU7); ctx.fill();
      if (ghost.label) {
        ctx.translate(p.x, p.y + 52); if (portrait) ctx.rotate(-Math.PI / 2);
        ctx.font = '600 24px system-ui, sans-serif';
        const w = ctx.measureText(ghost.label).width + 28;
        ctx.fillStyle = 'rgba(16,16,22,0.88)'; ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1.5;
        pill(ctx, -w / 2, -22, w, 44); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#eceaff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(ghost.label, 0, 1);
      }
    }
    if (drop && drop.t < 1) {
      const k = drop.t;
      ctx.strokeStyle = `rgba(190,175,255,${(0.7 * (1 - k)).toFixed(3)})`; ctx.lineWidth = 6 * (1 - k) + 1;
      ctx.beginPath(); ctx.arc(C.x, C.y, rOf(drop.s) + 28 * (1 - Math.pow(1 - k, 2)), 0, TAU7); ctx.stroke();
    }
    ctx.restore();
  }
}

function pill(ctx, x, y, w, h) {
  const r = h / 2;
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
