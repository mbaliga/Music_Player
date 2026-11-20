// stage.js — the Albums page's vinyl player: DOM + canvas + SVG wiring around the pure modules (geometry / camera / arm / spiral /
// display / state). It owns NO audio. The app (main.js) feeds it the playhead every frame and acts on its hooks.
//
// Layer stack inside the host (bottom -> top), exactly the prototype's:
//   svg.tt-bot (phone body, phone frame, platter + mat)  ->  .tt-libbg  ->  canvas.tt-disc (disc, spiral, label, display)
//   ->  svg.tt-top (slot, controls, arm, dimple, hit areas)  ->  .tt-lib (the zoom-out library, mounted by main.js)
// Drawing is demand-driven: update() redraws only while something moves (needsFrame) or after a change marks the stage dirty.
import { C, RDISC, BTN, PORTRAIT_TRANSFORM, DISP, SLOT } from './geometry.js';
import { camFor, rectOf, viewBoxFor, layers, discPlacement, easeZ, pinchZ, pinchSettle, wheelZ, wheelSettle, ZOOM } from './camera.js';
import { armPose, armTransform, dimpleTransform, sFromPointer, grabOffset } from './arm.js';
import { createPlayer, reduce, playheadS, needsFrame, ARM_Z } from './state.js';
import { DiscPainter } from './disc-draw.js';
import { botSvgInner, topSvgInner, LABEL_SVG } from './stage-svg.js';
import { fillSilence, fillPlaceholder, computePeaks, binRange } from './spiral.js';
import { eqFromBytes, eqFake, EQ_BARS } from './display.js';
import { classifyArmFlick } from '../tonearm.js';

const NS = 'http://www.w3.org/2000/svg';
const BRAKE_R = 217;   // inside the label = palm brake (hold)

