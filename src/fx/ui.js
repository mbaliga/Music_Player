// ─────────────────────────────────────────────────────────────────────────────
// ui.js — the FX section UI (lazy-loaded the first time the section is opened; never imported at app boot).
//   mountFxSection(container, deps) -> { unmount, onShow, onHide, onTrack, platter, controller }
// SELF-CONTAINED: it lays out in whatever container / size it is given (360 x 780 full height included), makes no assumption about
// where it sits, and prefixes all its CSS with .fx-. It runs its own animation loop while shown.
//   deps = { engine: {ctx, musicBus, setFx(p)}, host: { getTrack, envelope, durationSec, positionSec, nominalRate, omegaNominal,
//            sampleRate, blocked, view, geom }, resume(): Promise, stage?: Element (platter stage for the light ring + HUD; optional),
//            close?: () => void (shows a "Back" row when given) }
//   platter = { wantsPlatter, grabsPlatter, pointerDown(p, surface, t), pointerMove(p, t), pointerUp(), rateFor(rate) }: what a shell
//   wires to its platter's pointer events and rate (optional: the pad inside the section works without it).
// All decisions are in controller.js / modes.js; this file builds DOM, draws the waveform / pad / light ring and forwards events.
// ─────────────────────────────────────────────────────────────────────────────

import { FxController } from './controller.js';
import { FxBus } from './bus.js';
import { MODES, modeInfo, needsTempo, isPadMode, holdsPlatter } from './modes.js';
import { DIVISIONS, sliceFraction, beatLabel } from './divisions.js';
import { waveColumns, playheadFrac, sliceSpan } from './waveform.js';
import { drawRing, ringSignature } from './ring-draw.js';
import { formatPercent } from './gesture.js';
import { computeEnvelope } from '../model.js';

const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};

const CSS_ID = 'fx-css';
function loadCss() {
  if (document.getElementById(CSS_ID)) return;
  const l = document.createElement('link'); l.id = CSS_ID; l.rel = 'stylesheet'; l.href = new URL('./fx.css', import.meta.url).href;
  document.head.append(l);
}

const BLOCK_TEXT = {
  radio: 'a radio station is playing. Stop it in Radio to use FX.',
  mixtape: 'a mixtape is playing. Close the tape to use FX.',
};
const envCache = new WeakMap();

/** Fill in whatever the shell's deps leave out, from the engine itself (the shell passes only engine / storage / blocked / a few host accessors). */
function adaptDeps(d) {
  const e = d.engine, h = d.host || {};
  const sr = () => (h.sampleRate ? h.sampleRate() : e.sampleRate);
  const blocked = () => { const b = h.blocked ? h.blocked() : d.blocked ? d.blocked() : null; return b ? (BLOCK_TEXT[b] || String(b)) : null; };
  return {
    engine: e, stage: d.stage || null, close: d.close || null, storage: d.storage, hasPlatter: !!d.hasPlatter,
    resume: d.resume || (() => e.resume()),
    host: {
      getTrack: () => { const t = h.getTrack ? h.getTrack() : null; return t && t.channels ? t : null; },
      envelope: h.envelope || (() => {
        const t = h.getTrack ? h.getTrack() : null;
        if (!t || !t.channels) return null;
        if (!envCache.has(t)) { const [L, R] = t.channels; envCache.set(t, computeEnvelope((i) => (R ? (L[i] + R[i]) * 0.5 : L[i]), t.frames, 1024)); }
        return envCache.get(t);
      }),
      durationSec: h.durationSec || (() => (e.frames > 0 ? e.frames / e.sampleRate : 0)),
      positionSec: h.positionSec || (() => e.position / e.sampleRate),
      nominalRate: h.nominalRate || (() => 1),
      omegaNominal: h.omegaNominal || (() => (2 * Math.PI * (100 / 3)) / 60),
      sampleRate: sr, blocked, view: h.view || (() => 'vinyl'), geom: h.geom || (() => null),
    },
  };
}

