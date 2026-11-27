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
import { paintLabel } from './label-art.js';
import { allowsGesture } from '../devicemode/guard.js';
import { createSeekBar } from '../ui/seekbar.js';   // device mode: frozen gestures while locked (docs/DEVICE_MODE.md)

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
  top.setAttribute('data-lock-surface', ''); top.setAttribute('role', 'group'); top.setAttribute('aria-label', 'Turntable'); top.innerHTML = topSvgInner();
  const libEl = mk('div', 'tt-lib');
  const sr = mk('button', 'tt-sr'); sr.type = 'button'; sr.textContent = 'Open album library';
  // the readable layer: what is playing, and the empty-state card (DOM text, never the SVG: it truncates with CSS and reads with a screen reader)
  const hud = mk('div', 'tt-hud');
  const nowEl = mk('div', 'tt-now', false); nowEl.setAttribute('role', 'group'); nowEl.setAttribute('aria-label', 'Now playing'); nowEl.hidden = true;
  const nowTitle = mk('span', 'tt-now-title', false), nowTime = mk('span', 'tt-now-time', false), nowSub = mk('div', 'tt-now-sub', false);
  // the seek bar (UX review: seek was only the 38 px tonearm dimple): a thin visible bar under the now-playing text, tap or drag; the tonearm gesture stays
  const seek = createSeekBar({ label: 'Seek in this track', onSeek: (f) => { if (allowsGesture('tonearm-drag') && hooks.seekFrac) hooks.seekFrac(f); }, doc: document });
  seek.el.classList.add('tt-seek'); seek.el.setAttribute('data-lock-surface', '');
  nowEl.append(nowTitle, nowSub, nowTime, seek.el);
  const emptyEl = mk('div', 'tt-empty', false); emptyEl.hidden = true;
  const emptyT = mk('div', 'tt-empty-title', false), emptyB = mk('div', 'tt-empty-body', false), emptyBtn = mk('button', 'tt-empty-btn', false); emptyBtn.type = 'button';
  emptyEl.append(emptyT, emptyB, emptyBtn);
  hud.append(nowEl, emptyEl);
  host.append(bot, libBg, cv, top, hud, libEl, sr);

  const $ = (id) => host.querySelector('#tt-' + id);
  const botRot = $('botRot'), topRot = $('topRot'), matG = $('matG'), phoneFrame = $('phoneFrame');
  const armG = $('arm'), grabG = $('grab'), playBtn = $('playBtn'), playIcon = $('playIcon'), dispHit = $('dispHit');
  const ctl = { b78: $('b78'), b33: $('b33'), b45: $('b45'), bm: $('bm'), bp: $('bp'), prev: $('prev'), next: $('next') };
  const playFace = $('playFace'), playLbl = $('playLbl');
  const ctx = cv.getContext('2d');
  const painter = new DiscPainter();

  // ── state ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  let P = createPlayer();
  const view = { posS: 0, dust: 0, name: '', trackCount: 1, trackIndex: 0, loading: false, lit: false, dispMode: 0, ana: null, level: 0 };
  let visible = false, W = 0, H = 0, DPR = 1, portrait = false, MX = [1, 0, 0, 1, 0, 0], dirty = true, preview = null, scrollT = 0;
  let ghost = null, drop = null, lib = null, lastLive = null, lastZ = -1, outline = false, libOpen = false, outlineAt = 0, outlineSig = '', pendingLabel, stats = { draws: 0, places: 0 };
  const anaBuf = new Uint8Array(32);
  let labelCv = null, labelTok = 0;

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
    const L = layers(P.z), cam = camFor(portrait, W, H, L.k, reserveBottom()), vb = viewBoxFor(cam, W, H);
    bot.setAttribute('viewBox', vb); top.setAttribute('viewBox', vb);
    MX = cam.M;
    host.style.background = `rgb(${L.bg[0]},${L.bg[1]},${L.bg[2]})`;
    matG.style.opacity = L.matOpacity.toFixed(3);
    topRot.style.opacity = L.controlsOpacity.toFixed(3);
    top.style.pointerEvents = L.topPointerEvents;
    hud.style.opacity = L.controlsOpacity.toFixed(3); hud.dataset.live = L.topPointerEvents ? '' : '1';
    const open = P.z > 0.5; if (open !== libOpen) { libOpen = open; if (hooks.libraryOpen) hooks.libraryOpen(open); }
    phoneFrame.setAttribute('opacity', L.frameOpacity.toFixed(3));
    libBg.style.opacity = L.libBgOpacity.toFixed(3);
    if (lib && lib.setOpacity) lib.setOpacity(L.libOpacity); else libEl.style.opacity = L.libOpacity.toFixed(3);
    libEl.style.pointerEvents = L.libInteractive ? 'auto' : 'none';
    libEl.setAttribute('aria-hidden', String(L.libOpacity < 0.5));
    sr.hidden = false;
    placeHud();
    lastZ = P.z; dirty = true;
  }
  // Controls: every button is a visible shape (bg) inside a larger transparent hit area, >= 48 css px wherever the layout allows it. The hit rect is sized from the
  // camera scale so it is 48 px on a phone, capped at the pitch between neighbouring keys (80 stage units across the rows in landscape; in portrait the columns are
  // spread to 86 so they can reach 48 px at 360 x 780) so two keys never share a touch. Play is the big one and says Play / Stop.
  const COL_PITCH_PORT = 86, COL_PITCH = 80;             // stage units between key columns (portrait) / key rows (landscape)
  const MIN_HIT = 48;
  const CTL_DIM = { land: { s: [104, 80, 92, 62], p: [124, 80, 116, 68] }, port: { s: [COL_PITCH_PORT, 104, 64, 92], p: [COL_PITCH_PORT, 116, 72, 108] } };
  const PLAY_X = 1329;
  // the strip under the stage that the seek bar needs (the stage is fitted above it): css px
  const RESERVE = { port: 8, land: 4 };
  const reserveBottom = () => (portrait ? RESERVE.port : RESERVE.land);
  // SVG text cannot wrap: when the user's text size is larger (CSS px scale with the WebView's text zoom) shrink the label until it fits its key
  function fitKeyText(t, keyW) {
    if (!t) return;
    t.style.fontSize = '';
    let w = 0; try { w = t.getBBox().width; } catch { return; }
    const max = keyW * 0.86;
    if (w > max && w > 0) t.style.fontSize = (parseFloat(getComputedStyle(t).fontSize) * max / w).toFixed(1) + 'px';
  }
  const colY = (y) => (portrait ? 378 + (y - 378) * (COL_PITCH_PORT / COL_PITCH) : y);   // portrait: the key columns are spread
  function layoutControls() {
    const D = portrait ? CTL_DIM.port : CTL_DIM.land;
    const s0 = portrait ? Math.min(W / 561, (H - reserveBottom()) / 1241) : Math.min(W / 1241, (H - reserveBottom()) / 561);
    const cap = portrait ? COL_PITCH_PORT : COL_PITCH, grow = (n) => (s0 > 0 ? Math.min(cap, Math.max(n, Math.ceil(MIN_HIT / s0))) : n);   // never wider than the pitch
    for (const [id, b] of Object.entries(BTN)) {
      const el = id === 'play' ? playBtn : ctl[id];
      if (!el) continue;
      const cx = id === 'play' ? PLAY_X : b.x, cy = colY(b.y), d = id === 'play' ? D.p : D.s;
      const hit = el.querySelector('.hit-area'), bg = el.querySelector('.bg');
      const set = (r, w, h, rx) => { r.setAttribute('x', cx - w / 2); r.setAttribute('y', cy - h / 2); r.setAttribute('width', w); r.setAttribute('height', h); if (rx != null) r.setAttribute('rx', rx); };
      // the pitch-limited dimension is the one across the columns (portrait: width) / rows (landscape: height)
      set(hit, portrait ? grow(d[0]) : d[0], portrait ? d[1] : grow(d[1]));
      set(bg, d[2], d[3], Math.round(Math.min(d[2], d[3]) * (id === 'play' ? 0.3 : 0.26)));
      const tx = el.querySelector('text:not(.lbl)'); if (tx) { tx.setAttribute('x', cx); tx.setAttribute('y', cy + 11); }
      const ico = el.querySelector('.ico'); if (ico) ico.setAttribute('transform', `translate(${cx} ${cy})`);
      if (portrait) el.setAttribute('transform', `rotate(-90 ${cx} ${cy})`); else el.removeAttribute('transform');
      fitKeyText(el.querySelector('text:not(.lbl)'), d[2]);
    }
    fitKeyText(playLbl, D.p[2]);
    playFace.setAttribute('transform', `translate(${PLAY_X} ${colY(BTN.play.y)})`);
    playIcon.setAttribute('transform', `translate(0 ${portrait ? -22 : -13})`);
    playLbl.setAttribute('y', portrait ? 30 : 22);
  }
  // the now-playing band: a stage-space rectangle mapped through the camera, so it follows the rotation / letterboxing and never meets the disc or arm
  const HUD_BAND = { port: [1386, 127, 1463, 536], land: [950, 490, 1452, 542] };
  function mapRect(M, x0, y0, x1, y1) {
    const px = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]]);
    const xs = px.map((q) => q[0]), ys = px.map((q) => q[1]);
    return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
  }
  function placeHud() {
    if (!W) return;
    const r = mapRect(MX, ...(portrait ? HUD_BAND.port : HUD_BAND.land));
    const w = Math.max(0, r.right - r.left), h = Math.max(0, r.bottom - r.top) + reserveBottom();   // the band runs down into the strip the camera keeps free for the seek bar
    const st = nowEl.style;
    // anchored by its BOTTOM edge with a minimum height: at a larger text size the band grows upward instead of laying the seek bar over the artist line
    st.left = r.left.toFixed(1) + 'px'; st.width = w.toFixed(1) + 'px'; st.top = 'auto'; st.height = 'auto'; st.minHeight = h.toFixed(1) + 'px'; st.bottom = Math.max(0, H - (r.top + h)).toFixed(1) + 'px';
    nowEl.dataset.tight = h < 46 ? '1' : '';
  }
  function resize() {
    // layout size, not the transformed box: the shell card is scaled while the drawer opens / closes, and a measurement taken then left the
    // stage (and the now-playing band) laid out for the shrunken card after it settled back
    const r = { width: host.clientWidth, height: host.clientHeight };
    visible = r.width >= 2 && r.height >= 2;
    if (!visible) return;                                   // hidden section: keep the last geometry (the player keeps ticking, nothing is drawn)
    DPR = Math.min(2.5, window.devicePixelRatio || 1);
    W = r.width; H = r.height;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    portrait = H > W;
    const tr = portrait ? PORTRAIT_TRANSFORM : '';
    if (tr) { botRot.setAttribute('transform', tr); topRot.setAttribute('transform', tr); } else { botRot.removeAttribute('transform'); topRot.removeAttribute('transform'); }
    layoutControls();
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
  press(ctl.prev, () => { if (ctl.prev.getAttribute('aria-disabled') !== 'true' && hooks.prev) hooks.prev(); });
  press(ctl.next, () => { if (ctl.next.getAttribute('aria-disabled') !== 'true' && hooks.next) hooks.next(); });
  press(dispHit, () => { view.dispMode = 1 - view.dispMode; painter.eqHold.fill(0); if (view.dispMode && hooks.analyser && !view.ana) view.ana = hooks.analyser(); dirty = true; });
  press(sr, () => { dispatch({ type: 'zoomTo', z: 1 }); kick(); });
  emptyBtn.addEventListener('click', (e) => { e.stopPropagation(); if (allowsGesture('library-chip') && hooks.emptyAction) hooks.emptyAction(); });
  // a press that starts on a control never starts a scratch
  const isCtl = (t) => !!(t.closest && t.closest('.ctl, #tt-playBtn, #tt-dispHit, #tt-grab'));

  // ── the tonearm dimple: the drag handle ───────────────────────────────────────────────────────────────────────────────
  let arm = null;   // { id, grabDX, trail:[] }
  grabG.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || (hooks.canGrab && !hooks.canGrab()) || !allowsGesture('tonearm-drag')) return;
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
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' || (hooks.canGrab && !hooks.canGrab()) || !allowsGesture('tonearm-drag')) return;
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
    if (!allowsGesture(mode === 'brake' ? 'platter-brake' : 'platter-scrub')) return;   // locked: the record is a frozen face
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
    if (!allowsGesture('pinch-zoom')) return;
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
    if (!allowsGesture('pinch-zoom')) return;
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
  let playOvr = null;   // null, or true/false: the Play/Stop key shows (and the host acts on) another engine owner (a tape / station), never the idle platter
  function setLiveUI(on) {
    if (playOvr !== null) on = playOvr;
    if (on === lastLive) return; lastLive = on;
    playBtn.classList.toggle('live', on);
    if (hooks.liveChange) hooks.liveChange(on);
    playIcon.setAttribute('d', on ? 'M-8 -8 H8 V8 H-8 Z' : 'M-7 -9 L10 0 L-7 9 Z');
    playBtn.setAttribute('aria-label', on ? 'Stop' : 'Play'); playLbl.textContent = on ? 'Stop' : 'Play';
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
    dirty = false; stats.draws++;
    const L = layers(P.z), now = performance.now();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
    if (outline) { drawOutline(L); return; }
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
        name: view.loading ? 'LOADING...' : view.name, msg: view.msg, trackCount: view.trackCount, trackIndex: view.trackIndex, now: scrollT * 1000, vals,
      });
      ctx.globalAlpha = 1;
    }
    const place = P.z > 0.002 ? discPlacement(P.z, MX, slotRect(), C, RDISC) : null;
    setM(place ? place.M : MX);
    painter.drawDisc(ctx, s, 1, view.dust);
    if (!place && (ghost || drop)) { setM(MX); painter.drawGhost(ctx, ghost, drop, portrait); }
  }

  // Always-on display (device mode): hairline circles only (platter, disc, label, spindle), the dot display dimmed and static. No spiral, no
  // mat / cover art / label image; the arm and the slot are the SVG layer's hairlines (devicemode.css). Redrawn only when something changed.
  function drawOutline(L) {
    setM(MX);
    ctx.lineWidth = 1.25 / Math.max(0.2, Math.sqrt(Math.abs(MX[0] * MX[3] - MX[1] * MX[2])));
    ctx.strokeStyle = 'rgba(190,190,205,.75)'; ctx.fillStyle = 'rgba(0,0,0,0)';
    for (const r of [RDISC + 2, RDISC, BRAKE_R, 9]) { ctx.beginPath(); ctx.arc(C.x, C.y, r, 0, Math.PI * 2); ctx.stroke(); }
    if (L.showDisplay) {
      ctx.globalAlpha = 0.3;
      painter.drawDisplay(ctx, { portrait, active: view.lit, mode: 0, name: view.loading ? 'LOADING...' : view.name, trackCount: view.trackCount, trackIndex: view.trackIndex, now: 0, vals: null });
      ctx.globalAlpha = 1;
    }
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
    if (outline) {   // AOD: static. Redraw on a real change (state flags, an explicit kick) at once; while playing, the arm creeps: at most once per 10 s.
      const sig = `${P.playing}|${P.starting}|${P.dragging}|${P.z}|${P.speed}|${view.loading}|${view.name}|${view.trackIndex}`, t = performance.now();
      if (dirty || sig !== outlineSig || (P.playing && t - outlineAt >= 10000)) { outlineSig = sig; outlineAt = t; stats.places++; placeArm(); setLiveUI(P.playing || P.starting); if (visible && W) draw(); }
      return;
    }
    if (needsFrame(P) || dirty || was !== P || drop || view.loading) { placeArm(); setLiveUI(P.playing || P.starting); if (visible && W) draw(); }
  }
  function kick() { dirty = true; if (hooks.wake) hooks.wake(); }
  libEl.addEventListener('scroll', () => kick(), true);   // the coverflow scrolled: the ghost record follows its cover slot (a stale canvas left it drawn across the title and tracks)

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
    /** The readable now-playing line: { title, sub, show }. All strings are untrusted and go through textContent. */
    setNow(o = {}) {
      const show = o.show !== false && !!(o.title || o.sub);
      if (nowEl.hidden === show) nowEl.hidden = !show;
      if (nowTitle.textContent !== (o.title || '')) nowTitle.textContent = o.title || '';
      if (nowSub.textContent !== (o.sub || '')) nowSub.textContent = o.sub || '';
      nowEl.dataset.mode = o.mode || '';
      placeHud();
    },
    /** elapsed / total of what is playing, "0:42 / 3:21"; '' hides it */
    /** a tape / station owns the engine: true = it is playing (key says Stop), false = paused (Play), null = the platter's own state */
    setPlayOverride(v) { const n = v == null ? null : !!v; if (n === playOvr) return; playOvr = n; lastLive = null; setLiveUI(!!(P.playing || P.starting)); },
    setNowTime(text) { if (nowTime.textContent !== text) nowTime.textContent = text; },
    /** the seek bar under the now-playing text: paint the playhead (seconds) or hide / dim it (a tape, a station or nothing loaded owns the engine) */
    setSeek(o = {}) {
      if (o.enabled !== undefined) { seek.setEnabled(!!o.enabled); nowEl.dataset.seek = o.enabled ? '1' : '0'; }
      if (o.t !== undefined) seek.set(o.t, o.T);
    },
    /** the stage's Previous / Next keys: false dims and disarms one (nothing to step to) */
    setTransport(o = {}) {
      for (const k of ['prev', 'next']) if (o[k] !== undefined) { ctl[k].setAttribute('aria-disabled', String(!o[k])); }
    },
    /** the empty-state card: { show, title, body, button } (button = label of the one action, '' for none) */
    setEmpty(o = {}) {
      const show = !!o.show;
      emptyEl.hidden = !show;
      emptyT.textContent = o.title || ''; emptyB.textContent = o.body || '';
      emptyBtn.textContent = o.button || ''; emptyBtn.hidden = !o.button;
    },
    /** the record label: the album's own art / a generated label, or the default swirl for null / the demo record */
    setLabelArt(album) {
      if (outline) { pendingLabel = album || null; return; }   // AOD: no 868 px canvas, no cover decode; applied when the outline mode ends
      const tok = ++labelTok;
      if (!album || album.builtin) { painter.labelArt = null; dirty = true; kick(); return; }
      if (!labelCv) { labelCv = document.createElement('canvas'); labelCv.width = labelCv.height = 868; }
      painter.labelArt = paintLabel(labelCv, { album });
      dirty = true; kick();
      if (album.coverUrl) {
        const im = new Image();
        im.onload = () => { if (tok !== labelTok) return; painter.labelArt = paintLabel(labelCv, { album, image: im }); dirty = true; kick(); };
        im.onerror = () => { /* unreadable art: the generated label stays */ };
        im.src = album.coverUrl;
      }
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
    /** device mode AOD: outline-only draw (see drawOutline); the CSS shows the canvas + hairline SVG while body[data-aod-outline] */
    setOutline(on) { on = !!on; if (on === outline) return; outline = on; outlineSig = ''; if (!on && pendingLabel !== undefined) { const a = pendingLabel; pendingLabel = undefined; api.setLabelArt(a); } cv.dataset.outline = on ? '1' : ''; dirty = true; ghost = null; drop = null; if (visible) { placeArm(); draw(); } kick(); },
    get outline() { return outline; },
    get stats() { return stats; },
    /** true while the disc wears the album's own label (test hook) */
    get hasLabelArt() { return !!painter.labelArt; },
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
    setScroll(ms) { scrollT = ms / 1000; dirty = true; },
    geom: { C, RDISC },
  };
  resize();
  placeArm();
  return api;
}