export function createStage(host, hooks = {}) {
  const reducedFn = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  host.classList.add('tt-wrap');
  host.innerHTML = '';
  const mk = (tag, cls, ns) => { const e = ns ? document.createElementNS(NS, tag) : document.createElement(tag); if (cls) e.setAttribute('class', cls); return e; };

  const bot = mk('svg', 'tt-layer tt-bot', true); bot.setAttribute('preserveAspectRatio', 'xMidYMid meet'); bot.setAttribute('viewBox', '222.5 -15 1241 561'); bot.innerHTML = botSvgInner();
  const libBg = mk('div', 'tt-libbg');
  const cv = mk('canvas', 'tt-layer tt-disc'); cv.id = 'disc'; cv.setAttribute('aria-hidden', 'true');
  const top = mk('svg', 'tt-layer tt-top', true); top.setAttribute('preserveAspectRatio', 'xMidYMid meet'); top.setAttribute('viewBox', '222.5 -15 1241 561');
  top.setAttribute('role', 'group'); top.setAttribute('aria-label', 'Turntable'); top.innerHTML = topSvgInner();
  const libEl = mk('div', 'tt-lib');
  const sr = mk('button', 'tt-sr'); sr.type = 'button'; sr.textContent = 'Open album library';
  host.append(bot, libBg, cv, top, libEl, sr);

  const $ = (id) => host.querySelector('#tt-' + id);
  const botRot = $('botRot'), topRot = $('topRot'), matG = $('matG'), phoneFrame = $('phoneFrame');
  const armG = $('arm'), grabG = $('grab'), playBtn = $('playBtn'), playIcon = $('playIcon'), dispHit = $('dispHit');
  const ctl = { b78: $('b78'), b33: $('b33'), b45: $('b45'), bm: $('bm'), bp: $('bp') };
  const ctx = cv.getContext('2d');
  const painter = new DiscPainter();

  // ── state ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  let P = createPlayer();
  const view = { posS: 0, dust: 0, name: '', trackCount: 1, trackIndex: 0, loading: false, lit: false, dispMode: 0, ana: null, level: 0 };
  let visible = false, W = 0, H = 0, DPR = 1, portrait = false, MX = [1, 0, 0, 1, 0, 0], dirty = true, preview = null, scrollT = 0;
  let ghost = null, drop = null, lib = null, lastLive = null, lastZ = -1;
  const anaBuf = new Uint8Array(32);

  const dispatch = (a) => {
    const r = reduce(P, a); P = r.state;
    for (const e of r.effects) {
      if (e === 'beginAudio') { P = reduce(P, { type: 'audioBegan' }).state; if (hooks.beginAudio) hooks.beginAudio(); }
      else if (hooks.effect) hooks.effect(e);
    }
    return r;
  };

  // ── camera ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  function applyCam() {
    if (!W) return;
    const L = layers(P.z), cam = camFor(portrait, W, H, L.k), vb = viewBoxFor(cam, W, H);
    bot.setAttribute('viewBox', vb); top.setAttribute('viewBox', vb);
    MX = cam.M;
    host.style.background = `rgb(${L.bg[0]},${L.bg[1]},${L.bg[2]})`;
    matG.style.opacity = L.matOpacity.toFixed(3);
    topRot.style.opacity = L.controlsOpacity.toFixed(3);
    top.style.pointerEvents = L.topPointerEvents;
    phoneFrame.setAttribute('opacity', L.frameOpacity.toFixed(3));
    libBg.style.opacity = L.libBgOpacity.toFixed(3);
    if (lib && lib.setOpacity) lib.setOpacity(L.libOpacity); else libEl.style.opacity = L.libOpacity.toFixed(3);
    libEl.style.pointerEvents = L.libInteractive ? 'auto' : 'none';
    libEl.setAttribute('aria-hidden', String(L.libOpacity < 0.5));
    sr.hidden = false;
    lastZ = P.z; dirty = true;
  }
  function resize() {
    const r = host.getBoundingClientRect();
    visible = r.width >= 2 && r.height >= 2;
    if (!visible) return;                                   // hidden section: keep the last geometry (the player keeps ticking, nothing is drawn)
    DPR = Math.min(2.5, window.devicePixelRatio || 1);
    W = r.width; H = r.height;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    portrait = H > W;
    const tr = portrait ? PORTRAIT_TRANSFORM : '';
    if (tr) { botRot.setAttribute('transform', tr); topRot.setAttribute('transform', tr); } else { botRot.removeAttribute('transform'); topRot.removeAttribute('transform'); }
    for (const [id, b] of Object.entries(BTN)) {
      const el = id === 'play' ? playBtn : ctl[id];
      if (!el) continue;
      if (portrait) el.setAttribute('transform', `rotate(-90 ${b.x} ${b.y})`); else el.removeAttribute('transform');
    }
    if (lib && lib.layout) lib.layout({ width: W, height: H, portrait });
    applyCam();
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(host);
  window.addEventListener('resize', resize);

  // label artwork, rasterised once
  const labelImg = new Image();
  labelImg.onload = () => { painter.label = labelImg; dirty = true; };
  labelImg.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(LABEL_SVG.trim());

  // ── stage point (client px -> stage units), through the SVG's own matrix so rotation is handled ─────────────────────────
  const pt = top.createSVGPoint();
  function stagePt(e) {
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(topRot.getScreenCTM().inverse());
  }

  // ── controls ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  const press = (el, fn) => {
    el.addEventListener('click', (e) => { e.stopPropagation(); fn(e); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); fn(e); } });
  };
  press(playBtn, () => hooks.toggle && hooks.toggle());
  press(ctl.b78, () => hooks.speed && hooks.speed('78'));
  press(ctl.b33, () => hooks.speed && hooks.speed('33'));
  press(ctl.b45, () => hooks.speed && hooks.speed('45'));
  press(ctl.bm, () => hooks.nudge && hooks.nudge(-1));
  press(ctl.bp, () => hooks.nudge && hooks.nudge(1));
  press(dispHit, () => { view.dispMode = 1 - view.dispMode; painter.eqHold.fill(0); if (view.dispMode && hooks.analyser && !view.ana) view.ana = hooks.analyser(); dirty = true; });
  press(sr, () => { dispatch({ type: 'zoomTo', z: 1 }); kick(); });
  // a press that starts on a control never starts a scratch
  const isCtl = (t) => !!(t.closest && t.closest('.ctl, #tt-playBtn, #tt-dispHit, #tt-grab'));

  // ── the tonearm dimple: the drag handle ───────────────────────────────────────────────────────────────────────────────
  let arm = null;   // { id, grabDX, trail:[] }
  grabG.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || (hooks.canGrab && !hooks.canGrab())) return;
    e.preventDefault(); e.stopPropagation();
    const before = P.dragging;
    dispatch({ type: 'dragStart', s: view.posS });
    if (!P.dragging || before) return;
    const p = stagePt(e);
    arm = { id: e.pointerId, grabDX: grabOffset(P.armS, p.x), trail: [{ x: p.x, y: p.y, t: performance.now() }] };
    grabG.classList.add('drag');
    try { grabG.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    if (hooks.armGrab) hooks.armGrab(P.armS);
    kick();
  });
  grabG.addEventListener('pointermove', (e) => {
    if (!arm || e.pointerId !== arm.id) return;
    const p = stagePt(e), s = sFromPointer(p.x, arm.grabDX);
    arm.trail.push({ x: p.x, y: p.y, t: performance.now() }); if (arm.trail.length > 48) arm.trail.shift();
    dispatch({ type: 'dragMove', s });
    if (hooks.armMove) hooks.armMove(s);
    dirty = true; kick();
  });
  const endArm = (e) => {
    if (!arm || (e && e.pointerId !== arm.id)) return;
    const a = arm; arm = null; grabG.classList.remove('drag');
    const s = P.armS, flick = classifyArmFlick(a.trail);
    dispatch({ type: 'dragEnd', s });
    if (hooks.armRelease) hooks.armRelease(s, flick.dir, a.trail);
    kick();
  };
  grabG.addEventListener('pointerup', endArm); grabG.addEventListener('pointercancel', endArm);
  grabG.addEventListener('keydown', (e) => {   // keyboard: left/right nudge the playhead a little (inner groove = left)
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' || (hooks.canGrab && !hooks.canGrab())) return;
    e.preventDefault();
    if (hooks.armNudge) hooks.armNudge(e.key === 'ArrowLeft' ? 1 : -1);
  });

  // ── the platter: scratch on the groove annulus, palm brake on the label ───────────────────────────────────────────────
  let scratch = null;   // { id, mode: 'scratch'|'brake', angle }
  top.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || scratch || arm || isCtl(e.target)) return;
    const p = stagePt(e), d = Math.hypot(p.x - C.x, p.y - C.y);
    if (d > RDISC) return;
    const mode = d <= BRAKE_R ? 'brake' : 'scratch';
    scratch = { id: e.pointerId, mode, angle: Math.atan2(p.y - C.y, p.x - C.x) };
    try { top.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    if (mode === 'brake') hooks.brake && hooks.brake(true);
    else hooks.scratchBegin && hooks.scratchBegin(scratch.angle);
    kick();
  });
  top.addEventListener('pointermove', (e) => {
    if (!scratch || e.pointerId !== scratch.id || scratch.mode !== 'scratch') return;
    const p = stagePt(e);
    scratch.angle = Math.atan2(p.y - C.y, p.x - C.x);
    if (hooks.scratchMove) hooks.scratchMove(scratch.angle);
  });
  const endScratch = (e) => {
    if (!scratch || (e && e.pointerId !== scratch.id)) return;
    const m = scratch.mode; scratch = null;
    if (m === 'brake') hooks.brake && hooks.brake(false); else hooks.scratchEnd && hooks.scratchEnd();
  };
  top.addEventListener('pointerup', endScratch); top.addEventListener('pointercancel', endScratch);

  // ── zoom: two-finger pinch (IN = zoom out), Ctrl+wheel ─────────────────────────────────────────────────────────────────
  const ptrs = new Map(); let pinch = null, wheelT = 0;
  const dist = () => { const a = [...ptrs.values()]; return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); };
  window.addEventListener('pointerdown', (e) => {
    if (!host.contains(e.target)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) {
      endArm(); endScratch();     // a second finger is the zoom gesture: let go of whatever the first was doing
      if (hooks.pinchStart) hooks.pinchStart();
      pinch = { d0: Math.max(30, dist()), z0: P.z };
      dispatch({ type: 'pinchStart' });
    }
  }, true);
  window.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && ptrs.size >= 2) {
      dispatch({ type: 'pinchMove', z: pinchZ(pinch.z0, dist() / pinch.d0) });
      applyCam(); kick();
    }
  }, true);
  const ptrEnd = (e) => {
    if (!ptrs.delete(e.pointerId)) return;
    if (pinch && ptrs.size < 2) {
      const settle = pinchSettle(P.z, pinch.z0); pinch = null;
      dispatch({ type: 'pinchEnd', settle }); kick();
      if (hooks.pinchEnd) hooks.pinchEnd(settle);
    }
  };
  window.addEventListener('pointerup', ptrEnd, true); window.addEventListener('pointercancel', ptrEnd, true);
  host.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    dispatch({ type: 'pinchStart' });
    dispatch({ type: 'pinchMove', z: wheelZ(P.z, e.deltaY) }); applyCam(); kick();
    clearTimeout(wheelT);
    wheelT = setTimeout(() => { dispatch({ type: 'pinchEnd', settle: wheelSettle(P.z) }); kick(); }, ZOOM.WHEEL_IDLE_MS);
  }, { passive: false });

  // ── frame ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  function placeArm() {
    const p = armPose(P.armS, P.dep);
    armG.setAttribute('transform', armTransform(p));
    grabG.setAttribute('transform', dimpleTransform(p));
  }
  function setLiveUI(on) {
    if (on === lastLive) return; lastLive = on;
    playBtn.classList.toggle('live', on);
    playIcon.setAttribute('d', on ? 'M-8 -8 H8 V8 H-8 Z' : 'M-7 -9 L10 0 L-7 9 Z');
    playBtn.setAttribute('aria-label', on ? 'Stop' : 'Play');
  }
  function slotRect() {
    const r = host.getBoundingClientRect(), s = lib && lib.getSlotRect && lib.getSlotRect();
    if (s && s.width > 0) return { left: s.left - r.left, top: s.top - r.top, width: s.width, height: s.height };
    const cs = portrait ? W * 0.62 : H * 0.44;
    return { left: W / 2 - cs / 2, top: H * 0.64 * 0 + cs * 0.64, width: cs, height: cs };
  }
  const setM = (m) => ctx.setTransform(m[0] * DPR, m[1] * DPR, m[2] * DPR, m[3] * DPR, m[4] * DPR, m[5] * DPR);
  function draw() {
    if (!W) return;
    dirty = false;
    const L = layers(P.z), now = performance.now();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
    const s = preview ? preview.s : playheadS(P, view.posS);
    if (L.showDisplay) {
      setM(MX); ctx.globalAlpha = L.displayAlpha;
      const eq = view.dispMode === 1;
      let vals = null;
      if (eq) {
        if (view.ana && P.playing) { view.ana.getByteFrequencyData(anaBuf); vals = eqFromBytes(anaBuf, painter.eqVals); }
        else vals = eqFake(view.level, scrollT, painter.eqVals);
      }
      painter.drawDisplay(ctx, {
        portrait, active: preview ? preview.lit : view.lit, mode: view.dispMode,
        name: view.loading ? 'LOADING...' : view.name, trackCount: view.trackCount, trackIndex: view.trackIndex, now: scrollT * 1000, vals,
      });
      ctx.globalAlpha = 1;
    }
    const place = P.z > 0.002 ? discPlacement(P.z, MX, slotRect(), C, RDISC) : null;
    setM(place ? place.M : MX);
    painter.drawDisc(ctx, s, 1, view.dust);
    if (!place && (ghost || drop)) { setM(MX); painter.drawGhost(ctx, ghost, drop, portrait); }
  }

  let lastNow = 0;
  /** called by the app every frame (cheap when idle). input = { posS, dt }. */
  function update(dt, input) {
    if (!W) resize();
    view.posS = input.posS; if (input.dust != null) view.dust = input.dust; if (input.level != null) view.level = input.level;
    if (preview) { if (dirty && visible) { placeArm(); draw(); } return; }
    const was = P;
    if (P.playing || P.starting || P.dragging || view.loading) scrollT += dt;
    const r = dispatch({ type: 'tick', dt, posS: input.posS, easeZ, reduced: reducedFn() });
    if (P.z !== lastZ) applyCam();
    if (drop) { drop.t = (performance.now() - drop.t0) / 340; if (drop.t >= 1) { drop = null; dirty = true; } }
    if (needsFrame(P) || dirty || was !== P || drop || view.loading) { placeArm(); setLiveUI(P.playing || P.starting); if (visible && W) draw(); }
  }
  function kick() { dirty = true; if (hooks.wake) hooks.wake(); }

  // ── API for the app ───────────────────────────────────────────────────────────────────────────────────────────────────
  const api = {
    host, libHost: libEl, el: { top, cv, grab: grabG, play: playBtn },
    get player() { return P; },
    get portrait() { return portrait; },
    get zoom() { return P.z; },
    get size() { return { W, H }; },
    dispatch(a) { const r = dispatch(a); kick(); return r; },
    update, draw, resize, kick,
    isGestureLive: () => !!(scratch || arm || pinch || ptrs.size > 1),
    scratchAngle: () => (scratch && scratch.mode === 'scratch' ? scratch.angle : null),
    isScratching: () => !!(scratch && scratch.mode === 'scratch'),
    setLibrary(l) {   // the component fades its own root, so the wrapper stays fully opaque
      lib = l; if (l && l.setOpacity) libEl.style.opacity = '1';
      if (l && W && l.layout) l.layout({ width: W, height: H, portrait });
      applyCam();
    },
    /** what the dot display shows */
    setDisplay(o) { Object.assign(view, o); dirty = true; },
    setSpeedUI(id) {
      for (const k of ['b78', 'b33', 'b45']) { const on = k === 'b' + id; ctl[k].classList.toggle('on', on); ctl[k].setAttribute('aria-pressed', String(on)); }
      dirty = true;
    },
    setGhost(g) { ghost = g; dirty = true; kick(); },
    setDrop(s) { drop = s == null ? null : { s, t: 0, t0: performance.now() }; kick(); },
    /**
     * Fill the spiral's peaks. layout = buildArmLayout(...) (bands in unit s), current = index of the decoded track, channels/frames its PCM.
     * Other bands get a quiet placeholder groove, gaps stay bare vinyl.
     */
    setRecord({ layout, current, channels, frames }) {
      const env = painter.env; fillSilence(env, 0, env.n - 1);
      const Lc = channels && channels[0], Rc = channels && channels[1];
      const mono = !Lc ? null : Rc ? (i) => (Lc[i] + Rc[i]) * 0.5 : (i) => Lc[i];
      const bands = layout ? layout.bands : [{ index: 0, uA: 0, uB: 1 }];
      for (const b of bands) {
        const [i0, i1] = binRange(b.uA, b.uB);
        if (b.index === current && mono) computePeaks(env, mono, frames, i0, i1);
        else fillPlaceholder(env, i0, i1, b.index + 1);
      }
      dirty = true;
    },
    /** like setRecord but from the app's RMS envelope (a gapless join: the PCM is the engine's): a mirrored one-sided shape */
    setRecordFromEnvelope(layout, current, envelope) {
      const env = painter.env; fillSilence(env, 0, env.n - 1);
      const bands = layout ? layout.bands : [{ index: 0, uA: 0, uB: 1 }];
      for (const b of bands) {
        const [i0, i1] = binRange(b.uA, b.uB);
        if (b.index === current && envelope && envelope.length) {
          for (let i = i0; i <= i1; i++) { const v = envelope[Math.min(envelope.length - 1, Math.floor((i - i0) / Math.max(1, i1 - i0) * envelope.length))]; env.hi[i] = v; env.lo[i] = -v; }
        } else fillPlaceholder(env, i0, i1, b.index + 1);
      }
      dirty = true;
    },
    layers: () => layers(P.z),
    slotRect,
    startScroll() { scrollT = 0; },
    destroy() { window.removeEventListener('resize', resize); host.innerHTML = ''; },
  };

  // ── test hooks (the prototype's window.__rt, same signatures) ────────────────────────────────────────────────────────
  api.rt = {
    show(s, on) { preview = on === false ? null : { s, lit: true }; P = { ...P, armS: s, frozenS: s, dep: 1 }; placeArm(); setLiveUI(false); dirty = true; draw(); },
    park() { preview = { s: 0, lit: false }; P = { ...P, armS: 0, dep: 0, playing: false, starting: false }; placeArm(); dirty = true; draw(); },
    pose(s, d, a) { preview = { s, lit: a > 0 }; P = { ...P, armS: s, frozenS: s, dep: d }; placeArm(); dirty = true; draw(); },
    setZ(v) { dispatch({ type: 'setZ', z: v }); applyCam(); placeArm(); draw(); },
    focus(i) { dispatch({ type: 'focusSet', index: i }); if (lib && lib.focus) lib.focus(i, { animate: false }); draw(); },
    live() { preview = null; dirty = true; kick(); },
    tip: (s) => armPose(s, 1),
    setName(n) { view.name = n; dirty = true; },
    geom: { C, RDISC },
  };
  resize();
  placeArm();
  return api;
}