export function mountFxSection(root, deps) {
  const api = adaptDeps(deps);
  loadCss();
  root.classList.add('fx-root');
  const reducedQ = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const bus = new FxBus(api.engine);
  const ctl = new FxController({ engine: api.engine, bus, host: api.host, storage: api.storage !== undefined ? api.storage : (() => { try { return localStorage; } catch { return null; } })(), reducedMotion: () => reducedQ.matches });
  const cleanup = [];
  const on = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); cleanup.push(() => t.removeEventListener(ev, fn, o)); };

  let view = 'menu';                 // 'menu' | 'perform' | 'settings'
  const msg = h('div', { class: 'fx-msg hidden', role: 'status', 'aria-live': 'polite' });
  const screen = h('div', { class: 'fx-screen' });
  root.replaceChildren(msg, screen);

  // ── stage overlay: light ring + HUD ─────────────────────────────────────────────────────────────────────────────
  const stage = api.stage;
  const ringCv = h('canvas', { class: 'fx-stage-ring', 'aria-hidden': 'true', style: 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none' });
  const hudM = h('span', { class: 'm' }), hudD = h('span', { class: 'd' }), hudP = h('span', { class: 'p' });
  const hud = h('div', { class: 'fx-hud hidden', 'aria-hidden': 'true', style: 'position:absolute;left:0;right:0;top:10px;pointer-events:none' }, h('div', { class: 'fx-hud-card' }, hudM, hudD, hudP));
  if (stage) stage.append(ringCv, hud);

  // ── pad (the touch surface inside the section) ───────────────────────────────────────────────────────────────────
  const pad = h('canvas', { class: 'fx-pad', tabindex: '0', role: 'button', 'aria-label': 'FX pad. Hold to apply the effect; arrow keys move it.' });
  const padG = pad.getContext('2d');
  let padPtr = null;
  const padSurface = () => { const r = pad.getBoundingClientRect(); const R = r.width / 2; return { cx: r.left + R, cy: r.top + R, rIn: R * 0.1, rOut: R * 0.96 }; };
  on(pad, 'pointerdown', async (e) => {
    if (padPtr !== null) return;
    e.preventDefault(); pad.setPointerCapture(e.pointerId); padPtr = e.pointerId;
    try { await api.resume(); } catch { /* */ }
    ctl.pointerDown({ x: e.clientX, y: e.clientY }, padSurface(), performance.now());
  });
  on(pad, 'pointermove', (e) => { if (e.pointerId === padPtr) ctl.pointerMove({ x: e.clientX, y: e.clientY }, performance.now()); });
  const padUp = (e) => { if (e.pointerId === padPtr) { padPtr = null; ctl.pointerUp(); } };
  on(pad, 'pointerup', padUp); on(pad, 'pointercancel', padUp); on(pad, 'lostpointercapture', padUp);
  on(pad, 'keydown', (e) => {
    const k = e.key;
    if (k === ' ' || k === 'Enter') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) { api.resume().catch(() => {}); if (ctl.state.latch && ctl.engaged) ctl.release(); else ctl.keyDown(padSurface(), performance.now()); } return; }
    if (k === 'Escape') { ctl.release(); return; }
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[k];
    if (d) { e.preventDefault(); e.stopPropagation(); ctl.nudge(d[0], d[1], performance.now()); }
  });
  on(pad, 'keyup', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !ctl.state.latch) { e.preventDefault(); e.stopPropagation(); ctl.keyUp(); } });
  on(pad, 'blur', () => { if (!ctl.state.latch && padPtr === null) ctl.release(); });

  // ── waveform ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const wave = h('canvas', { class: 'fx-wave', role: 'img', 'aria-label': 'Waveform of the current track with the playhead' });
  let waveBitmap = null, waveKey = '';
  const cssVar = (n, d) => (getComputedStyle(document.documentElement).getPropertyValue(n) || d).trim() || d;
  function bakeWave(w, hh, env, dpr) {
    const cols = Math.max(8, Math.floor(w / 3));
    const c = waveColumns(env, cols);
    const cv = document.createElement('canvas'); cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr);
    const g = cv.getContext('2d'); g.scale(dpr, dpr);
    const v = cssVar('--violet', '#8E7BFF');
    const gr = g.createLinearGradient(0, 0, 0, hh); gr.addColorStop(0, v); gr.addColorStop(0.5, '#cfc6ff'); gr.addColorStop(1, v);
    g.fillStyle = gr;
    const bw = w / cols;
    for (let i = 0; i < cols; i++) { const a = Math.max(1.5, c[i] * (hh * 0.46)); g.globalAlpha = 0.9; g.fillRect(i * bw + 0.6, hh / 2 - a, Math.max(1, bw - 1.2), a * 2); }
    return cv;
  }
  function drawWave() {
    if (view === 'menu' || view === 'settings' || !wave.isConnected) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, wave.clientWidth), hh = Math.max(1, wave.clientHeight);
    const tr = api.host.getTrack();
    const env = api.host.envelope();
    const key = `${w}x${hh}@${dpr}|${tr ? tr.frames : 0}|${env ? env.length : 0}|${env ? env[env.length >> 1] : 0}`;
    if (wave.width !== Math.round(w * dpr)) { wave.width = Math.round(w * dpr); wave.height = Math.round(hh * dpr); }
    if (key !== waveKey) { waveKey = key; waveBitmap = bakeWave(w, hh, env, dpr); }
    const g = wave.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, wave.width, wave.height);
    if (waveBitmap) g.drawImage(waveBitmap, 0, 0);
    g.scale(dpr, dpr);
    const T = api.host.durationSec(), t = api.host.positionSec();
    const o = ctl.out.readout;
    if ((ctl.mode === 'repeat' || ctl.mode === 'stutter') && ctl.engaged && o.sliceMs) {
      const sp = sliceSpan(ctl.hold.capT || t, o.sliceMs / 1000, T, ctl.mode);
      if (sp) { g.fillStyle = 'rgba(255,107,94,.28)'; g.fillRect(sp[0] * w, 0, Math.max(2, (sp[1] - sp[0]) * w), hh); }
    }
    const x = playheadFrac(t, T) * w;
    g.fillStyle = '#fff'; g.fillRect(Math.round(x) - 1, 0, 2, hh);
    g.fillStyle = cssVar('--violet', '#8E7BFF'); g.beginPath(); g.arc(x, 4, 4, 0, Math.PI * 2); g.fill();
  }

  // ── views ────────────────────────────────────────────────────────────────────────────────────────────────────────
  const rowBtns = [];
  function menuView() {
    rowBtns.length = 0;
    const cd = api.host.view() === 'cd';
    const mk = (id, title, desc, extra = {}) => {
      const b = h('button', { class: 'fx-row' + (extra.nav ? ' nav' : ''), type: 'button', role: extra.nav ? 'menuitem' : 'option', 'data-id': id,
        'aria-selected': extra.nav ? null : String(ctl.mode === id), 'aria-disabled': extra.disabled ? 'true' : null, tabindex: '-1',
        onclick: () => { if (extra.disabled) { setNote(extra.disabledWhy); return; } extra.go(); } },
        h('span', { class: 'fx-row-main' }, h('span', { class: 'fx-row-t' }, title), desc ? h('span', { class: 'fx-row-d' }, desc) : null),
        extra.nav ? h('span', { 'aria-hidden': 'true' }, extra.glyph || '') : h('span', { class: 'fx-mark', 'aria-hidden': 'true' }));
      rowBtns.push(b); return b;
    };
    const list = h('div', { class: 'fx-list', role: 'listbox', 'aria-label': 'FX mode' },
      mk('back', '‹ Back', 'Close FX', { nav: true, go: () => api.close() }),
      mk('settings', 'Settings…', 'Light ring, hold style, tempo', { nav: true, glyph: '›', go: () => show('settings') }),
      ...MODES.map((m) => mk(m.id, m.label, m.desc, {
        disabled: m.id === 'blend' && (cd || !api.hasPlatter), disabledWhy: cd ? 'Blend scratch needs a vinyl record: a CD has no scratch.' : 'Blend scratch needs the platter, which is not on this screen.',
        go: () => { ctl.setMode(m.id); card(m.id); show('perform'); },
      })));
    on(list, 'keydown', (e) => {
      const i = rowBtns.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = rowBtns.length; rowBtns[(i + (e.key === 'ArrowDown' ? 1 : n - 1) + n) % n].focus(); }
    });
    // roving tabindex: the selected mode is the tab stop
    const sel = rowBtns.find((b) => b.dataset.id === ctl.mode) || rowBtns[0];
    rowBtns.forEach((b) => { b.tabIndex = b === sel ? 0 : -1; });
    return h('div', { class: 'fx-view', 'data-view': 'menu' }, list);
  }

  let noteEl = null, readEls = {};
  function setNote(t) { if (noteEl) noteEl.textContent = t || ''; }
  function card(id) {
    const c = h('div', { class: 'fx-card' }, modeInfo(id).label, h('span', {}, '· ACTIVE'));
    screen.append(c); setTimeout(() => c.remove(), 900);
  }

  function chips(list, current, onPick, label) {
    return h('div', { class: 'fx-chips', role: 'group', 'aria-label': label },
      ...list.map((d) => h('button', { class: 'fx-chip', type: 'button', 'aria-pressed': String(d === current), 'data-div': d, onclick: () => onPick(d) }, d)));
  }
  function slider(label, id, min, max, step, value, fmt, onInput) {
    const out = h('output', { for: id }, fmt(value));
    const inp = h('input', { id, type: 'range', min, max, step, value, 'aria-label': label });
    on(inp, 'input', () => { const v = Number(inp.value); out.textContent = fmt(v); onInput(v); });
    return h('div', { class: 'fx-field' }, h('label', { for: id }, label), out, inp);
  }
  function toggle(label, checked, onChange, id) {
    const inp = h('input', { type: 'checkbox', id }); inp.checked = !!checked;
    on(inp, 'change', () => onChange(inp.checked));
    return h('label', { class: 'fx-switch', for: id }, inp, h('span', {}, label));
  }

  function performView() {
    const st = ctl.state, m = ctl.mode, info = modeInfo(m);
    const kids = [];
    kids.push(h('div', { class: 'fx-top' },
      h('button', { class: 'fx-btn', type: 'button', 'aria-label': 'Back to the mode list', onclick: () => show('menu') }, '‹ Menu'),
      h('div', { class: 'fx-title' }, info.label),
      (readEls.live = h('span', { class: 'fx-live' + (m === 'scratch' ? ' off' : ''), text: m === 'scratch' ? 'NORMAL' : 'ACTIVE' }))));
    kids.push(wave);
    readEls.div = h('span', { class: 'fx-div' }); readEls.pct = h('span', { class: 'fx-pct' });
    kids.push(h('div', { class: 'fx-readout', 'aria-live': 'off' }, readEls.div, readEls.pct));
    readEls.slice = h('i'); readEls.sliceTrack = h('div', { class: 'fx-slice', role: 'img', 'aria-label': 'Slice length compared with one beat' }, readEls.slice);
    for (let i = 1; i < 16; i++) readEls.sliceTrack.append(h('b', { style: `left:${(i / 16) * 100}%` }));
    readEls.sub = h('div', { class: 'fx-sub' });
    if (m === 'repeat' || m === 'stutter') kids.push(readEls.sliceTrack);
    kids.push(readEls.sub);
    noteEl = h('div', { class: 'fx-sub', role: 'status' });

    if (m === 'repeat') {
      kids.push(chips(DIVISIONS, st.repeat.div, (d) => ctl.setDivision(d), 'Slice length, fraction of a beat'));
      kids.push(h('div', { class: 'fx-seg', role: 'group', 'aria-label': 'After release' },
        ...[['time', 'Keep time'], ['capture', 'Back to start']].map(([v, t]) => h('button', { class: 'fx-chip', type: 'button', 'aria-pressed': String(st.repeat.resume === v), onclick: () => { ctl.setParam('repeat', 'resume', v); rebuild(); } }, t))));
      kids.push(h('div', { class: 'fx-sub' }, 'Hold to loop the last slice. Slide toward the centre for shorter slices, outward for longer. Spin faster for a quicker repeat.'));
    } else if (m === 'stutter') {
      kids.push(chips(DIVISIONS, st.stutter.div, (d) => ctl.setDivision(d), 'Stutter rate, fraction of a beat'));
      kids.push(slider('Gate length', 'fxGate', 10, 100, 1, Math.round(st.stutter.gate * 100), (v) => v + '%', (v) => ctl.setParam('stutter', 'gate', v / 100)));
      kids.push(h('div', { class: 'fx-sub' }, 'Hold to retrigger this moment on the beat. Slide to change the rate.'));
    } else if (m === 'blend') {
      kids.push(slider('Blend: song under the scratch', 'fxBlend', 0, 100, 1, Math.round(st.blend.amount * 100), (v) => v + '%', (v) => ctl.setParam('blend', 'amount', v / 100)));
      kids.push(toggle('Set the blend by where I touch (outer edge = more song)', st.blend.byRadius, (v) => ctl.setParam('blend', 'byRadius', v), 'fxByRadius'));
      kids.push(h('div', { class: 'fx-sub' }, 'Scratch the platter as usual. The song carries on underneath your scratch.'));
    } else if (m === 'bandpass') {
      kids.push(h('div', { class: 'fx-sub' }, 'Hold and slide: left and right move the centre frequency, up and down narrow the band.'));
    } else if (m === 'echo') {
      kids.push(chips(DIVISIONS, st.echo.delayDiv, (d) => ctl.setDivision(d), 'Delay time, fraction of a beat'));
      kids.push(slider('Delay ↔ room', 'fxBal', 0, 100, 1, Math.round(st.echo.balance * 100), (v) => v + '%', (v) => ctl.setParam('echo', 'balance', v / 100)));
      kids.push(h('div', { class: 'fx-sub' }, 'Hold and slide: left to right adds more echo and room, up and down sets how long the echoes last. The tail rings out when you let go.'));
    } else {
      kids.push(h('div', { class: 'fx-sub' }, 'Drag the platter to scrub, exactly as before. Pick another mode to perform on top of the song.'));
    }
    if (m !== 'scratch' && (m !== 'blend' || !api.hasPlatter)) {
      kids.push(h('div', { class: 'fx-padwrap' }, pad, h('div', { class: 'fx-sub' }, ctl.state.latch ? 'Tap the pad to switch on, tap again to switch off.' : api.hasPlatter ? 'Hold the pad here, or use the platter.' : 'Hold the pad.')));
    }
    if (needsTempo(m)) {
      readEls.tempoRow = h('div', { class: 'fx-seg' },
        h('button', { class: 'fx-chip', type: 'button', 'aria-label': 'Halve the tempo', onclick: () => ctl.setParam('root', 'bpmScale', ctl.state.bpmScale === 0.5 ? 1 : 0.5) }, '½× tempo'),
        h('button', { class: 'fx-chip', type: 'button', 'aria-label': 'Double the tempo', onclick: () => ctl.setParam('root', 'bpmScale', ctl.state.bpmScale === 2 ? 1 : 2) }, '2× tempo'));
      kids.push(readEls.tempoRow);
    }
    kids.push(noteEl);
    return h('div', { class: 'fx-view', 'data-view': 'perform' }, ...kids);
  }

  function settingsView() {
    return h('div', { class: 'fx-view', 'data-view': 'settings' },
      h('div', { class: 'fx-top' }, h('button', { class: 'fx-btn', type: 'button', onclick: () => show('menu') }, '‹ Menu'), h('div', { class: 'fx-title' }, 'FX settings')),
      toggle('Light ring around the platter', ctl.state.ring, (v) => { ctl.setParam('root', 'ring', v); ringKey = ''; }, 'fxRingOn'),
      toggle('Latch: tap to switch an effect on, tap again to switch it off', ctl.state.latch, (v) => ctl.setParam('root', 'latch', v), 'fxLatch'),
      h('div', { class: 'fx-sub' }, 'Tempo is estimated from the current track. If an effect feels twice too fast or slow, use the half / double buttons on the mode screen.'),
      h('div', { class: 'fx-sub' }, 'FX works on your own records and CDs. It switches itself off while a radio station or a mixtape is playing.'));
  }

  function show(v) {
    view = v;
    const next = v === 'menu' ? menuView() : v === 'settings' ? settingsView() : performView();
    screen.querySelector('.fx-view')?.remove();
    screen.prepend(next);
    waveKey = '';
    refresh();
    if (v === 'menu') (rowBtns.find((b) => b.tabIndex === 0) || rowBtns[0])?.focus({ preventScroll: true });
  }
  const rebuild = () => show(view);

  // ── live refresh (readouts, messages) ────────────────────────────────────────────────────────────────────────────
  let lastMsg = '';
  function refresh() {
    const why = ctl.blockedReason;
    const text = why ? `FX is off: ${why}` : '';
    if (text !== lastMsg) { lastMsg = text; msg.textContent = text; msg.classList.toggle('hidden', !text); }
    const o = ctl.out.readout, m = ctl.mode;
    if (view === 'perform' && readEls.div) {
      const live = ctl.engaged || (m !== 'scratch' && !why);
      if (readEls.live) { readEls.live.textContent = why ? 'OFF' : m === 'scratch' ? 'NORMAL' : ctl.engaged ? 'LIVE' : 'ACTIVE'; readEls.live.classList.toggle('off', !!why || m === 'scratch'); }
      readEls.div.classList.toggle('sm', !(m === 'repeat' || m === 'stutter'));
      readEls.div.textContent = why ? '' : o.division && (m === 'repeat' || m === 'stutter') ? o.division : (m === 'blend' || m === 'bandpass' || m === 'echo') ? (o.text || '') : '';
      readEls.pct.textContent = m === 'repeat' && o.percent != null && !why ? formatPercent(o.percent) : m === 'stutter' && !why ? `gate ${Math.round(ctl.state.stutter.gate * 100)}%` : '';
      if (readEls.slice) readEls.slice.style.width = `${(o.sliceFrac != null ? o.sliceFrac : sliceFraction(m === 'stutter' ? ctl.state.stutter.div : ctl.state.repeat.div)) * 100}%`;
      if (readEls.sub) {
        const b = ctl.beat;
        readEls.sub.textContent = !needsTempo(m) ? '' : ctl.tempoState === 'analysing' ? 'Listening for the tempo…' : (m === 'repeat' || m === 'stutter')
          ? `${beatLabel(b)}${o.sliceMs ? ` · slice ${Math.round(o.sliceMs)} ms` : ''}` : beatLabel(b);
      }
      if (readEls.tempoRow) { const [a, b2] = readEls.tempoRow.children; a.setAttribute('aria-pressed', String(ctl.state.bpmScale === 0.5)); b2.setAttribute('aria-pressed', String(ctl.state.bpmScale === 2)); }
      void live;
    }
    // stage HUD
    const showHud = !why && ctl.engaged && m !== 'scratch';
    hud.classList.toggle('hidden', !showHud);
    if (showHud) { hudM.textContent = modeInfo(m).label; hudD.textContent = (m === 'repeat' || m === 'stutter') ? o.division : ''; hudP.textContent = m === 'repeat' && o.percent != null ? formatPercent(o.percent) : (m === 'repeat' || m === 'stutter') ? '' : o.text; }
    if (view === 'perform') {
      const cur = ctl.hold.engaged && ctl.hold.div ? ctl.hold.div : m === 'repeat' ? ctl.state.repeat.div : m === 'stutter' ? ctl.state.stutter.div : m === 'echo' ? ctl.state.echo.delayDiv : null;
      screen.querySelectorAll('.fx-chips [data-div]').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.div === cur)));
    }
    // keep the menu selection in sync
    if (view === 'menu') for (const b of rowBtns) if (b.dataset.id && b.hasAttribute('aria-selected')) b.setAttribute('aria-selected', String(ctl.mode === b.dataset.id));
  }
  const unsub = ctl.onChange(() => { refresh(); if (view === 'perform' && !screen.contains(document.activeElement)) { /* keep focus where it is */ } });

  // ── frame: pad, ring, playhead ───────────────────────────────────────────────────────────────────────────────────
  let ringKey = '', padKey = '', frameN = 0;
  function drawPad(now) {
    if (!pad.isConnected || pad.clientWidth === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), s = pad.clientWidth;
    if (pad.width !== Math.round(s * dpr)) { pad.width = Math.round(s * dpr); pad.height = Math.round(s * dpr); padKey = ''; }
    const st = ctl.ring();
    const hold = ctl.hold, eng = ctl.engaged;
    const R = s / 2;
    const fa = eng ? hold.angle : null;
    const key = ringSignature(st, R, R, R * 0.93, fa, now) + `|${eng}|${hold.x.toFixed(2)}|${hold.y.toFixed(2)}|${ctl.mode}|${ctl.blockedReason ? 1 : 0}`;
    if (key === padKey && !st.rotate) return;
    padKey = key;
    padG.setTransform(dpr, 0, 0, dpr, 0, 0);
    padG.clearRect(0, 0, s, s);
    padG.fillStyle = '#05050a'; padG.beginPath(); padG.arc(R, R, R * 0.9, 0, Math.PI * 2); padG.fill();
    padG.strokeStyle = 'rgba(255,255,255,.05)'; padG.lineWidth = 1;
    for (let r = R * 0.18; r < R * 0.88; r += R * 0.085) { padG.beginPath(); padG.arc(R, R, r, 0, Math.PI * 2); padG.stroke(); }
    if (isPadMode(ctl.mode)) { padG.strokeStyle = 'rgba(142,123,255,.25)'; padG.beginPath(); padG.moveTo(R * 0.12, R); padG.lineTo(R * 1.88, R); padG.moveTo(R, R * 0.12); padG.lineTo(R, R * 1.88); padG.stroke(); }
    if (eng) {
      const px = isPadMode(ctl.mode) ? R + hold.x * R * 0.9 : R + Math.cos(hold.angle) * (R * 0.18 + hold.u * R * 0.7);
      const py = isPadMode(ctl.mode) ? R - hold.y * R * 0.9 : R + Math.sin(hold.angle) * (R * 0.18 + hold.u * R * 0.7);
      padG.fillStyle = `hsla(${st.hue},90%,75%,.9)`; padG.beginPath(); padG.arc(px, py, 9, 0, Math.PI * 2); padG.fill();
    } else {
      padG.fillStyle = 'rgba(232,232,240,.5)'; padG.font = '600 13px system-ui, sans-serif'; padG.textAlign = 'center'; padG.textBaseline = 'middle';
      padG.fillText(ctl.blockedReason ? 'FX OFF' : ctl.state.latch ? 'TAP' : 'HOLD', R, R);
    }
    drawRing(padG, s, s, R, R, R * 0.94, st, { t: now, fingerAngle: fa, shimmer: !reducedQ.matches, clear: false });
  }
  function drawStageRing(now) {
    if (!stage) return;
    const vinyl = api.host.view() === 'vinyl';
    const geom = api.host.geom();
    const st = ctl.ring();
    if (!vinyl || !geom || !st.on) { if (ringKey !== 'off') { ringKey = 'off'; const g = ringCv.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, ringCv.width, ringCv.height); } return; }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = ringCv.clientWidth, H = ringCv.clientHeight;
    if (ringCv.width !== Math.round(W * dpr) || ringCv.height !== Math.round(H * dpr)) { ringCv.width = Math.round(W * dpr); ringCv.height = Math.round(H * dpr); ringKey = ''; }
    const fa = ctl.engaged && ctl.hold.pointer && !isPadMode(ctl.mode) && padPtr === null ? ctl.hold.angle : null;
    const key = ringSignature(st, geom.cx, geom.cy, geom.R || geom.rOut, fa, now);
    if (key === ringKey && !st.rotate) return;
    ringKey = key;
    const g = ringCv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawRing(g, W, H, geom.cx, geom.cy, (geom.R || geom.rOut) * 1.02, st, { t: now, fingerAngle: fa, shimmer: !reducedQ.matches });
  }

  let shown = false, raf = 0, lastT = 0, lastTrack = api.host.getTrack();
  const loop = (now) => {
    if (!shown) return;
    const dt = lastT ? Math.min(0.05, Math.max(0.001, (now - lastT) / 1000)) : 0.016; lastT = now;
    const tr = api.host.getTrack();
    if (tr !== lastTrack) { lastTrack = tr; handle.onTrack(); }          // a record / tape was loaded by someone else: nothing survives it
    ctl.tick(dt, now);
    frameN++;
    if (frameN % 2 === 0) { drawStageRing(now); if (view === 'perform') { drawWave(); drawPad(now); } refresh(); }
    raf = requestAnimationFrame(loop);
  };
  const setOverlays = (on) => { ringCv.style.display = on ? '' : 'none'; if (!on) hud.classList.add('hidden'); };
  const handle = {
    controller: ctl, bus,
    onShow() { if (shown) return; shown = true; lastT = 0; ringKey = ''; if (api.host.getTrack() !== lastTrack) { lastTrack = api.host.getTrack(); handle.onTrack(); } setOverlays(true); raf = requestAnimationFrame(loop); },
    onHide() { if (!shown) return; shown = false; cancelAnimationFrame(raf); ctl.release(); setOverlays(false); },
    onTrack() { ctl.onTrack(); waveKey = ''; if (view === 'menu') rebuild(); },
    platter: {
      wantsPlatter: () => shown && ctl.wantsPlatter(),
      grabsPlatter: () => ctl.grabsPlatter(),
      pointerDown: (p, s, t) => ctl.pointerDown(p, s, t),
      pointerMove: (p, t) => ctl.pointerMove(p, t),
      pointerUp: () => ctl.pointerUp(),
      rateFor: (r) => ctl.rateFor(r),
    },
    unmount() {
      shown = false; cancelAnimationFrame(raf);
      unsub(); ctl.dispose();
      for (const f of cleanup.splice(0)) f();
      ringCv.remove(); hud.remove(); root.replaceChildren(); root.classList.remove('fx-root');
      try { if (globalThis.__runoutFx === handle) globalThis.__runoutFx = null; } catch { /* */ }
    },
  };
  try { globalThis.__runoutFx = handle; } catch { /* test hook only */ }
  if (ctl.mode === 'blend' && !api.hasPlatter) ctl.setMode('scratch');   // Blend scratch needs the platter
  show('menu');
  if (ctl.mode !== 'scratch') { ctl.ensureTempo(); show('perform'); }
  return handle;
}
