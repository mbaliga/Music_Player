// ─────────────────────────────────────────────────────────────────────────────
// reels-driver.js — drives the drawn reels of ONE mounted cassette from real
// playback. No loop of its own: the host calls frame(p, mul, dt) once per
// animation frame (Runout's main loop -> MixtapeUI.tick), only while the player
// is visible.
//
// Per frame this touches only transforms (SVGTransform.setRotate through the
// cached baseVal item: no strings, no allocation). The pack radii, tape path
// and marker change with progress, which is slow, so they are rewritten only
// when progress moved enough to matter (EPS_P), never every frame.
// ─────────────────────────────────────────────────────────────────────────────

import { famFor, packR, tapeD, markerX, hubStep, rollerStep, toDeg, fx } from './reels-physics.js';

const EPS_P = 0.0004;     // progress change worth redrawing the packs / tape path (px-level at 130 px)
const NS = 'http://www.w3.org/2000/svg';

/** Cached no-allocation rotate setter for an element that already has a rotate transform. */
function rotator(el) {
  if (!el) return null;
  try {
    const list = el.transform && el.transform.baseVal;
    if (list && list.numberOfItems > 0) {
      const t = list.getItem(0);
      if (typeof t.setRotate === 'function') return (rad) => t.setRotate(toDeg(rad), 0, 0);
    }
  } catch { /* fall through */ }
  return (rad) => el.setAttribute('transform', 'rotate(' + (toDeg(rad) % 360).toFixed(2) + ')');
}

export function createReelDriver({ onWindStart, onWindEnd } = {}) {
  let f = null;
  let els = null;
  let angL = 0, angR = 2.39, angRo = 0;
  let drawnP = -1;
  let rotL = null, rotR = null, rotRo = null;
  const stats = { packWrites: 0, tapeWrites: 0, spinWrites: 0 };

  function writePacks(p) {
    for (const side of ['left', 'right']) {
      const e = els[side]; if (!e) continue;
      const r = packR(f, side, p);
      if (e.pack) e.pack.setAttribute('r', fx(r));
      if (e.edge) e.edge.setAttribute('r', fx(r - 2.5));
    }
    if (els.tape && f.tape) { els.tape.setAttribute('d', tapeD(f, packR(f, 'left', p), packR(f, 'right', p))); stats.tapeWrites++; }
    if (els.mark) els.mark.setAttribute('x', fx(markerX(f, p) - 1.3));
    stats.packWrites++;
    drawnP = p;
  }

  function addHits(svg) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('data-layer', 'reel-hit');
    for (const side of ['left', 'right']) {
      const m = f.m[side], c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', m.x); c.setAttribute('cy', m.y); c.setAttribute('r', f.hit);
      c.setAttribute('fill', '#000'); c.setAttribute('fill-opacity', '0');
      c.setAttribute('data-hit', side);
      c.style.cursor = 'pointer'; c.style.touchAction = 'none';
      c.setAttribute('aria-label', side === 'left' ? 'Rewind (hold)' : 'Fast forward (hold)');
      c.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        try { c.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
        if (onWindStart) onWindStart(side === 'left' ? -1 : 1);
      });
      const up = (e) => { if (e) e.stopPropagation(); if (onWindEnd) onWindEnd(); };
      c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up); c.addEventListener('lostpointercapture', up);
      c.addEventListener('click', (e) => e.stopPropagation());   // a wind tap must not toggle the song list
      g.appendChild(c);
    }
    svg.appendChild(g);
  }

  const driver = {
    stats,
    /** Re-bind after every Cassette.mount draw (onRender hook). */
    bind(h, style) {
      if (!h || !h.svg) return driver;
      f = famFor(style);
      const svg = h.svg;
      els = {};
      for (const s of ['left', 'right']) {
        const g = h.reels && h.reels[s];
        els[s] = g && { pack: g.querySelector('[data-pack]'), edge: g.querySelector('[data-edge]'), spin: g.querySelector('[data-spin]') };
      }
      els.tape = svg.querySelector('[data-tape]');
      els.rl = svg.querySelector('[data-roller="L"]');
      els.rr = svg.querySelector('[data-roller="R"]');
      els.mark = svg.querySelector('[data-marker]');
      rotL = rotator(els.left && els.left.spin);
      rotR = rotator(els.right && els.right.spin);
      rotRo = [rotator(els.rl), rotator(els.rr)];
      drawnP = -1;
      if (typeof document !== 'undefined' && !(h.cfg && h.cfg.noHits)) addHits(svg);
      return driver;
    },

    /**
     * One animation frame. p = whole-tape progress (real), mul = playback speed
     * multiple (1 play, 0 stopped, <0 reverse, ~24 wind), dt seconds.
     */
    frame(p, mul, dt) {
      if (!els || !f) return;
      if (drawnP < 0 || Math.abs(p - drawnP) > EPS_P) writePacks(p);
      if (mul !== 0) {
        angL += hubStep(f, 'left', p, mul, dt);
        angR += hubStep(f, 'right', p, mul, dt);
        angRo += rollerStep(f, mul, dt);
        if (rotL) rotL(angL);
        if (rotR) rotR(angR);
        if (rotRo[0]) rotRo[0](angRo);
        if (rotRo[1]) rotRo[1](angRo);
        stats.spinWrites++;
      }
    },

    /** Snap the packs to p without spinning (insert / seek / static previews). */
    set(p) { if (els && f) writePacks(p); },
    get family() { return f; },
    destroy() { els = null; f = null; rotL = rotR = rotRo = null; },
  };
  return driver;
}
