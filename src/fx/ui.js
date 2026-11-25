// ─────────────────────────────────────────────────────────────────────────────
// ui.js — the Booth: a hardware-style FX instrument screen (lazy-loaded the first time the section is opened; never imported at app boot).
//   mountFxSection(container, deps) -> { unmount, onShow, onHide, onTrack, setAod, platter, controller }
// SELF-CONTAINED: it lays out in whatever container / size it is given (360 x 780 portrait and 915 x 412 landscape included), makes no
// assumption about where it sits, and prefixes all its CSS with .fx-. It runs its own animation loop while shown.
//
//   The instrument, top to bottom (portrait):
//     deck strip   what is on the deck (record / CD, title, tempo) with the waveform and playhead
//     FX rack      six effects, each a button with an on / live LED (scratch, blend, beat repeat, stutter, filter, echo)
//     XY plate     the touch surface: concentric slice zones (repeat, stutter) or an XY grid (filter, echo) with a lit puck and axis labels;
//                  beside it a blend fader and a level meter
//     switches     latch, light ring, half / double tempo, restart-after-release
//     knobs        beat (stepped), gate, delay / room: drag a knob up or down to turn it
//     pad grid     eight performance pads (effect + beat): hold to play, or tap to latch when Latch is on
//   Idle states (no record on the deck, or a radio / mixtape owns the engine) show a plain message and a button that goes there.
//
//   deps = { engine: {ctx, musicBus, setFx(p)}, host: { getTrack, envelope, hasRecord, nowPlaying, durationSec, positionSec, nominalRate,
//            omegaNominal, sampleRate, blocked, view, geom }, resume(): Promise, stage?: Element (platter stage for the light ring + HUD),
//            close?: () => void, goto?: (sectionId) => void, haptic?: (ms) => void }
//   platter = { wantsPlatter, grabsPlatter, pointerDown(p, surface, t), pointerMove(p, t), pointerUp(), rateFor(rate) }: what a shell
//   wires to its platter's pointer events and rate (optional: the pad inside the section works without it).
// All decisions are in controller.js / modes.js; this file builds DOM, draws the waveform / plate / meter / light ring and forwards events.
// Lock seams: live buttons and knobs carry `data-lock-ok`; the plate and the pads are gestures (allowsGesture('fx-pad')); registerLockFace
// (src/devicemode/default-faces.js) names the selectors; setAod(true) stops every canvas.
// ─────────────────────────────────────────────────────────────────────────────

import { FxController } from './controller.js';
import { FxBus } from './bus.js';
import { MODES, modeInfo, needsTempo, isPadMode } from './modes.js';
import { DIVISIONS, sliceFraction, beatLabel } from './divisions.js';
import { waveColumns, playheadFrac, sliceSpan } from './waveform.js';
import { drawRing, ringSignature } from './ring-draw.js';
import { MODE_HUE } from './ring.js';
import { formatPercent, GESTURE_KNOBS as GK } from './gesture.js';
import { computeEnvelope } from '../model.js';
import { allowsGesture } from '../devicemode/guard.js';

const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
const SVGNS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

const CSS_ID = 'fx-css';
function loadCss() {
  if (document.getElementById(CSS_ID)) return;
  const l = document.createElement('link'); l.id = CSS_ID; l.rel = 'stylesheet'; l.href = new URL('./fx.css', import.meta.url).href;
  document.head.append(l);
}

const BLOCK = {
  radio: { text: 'A radio station is playing.', hint: 'Stop it in Radio to use the Booth.', go: 'radio', label: 'Open Radio' },
  mixtape: { text: 'A mixtape is playing.', hint: 'Stop the tape to use the Booth.', go: 'mixtapes', label: 'Open Mixtapes' },
};
const envCache = new WeakMap();

// the rack: id -> short label (two lines at most) and the colour of its LED / pad / puck (the same hue as the light ring)
const RACK = [
  { id: 'scratch', name: 'SCRATCH' }, { id: 'blend', name: 'BLEND' }, { id: 'repeat', name: 'BEAT REPEAT' },
  { id: 'stutter', name: 'STUTTER' }, { id: 'bandpass', name: 'FILTER' }, { id: 'echo', name: 'ECHO' },
];
const hue = (id) => (MODE_HUE[id] != null ? MODE_HUE[id] : 262);
const colour = (id, l = 64) => `hsl(${hue(id)} 88% ${l}%)`;

// the performance pads: effect + beat. Hold = play; with Latch on, tap = on, tap again = off.
const PADS = [
  { mode: 'repeat', div: '1/4', top: 'REPEAT' }, { mode: 'repeat', div: '1/8', top: 'REPEAT' }, { mode: 'repeat', div: '1/16', top: 'REPEAT' }, { mode: 'stutter', div: '1/8', top: 'STUTTER' },
  { mode: 'stutter', div: '1/16', top: 'STUTTER' }, { mode: 'bandpass', div: null, top: 'FILTER', big: 'SWEEP' }, { mode: 'echo', div: '1/4', top: 'ECHO' }, { mode: 'echo', div: '1/2', top: 'ECHO' },
];

const HINTS = {
  scratch: 'Play: hit a pad or pick an effect',
  blend: 'Scratch the platter on Albums · the song keeps playing under it',
  repeat: 'HOLD · slide in = shorter, out = longer · spin = faster',
  stutter: 'HOLD · slide in = faster, out = slower',
};
const AXES = {
  bandpass: { x: 'LOW  ◂  CENTRE FREQUENCY  ▸  HIGH', y: 'WIDE  ◂  Q  ▸  NARROW' },
  echo: { x: 'DRY  ◂  ECHO + ROOM  ▸  WET', y: 'SHORT  ◂  TAIL  ▸  LONG' },
};
const LIVE_HINT = { bandpass: 'HOLD and slide', echo: 'HOLD and slide' };

/** Fill in whatever the shell's deps leave out, from the engine itself (the shell passes only engine / storage / blocked / a few host accessors). */
function adaptDeps(d) {
  const e = d.engine, h = d.host || {};
  const sr = () => (h.sampleRate ? h.sampleRate() : e.sampleRate);
  const rawBlocked = () => (h.blocked ? h.blocked() : d.blocked ? d.blocked() : null);
  const blocked = () => { const b = rawBlocked(); return b ? (b in BLOCK ? `${BLOCK[b].text} ${BLOCK[b].hint}` : String(b)) : null; };
  const rawTrack = () => (h.getTrack ? h.getTrack() : null);
  return {
    engine: e, stage: d.stage || null, close: d.close || null, storage: d.storage, hasPlatter: !!d.hasPlatter,
    goto: d.goto || null, haptic: d.haptic || null,
    resume: d.resume || (() => e.resume()),
    host: {
      getTrack: () => { const t = rawTrack(); return t && (t.channels || t.tempoFeed) ? t : null; },
      hasRecord: h.hasRecord || (() => !!rawTrack()),
      nowPlaying: h.nowPlaying || (() => { const t = rawTrack(); return t ? { title: t.name || 'Untitled', sub: '', kind: 'vinyl', rpm: 33.33, playing: true } : null; }),
      envelope: h.envelope || (() => {
        const t = rawTrack();
        if (!t || !t.channels) return null;
        if (!envCache.has(t)) { const [L, R] = t.channels; envCache.set(t, computeEnvelope((i) => (R ? (L[i] + R[i]) * 0.5 : L[i]), t.frames, 1024)); }
        return envCache.get(t);
      }),
      durationSec: h.durationSec || (() => (e.frames > 0 ? e.frames / e.sampleRate : 0)),
      positionSec: h.positionSec || (() => e.position / e.sampleRate),
      nominalRate: h.nominalRate || (() => 1),
      omegaNominal: h.omegaNominal || (() => (2 * Math.PI * (100 / 3)) / 60),
      sampleRate: sr, blocked, blockedRaw: rawBlocked, view: h.view || (() => 'vinyl'), geom: h.geom || (() => null),
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
  const haptic = (ms) => { try { api.haptic && api.haptic(ms); } catch { /* no haptics */ } };

  const screen = h('div', { class: 'fx-screen' });
  root.replaceChildren(screen);

  // ── stage overlay: light ring + HUD (only when a shell passes a platter stage) ───────────────────────────────────────
  const stage = api.stage;
  const ringCv = h('canvas', { class: 'fx-stage-ring', 'aria-hidden': 'true', style: 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none' });
  const hudM = h('span', { class: 'm' }), hudD = h('span', { class: 'd' }), hudP = h('span', { class: 'p' });
  const hud = h('div', { class: 'fx-hud hidden', 'aria-hidden': 'true', style: 'position:absolute;left:0;right:0;top:10px;pointer-events:none' }, h('div', { class: 'fx-hud-card' }, hudM, hudD, hudP));
  if (stage) stage.append(ringCv, hud);

  // ── deck strip ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const disc = h('div', { class: 'fx-disc', 'data-kind': 'vinyl', 'aria-hidden': 'true' }, h('i'));
  const deckT = h('div', { class: 'fx-deck-t' }), deckS = h('div', { class: 'fx-deck-s' });
  const deckBpm = h('div', { class: 'fx-lcd fx-bpm' });
  const wave = h('canvas', { class: 'fx-wave', role: 'img', 'aria-label': 'Waveform of the current track with the playhead' });
  const deck = h('section', { class: 'fx-deck fx-panel', 'aria-label': 'Now playing on the deck' },
    h('div', { class: 'fx-deck-row' }, disc, h('div', { class: 'fx-deck-id' }, h('div', { class: 'fx-cap' }, 'DECK'), deckT, deckS), deckBpm),
    wave);

  // ── rack ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const rackBtns = [];
  const flash = h('div', { class: 'fx-foot-note', role: 'status', 'aria-live': 'polite' });
  let flashTimer = 0;
  function note(t) { flash.textContent = t; flash.classList.add('on'); clearTimeout(flashTimer); flashTimer = setTimeout(() => flash.classList.remove('on'), 2600); }
  const rack = h('div', { class: 'fx-rack fx-panel', role: 'listbox', 'aria-label': 'FX rack: choose an effect' },
    ...RACK.map((r) => {
      const info = modeInfo(r.id);
      const cd = api.host.view() === 'cd';
      const noBlend = r.id === 'blend' && !api.hasPlatter;
      const b = h('button', { class: 'fx-row', type: 'button', role: 'option', 'data-id': r.id, 'data-lock-ok': true, style: `--c:${colour(r.id)}`, 'aria-selected': 'false', 'aria-disabled': noBlend ? 'true' : null, title: info.desc,
        onclick: () => {
          if (noBlend) { note(cd ? 'Blend scratch needs a vinyl record: a CD has no scratch.' : 'Blend scratch needs the platter, which is on Albums.'); return; }
          haptic(6); ctl.setMode(r.id); api.resume().catch(() => {});
        } },
        h('span', { class: 'fx-led', 'aria-hidden': 'true' }), h('span', { class: 'fx-row-t' }, r.name), noBlend ? h('span', { class: 'fx-row-why' }, cd ? 'Vinyl only' : 'Needs a playing record') : null);
      rackBtns.push(b); return b;
    }));
  on(rack, 'keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const i = rackBtns.indexOf(document.activeElement); if (i < 0) return;
    e.preventDefault(); const n = rackBtns.length; rackBtns[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : n - 1)) % n].focus();
  });

  // ── XY plate ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const pad = h('canvas', { class: 'fx-pad', tabindex: '0', role: 'button', 'aria-label': 'FX touch plate. Hold to apply the effect; arrow keys move it.' });
  const padG = pad.getContext('2d');
  let padPtr = null;
  const padSurface = () => { const r = pad.getBoundingClientRect(); const R = r.width / 2; return { cx: r.left + R, cy: r.top + R, rIn: R * 0.1, rOut: R * 0.96 }; };
  const pLive = h('span', { class: 'fx-live off', text: 'NORMAL' });
  const pDiv = h('span', { class: 'fx-div' }), pPct = h('span', { class: 'fx-pct' }), pSub = h('span', { class: 'fx-psub' });
  const axX = h('div', { class: 'fx-ax fx-ax-x', 'aria-hidden': 'true' }), axY = h('div', { class: 'fx-ax fx-ax-y', 'aria-hidden': 'true' });
  const idleIcon = h('div', { class: 'fx-idle-ic', 'aria-hidden': 'true' }, h('i'));
  const idleT = h('div', { class: 'fx-idle-t' }), idleS = h('div', { class: 'fx-idle-s' });
  const idleBtn = h('button', { class: 'fx-btn fx-go', type: 'button', onclick: () => goIdle() });
  const idle = h('div', { class: 'fx-idle hidden', role: 'status', 'aria-live': 'polite' }, idleIcon, idleT, idleS, idleBtn);
  const plate = h('div', { class: 'fx-plate', 'data-lock-surface': true },
    pad,
    h('div', { class: 'fx-plate-top' }, h('div', { class: 'fx-readout', 'aria-live': 'off' }, pDiv, pPct), pLive), pSub, axY, axX, flash, idle);

  const keyPad = (e) => {
    const k = e.key;
    if (!allowsGesture('fx-pad')) return;
    if (k === ' ' || k === 'Enter') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) { api.resume().catch(() => {}); if (ctl.state.latch && ctl.engaged) ctl.release(); else ctl.keyDown(padSurface(), performance.now()); } return; }
    if (k === 'Escape') { ctl.release(); return; }
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[k];
    if (d) { e.preventDefault(); e.stopPropagation(); ctl.nudge(d[0], d[1], performance.now()); }
  };
  on(pad, 'pointerdown', async (e) => {
    if (padPtr !== null || idleKind || !allowsGesture('fx-pad')) return;
    e.preventDefault(); try { pad.setPointerCapture(e.pointerId); } catch { /* */ } padPtr = e.pointerId;
    const id = e.pointerId, p = { x: e.clientX, y: e.clientY };
    try { await api.resume(); } catch { /* */ }
    if (ctl.mode === 'scratch' || ctl.mode === 'blend') { if (padPtr === id) note(ctl.mode === 'blend' ? HINTS.blend : 'Pick an effect in the rack, or hit a pad.'); return; }
    ctl.pointerDown(p, padSurface(), performance.now());
    haptic(10);
    if (padPtr !== id) ctl.pointerUp();                       // lifted while the audio woke up: a short blip, never a stuck effect
  });
  on(pad, 'pointermove', (e) => { if (e.pointerId === padPtr) ctl.pointerMove({ x: e.clientX, y: e.clientY }, performance.now()); });
  const padUp = (e) => { if (e.pointerId === padPtr) { padPtr = null; ctl.pointerUp(); } };
  on(pad, 'pointerup', padUp); on(pad, 'pointercancel', padUp); on(pad, 'lostpointercapture', padUp);
  on(pad, 'keydown', keyPad);
  on(pad, 'keyup', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !ctl.state.latch) { e.preventDefault(); e.stopPropagation(); ctl.keyUp(); } });
  on(pad, 'blur', () => { if (!ctl.state.latch && padPtr === null) ctl.release(); });

  // ── knobs and faders (drawn controls: drag up / down to turn) ───────────────────────────────────────────────────────
  const A0 = 135, SWEEP = 270;
  const pt = (r, a) => { const t = (a * Math.PI) / 180; return `${(32 + r * Math.cos(t)).toFixed(2)} ${(32 + r * Math.sin(t)).toFixed(2)}`; };
  const arc = (r, a0, a1) => `M ${pt(r, a0)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${pt(r, a1)}`;
  const knobs = {};
  /** opts: { id, label, owner, min, max, step, value, fmt, onInput, steps?: number (stepped knob) } */
  function knob(o) {
    const track = sv('path', { class: 'fx-k-track', d: arc(27, A0, A0 + SWEEP) });
    const val = sv('path', { class: 'fx-k-val', d: arc(27, A0, A0 + 0.01) });
    const capEl = sv('circle', { class: 'fx-k-cap', cx: 32, cy: 32, r: 20 });
    const ptr = sv('line', { class: 'fx-k-ptr', x1: 32, y1: 32 - 9, x2: 32, y2: 32 - 18 });
    const grp = sv('g', {}, ); grp.append(ptr);
    const svg = sv('svg', { viewBox: '0 0 64 64', class: 'fx-k-svg', 'aria-hidden': 'true' }); svg.append(track, val, capEl, grp);
    for (let i = 0; i <= (o.steps || 10); i++) { const a = A0 + (SWEEP * i) / (o.steps || 10); const t = sv('line', { class: 'fx-k-tick', x1: pt(31, a).split(' ')[0], y1: pt(31, a).split(' ')[1], x2: pt(29.5, a).split(' ')[0], y2: pt(29.5, a).split(' ')[1] }); svg.append(t); }
    const out = h('output', { class: 'fx-lcd fx-k-out', for: o.id });
    const el = h('div', { class: 'fx-knob', id: o.id, role: 'slider', tabindex: '0', 'data-lock-ok': true, 'data-owner': o.owner, 'aria-label': o.label, 'aria-valuemin': o.min, 'aria-valuemax': o.max, style: `--c:${colour(o.owner)}` },
      h('div', { class: 'fx-k-owner' }, o.ownerName), svg, h('div', { class: 'fx-k-name' }, o.label), out);
    let value = o.value, dragging = false;
    const set = (v, emit) => {
      v = o.steps ? clamp(Math.round(v), o.min, o.max) : clamp(Math.round(v / o.step) * o.step, o.min, o.max);
      const f = (v - o.min) / (o.max - o.min);
      const changed = v !== value; value = v;
      val.setAttribute('d', arc(27, A0, A0 + Math.max(0.01, SWEEP * f)));
      grp.setAttribute('transform', `rotate(${(-SWEEP / 2 + SWEEP * f).toFixed(1)} 32 32)`);
      out.textContent = o.fmt(v); el.setAttribute('aria-valuenow', v); el.setAttribute('aria-valuetext', o.fmt(v));
      if (emit && changed) { o.onInput(v); if (o.steps) haptic(4); }
    };
    let y0 = 0, v0 = 0;
    on(el, 'pointerdown', (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); dragging = true; y0 = e.clientY; v0 = value; el.classList.add('drag'); el.focus({ preventScroll: true }); });
    on(el, 'pointermove', (e) => {
      if (!dragging) return;
      const dy = y0 - e.clientY, span = o.max - o.min;
      set(o.steps ? v0 + dy / 26 : v0 + (dy / 150) * span, true);
    });
    const end = () => { dragging = false; el.classList.remove('drag'); };
    on(el, 'pointerup', end); on(el, 'pointercancel', end);
    on(el, 'keydown', (e) => {
      const st = o.steps ? 1 : o.step * (e.shiftKey ? 5 : 1);
      const d = { ArrowUp: st, ArrowRight: st, ArrowDown: -st, ArrowLeft: -st }[e.key];
      if (d) { e.preventDefault(); set(value + d, true); } else if (e.key === 'Home') { e.preventDefault(); set(o.min, true); } else if (e.key === 'End') { e.preventDefault(); set(o.max, true); }
    });
    set(value, false);
    knobs[o.id] = { el, set: (v) => { if (!dragging) set(v, false); }, get: () => value };
    return el;
  }

  const st0 = ctl.state;
  const divLabel = (i) => DIVISIONS[clamp(i, 0, DIVISIONS.length - 1)];
  const curDiv = () => (ctl.mode === 'stutter' ? ctl.state.stutter.div : ctl.mode === 'echo' ? ctl.state.echo.delayDiv : ctl.state.repeat.div);
  const knobRow = h('div', { class: 'fx-knobs fx-panel', role: 'group', 'aria-label': 'Knobs' },
    knob({ id: 'fxKBeat', label: 'BEAT', owner: 'repeat', ownerName: 'REPEAT · STUTTER · ECHO', min: 0, max: DIVISIONS.length - 1, steps: DIVISIONS.length - 1, value: DIVISIONS.indexOf(curDiv()), fmt: (v) => divLabel(v), onInput: (v) => ctl.setDivision(divLabel(v)) }),
    knob({ id: 'fxKGate', label: 'GATE', owner: 'stutter', ownerName: 'STUTTER', min: 10, max: 100, step: 1, value: Math.round(st0.stutter.gate * 100), fmt: (v) => `${v}%`, onInput: (v) => ctl.setParam('stutter', 'gate', v / 100) }),
    knob({ id: 'fxKRoom', label: 'DELAY / ROOM', owner: 'echo', ownerName: 'ECHO', min: 0, max: 100, step: 1, value: Math.round(st0.echo.balance * 100), fmt: (v) => (v <= 3 ? 'DELAY' : v >= 97 ? 'ROOM' : `${v}%`), onInput: (v) => ctl.setParam('echo', 'balance', v / 100) }));

  // blend fader (vertical) + level meter, beside the plate
  const faderCap = h('div', { class: 'fx-f-cap' }, h('i'));
  const faderOut = h('output', { class: 'fx-lcd fx-f-out', for: 'fxFBlend' });
  const fader = h('div', { class: 'fx-fader', id: 'fxFBlend', role: 'slider', tabindex: '0', 'data-lock-ok': true, 'aria-label': 'Blend: song under the scratch', 'aria-valuemin': 0, 'aria-valuemax': 100, style: `--c:${colour('blend')}` },
    h('div', { class: 'fx-f-name' }, 'BLEND'), h('div', { class: 'fx-f-track' }, h('div', { class: 'fx-f-fill' }), faderCap), faderOut);
  let fval = Math.round(st0.blend.amount * 100), fdrag = false;
  const fset = (v, emit) => {
    v = clamp(Math.round(v), 0, 100); const changed = v !== fval; fval = v;
    fader.style.setProperty('--f', String(v / 100)); faderOut.textContent = `${v}%`; fader.setAttribute('aria-valuenow', v);
    if (emit && changed) ctl.setParam('blend', 'amount', v / 100);
  };
  const fromY = (e) => { const r = fader.querySelector('.fx-f-track').getBoundingClientRect(); return (1 - (e.clientY - r.top) / Math.max(1, r.height)) * 100; };
  on(fader, 'pointerdown', (e) => { e.preventDefault(); fader.setPointerCapture(e.pointerId); fdrag = true; fader.classList.add('drag'); fader.focus({ preventScroll: true }); fset(fromY(e), true); });
  on(fader, 'pointermove', (e) => { if (fdrag) fset(fromY(e), true); });
  const fend = () => { fdrag = false; fader.classList.remove('drag'); };
  on(fader, 'pointerup', fend); on(fader, 'pointercancel', fend);
  on(fader, 'keydown', (e) => { const d = { ArrowUp: 5, ArrowRight: 5, ArrowDown: -5, ArrowLeft: -5 }[e.key]; if (d) { e.preventDefault(); fset(fval + d, true); } });
  fset(fval, false);
  const meter = h('canvas', { class: 'fx-meter', role: 'img', 'aria-label': 'Output level' });
  const side = h('div', { class: 'fx-side fx-panel' }, fader, h('div', { class: 'fx-m-wrap' }, h('div', { class: 'fx-f-name' }, 'LEVEL'), meter));

  // ── switches ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const togs = {};
  const tog = (id, label, aria, on_, short) => { const b = h('button', { class: 'fx-tog', type: 'button', 'data-id': id, 'data-lock-ok': true, 'aria-pressed': 'false', 'aria-label': aria, onclick: () => { haptic(5); on_(); } }, h('span', { class: 'fx-led', 'aria-hidden': 'true' }), h('span', { class: 'l' }, label), h('span', { class: 's' }, short || label)); togs[id] = b; return b; };
  const switches = h('div', { class: 'fx-switches fx-panel fx-seg', role: 'group', 'aria-label': 'Switches' },
    tog('latch', 'LATCH', 'Latch: tap a pad to switch an effect on, tap again to switch it off', () => ctl.setParam('root', 'latch', !ctl.state.latch)),
    tog('ring', 'RING', 'Light ring around the platter', () => { ctl.setParam('root', 'ring', !ctl.state.ring); ringKey = ''; padKey = ''; }),
    tog('half', '½× TEMPO', 'Halve the tempo', () => ctl.setParam('root', 'bpmScale', ctl.state.bpmScale === 0.5 ? 1 : 0.5), '½×'),
    tog('double', '2× TEMPO', 'Double the tempo', () => ctl.setParam('root', 'bpmScale', ctl.state.bpmScale === 2 ? 1 : 2), '2×'),
    tog('resume', 'RESTART', 'Beat repeat: go back to the start of the slice when released instead of keeping time', () => ctl.setParam('repeat', 'resume', ctl.state.repeat.resume === 'capture' ? 'time' : 'capture'), 'RESTART'));

  on(togs.resume, 'click', () => { if (togs.resume.classList.contains('dim')) note('RESTART only applies to Beat repeat: pick it in the rack.'); });

  // ── pad grid ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const padBtns = [];
  let held = null;          // { i, pointerId, released }
  let owner = null;         // the press that engaged the effect that is sounding now: a delayed keyUp may only end ITS OWN engagement (per-press token)
  const padSel = (p) => ctl.mode === p.mode && (!p.div || curDivFor(p.mode) === p.div);
  const curDivFor = (m) => (m === 'stutter' ? ctl.state.stutter.div : m === 'echo' ? ctl.state.echo.delayDiv : ctl.state.repeat.div);
  const endOwn = (me) => { if (owner === me && ctl.engaged) { owner = null; ctl.keyUp(); } };
  async function padDown(i, pid) {
    if (held || idleKind || !allowsGesture('fx-pad')) return;
    const p = PADS[i]; held = { i, pointerId: pid, released: false }; const me = held;
    padBtns[i].classList.add('down'); haptic(12);
    try { await api.resume(); } catch { /* */ }
    if (me.released && held && held !== me) return;   // a quick tap that another pad has already replaced: do nothing (never touch its effect)
    if (ctl.state.latch && ctl.engaged && padSel(p)) { ctl.release(); owner = null; finishPad(me); return; }
    ctl.release(); ctl.setMode(p.mode); if (p.div) ctl.setDivision(p.div);
    ctl.keyDown(padSurface(), performance.now()); owner = me;
    if (me.released && !ctl.state.latch) setTimeout(() => endOwn(me), 90);
  }
  function finishPad(me) { if (held === me) held = null; padBtns.forEach((b) => b.classList.remove('down')); }
  function padUpFn(pid) {
    if (!held || (pid != null && held.pointerId !== pid)) return;
    const me = held; me.released = true;
    padBtns.forEach((b) => b.classList.remove('down'));
    if (!ctl.state.latch) { held = null; if (ctl.engaged && owner === me) endOwn(me); else setTimeout(() => endOwn(me), 120); } else held = null;
  }
  const padGrid = h('div', { class: 'fx-pads fx-panel', role: 'group', 'aria-label': 'Performance pads' },
    ...PADS.map((p, i) => {
      const b = h('button', { class: 'fx-perf', type: 'button', 'aria-pressed': 'false', 'data-mode': p.mode, 'data-div': p.div || '', style: `--c:${colour(p.mode)}`, 'aria-label': `${p.top} ${p.div || p.big}` },
        h('span', { class: 'fx-perf-l' }, p.top), h('span', { class: 'fx-perf-v' }, p.div || p.big), h('span', { class: 'fx-led', 'aria-hidden': 'true' }));
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch { /* */ } padDown(i, e.pointerId); });
      for (const t of ['pointerup', 'pointercancel']) b.addEventListener(t, (e) => padUpFn(e.pointerId));
      b.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); padDown(i, 'key'); } });
      b.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); padUpFn('key'); } });
      padBtns.push(b); return b;
    }));

  screen.append(deck, rack, plate, side, switches, knobRow, padGrid);

  // ── idle / blocked ──────────────────────────────────────────────────────────────────────────────────────────────────
  let idleKind = '', idleGo = null;
  function goIdle() { if (idleGo && api.goto) api.goto(idleGo); else if (api.close) api.close(); }
  function setIdle(kind) {
    if (kind === idleKind) return;
    idleKind = kind; screen.classList.toggle('is-idle', !!kind); idle.classList.toggle('hidden', !kind);
    if (!kind) return;
    if (kind === 'norecord') { idleT.textContent = 'Nothing on the deck'; idleS.textContent = 'Play a record on Albums first. The Booth works on whatever is spinning.'; idleBtn.textContent = 'Go to Albums'; idleGo = 'albums'; idleBtn.hidden = !(api.goto || api.close); }
    else { const b = BLOCK[kind]; idleT.textContent = b.text; idleS.textContent = b.hint; idleBtn.textContent = b.label; idleGo = b.go; idleBtn.hidden = !api.goto; }
    if (ctl.engaged) ctl.release();
  }

  // ── waveform ─────────────────────────────────────────────────────────────────────────────────────────────────────────
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
    for (let i = 0; i < cols; i++) { const a = Math.max(1.2, c[i] * (hh * 0.46)); g.globalAlpha = 0.9; g.fillRect(i * bw + 0.6, hh / 2 - a, Math.max(1, bw - 1.2), a * 2); }
    return cv;
  }
  function drawWave() {
    if (!wave.isConnected || !wave.clientWidth) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, wave.clientWidth), hh = Math.max(1, wave.clientHeight);
    const env = api.host.envelope();
    const key = `${w}x${hh}@${dpr}|${api.host.durationSec()}|${env ? env.length : 0}|${env ? env[env.length >> 1] : 0}`;
    if (wave.width !== Math.round(w * dpr)) { wave.width = Math.round(w * dpr); wave.height = Math.round(hh * dpr); }
    if (key !== waveKey) { waveKey = key; waveBitmap = env ? bakeWave(w, hh, env, dpr) : null; }
    const g = wave.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, wave.width, wave.height);
    if (waveBitmap) g.drawImage(waveBitmap, 0, 0);
    g.scale(dpr, dpr);
    if (!env) { g.fillStyle = 'rgba(232,232,240,.18)'; g.fillRect(0, hh / 2 - 0.5, w, 1); return; }
    const T = api.host.durationSec(), t = api.host.positionSec();
    const o = ctl.out.readout;
    if ((ctl.mode === 'repeat' || ctl.mode === 'stutter') && ctl.engaged && o.sliceMs) {
      const sp = sliceSpan(ctl.hold.capT || t, o.sliceMs / 1000, T, ctl.mode);
      if (sp) { g.fillStyle = 'rgba(255,107,94,.34)'; g.fillRect(sp[0] * w, 0, Math.max(2, (sp[1] - sp[0]) * w), hh); }
    }
    const x = playheadFrac(t, T) * w;
    g.fillStyle = '#fff'; g.fillRect(Math.round(x) - 1, 0, 2, hh);
    g.fillStyle = cssVar('--violet', '#8E7BFF'); g.beginPath(); g.arc(x, 3.5, 3.5, 0, Math.PI * 2); g.fill();
  }

  // ── level meter (a read-only analyser on the music bus: it feeds nothing, so FX-off stays byte-identical) ──────────
  let analyser = null, meterBuf = null, level = 0, peak = 0, peakT = 0;
  function ensureAnalyser() {
    if (analyser || !api.engine.ctx) return;
    try { analyser = api.engine.ctx.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = 0; meterBuf = new Float32Array(analyser.fftSize); api.engine.musicBus.connect(analyser); } catch { analyser = null; }
  }
  function dropAnalyser() { if (!analyser) return; try { api.engine.musicBus.disconnect(analyser); } catch { /* */ } try { analyser.disconnect(); } catch { /* */ } analyser = null; }
  const SEG = 14;
  function drawMeter(now, dt) {
    if (!meter.isConnected || !meter.clientWidth) return;
    let pk = 0;
    if (analyser) { analyser.getFloatTimeDomainData(meterBuf); for (let i = 0; i < meterBuf.length; i++) { const a = Math.abs(meterBuf[i]); if (a > pk) pk = a; } }
    const db = pk > 1e-5 ? 20 * Math.log10(pk) : -90;
    const target = clamp((db + 54) / 54, 0, 1);
    level = target > level ? target : level - dt * 1.4; level = Math.max(level, target);
    if (target >= peak) { peak = target; peakT = now; } else if (now - peakT > 700) peak = Math.max(target, peak - dt * 0.9);
    const dpr = Math.min(window.devicePixelRatio || 1, 2), w = meter.clientWidth, hh = meter.clientHeight;
    if (meter.width !== Math.round(w * dpr) || meter.height !== Math.round(hh * dpr)) { meter.width = Math.round(w * dpr); meter.height = Math.round(hh * dpr); }
    const g = meter.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, hh);
    const gap = 2, sh = (hh - gap * (SEG - 1)) / SEG, lit = Math.round(level * SEG), pkSeg = Math.min(SEG - 1, Math.round(peak * SEG) - 1);
    for (let i = 0; i < SEG; i++) {
      const y = hh - (i + 1) * sh - i * gap, hot = i >= SEG - 2, mid = i >= SEG - 5;
      const col = hot ? '#ff5a4d' : mid ? '#ffc23e' : '#43e08f';
      g.fillStyle = col; g.globalAlpha = i < lit || i === pkSeg ? 1 : 0.14;
      g.beginPath(); g.roundRect ? g.roundRect(0, y, w, sh, 2) : g.rect(0, y, w, sh); g.fill();
    }
    g.globalAlpha = 1;
  }

  // ── plate drawing ────────────────────────────────────────────────────────────────────────────────────────────────────
  let ringKey = '', padKey = '', frameN = 0;
  const rr = (g, x, y, w, hh, r) => { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, hh, r); else g.rect(x, y, w, hh); };
  function drawPad(now) {
    if (!pad.isConnected || pad.clientWidth === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), s = pad.clientWidth;
    if (pad.width !== Math.round(s * dpr)) { pad.width = Math.round(s * dpr); pad.height = Math.round(s * dpr); padKey = ''; }
    const st = ctl.ring();
    const hold = ctl.hold, eng = ctl.engaged, m = ctl.mode;
    const R = s / 2;
    const fa = eng ? hold.angle : null;
    const div = hold.engaged && hold.div ? hold.div : curDivFor(m);
    const key = ringSignature(st, R, R, R * 0.93, fa, now) + `|${eng}|${hold.x.toFixed(2)}|${hold.y.toFixed(2)}|${hold.u.toFixed(2)}|${m}|${div}|${idleKind}|${ctl.blockedReason ? 1 : 0}|${ctl.state.latch ? 1 : 0}`;
    if (key === padKey && !st.rotate) return;
    padKey = key;
    const col = colour(m), colSoft = `hsl(${hue(m)} 88% 64% / .55)`;
    const g = padG; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, s, s);
    // glass
    const bg = g.createLinearGradient(0, 0, 0, s); bg.addColorStop(0, '#0b0b12'); bg.addColorStop(1, '#040407');
    g.fillStyle = bg; rr(g, 0.5, 0.5, s - 1, s - 1, 18); g.fill();
    g.save(); rr(g, 0.5, 0.5, s - 1, s - 1, 18); g.clip();
    // grid
    g.strokeStyle = 'rgba(255,255,255,.055)'; g.lineWidth = 1;
    for (let i = 1; i < 8; i++) { const p = Math.round((s * i) / 8) + 0.5; g.beginPath(); g.moveTo(p, 0); g.lineTo(p, s); g.moveTo(0, p); g.lineTo(s, p); g.stroke(); }
    g.strokeStyle = 'rgba(255,255,255,.14)'; g.beginPath(); g.moveTo(R, 10); g.lineTo(R, s - 10); g.moveTo(10, R); g.lineTo(s - 10, R); g.stroke();
    const rIn = R * 0.1, rOut = R * 0.96, span = rOut - rIn;
    const radial = m === 'repeat' || m === 'stutter';
    if (radial) {
      // slice zones: inner = 1/16 ... outer = 1/1 (the same zones the finger steps through)
      const n = DIVISIONS.length, zw = (GK.divOuter - GK.divInner) / n;
      for (let i = 0; i < n; i++) {
        const dv = DIVISIONS[n - 1 - i];
        const u0 = GK.divInner + zw * (n - 1 - i), u1 = u0 + zw;
        const r0 = rIn + span * (i === n - 1 ? 0 : u0), r1 = rIn + span * (i === 0 ? 1 : u1);
        g.beginPath(); g.arc(R, R, r1, 0, Math.PI * 2); if (r0 > 1) g.arc(R, R, r0, 0, Math.PI * 2, true);
        g.fillStyle = dv === div ? `hsl(${hue(m)} 88% 64% / ${eng ? 0.26 : 0.14})` : 'rgba(255,255,255,0)'; g.fill();
        g.strokeStyle = dv === div ? colSoft : 'rgba(255,255,255,.13)'; g.lineWidth = dv === div ? 1.6 : 1; g.beginPath(); g.arc(R, R, r1, 0, Math.PI * 2); g.stroke();
        g.fillStyle = dv === div ? '#fff' : 'rgba(232,232,240,.5)'; g.font = `700 ${clamp(s * 0.034, 8, 11)}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(dv, R + (r0 + r1) / 2, R + 1);
      }
    } else if (m === 'bandpass') {
      // resonance curve at the finger: centre frequency across, narrower upward
      const px = eng ? hold.x : 0, q = eng ? (hold.y + 1) / 2 : 0.4;
      const cxp = R + px * R * 0.9, wdt = s * (0.34 - 0.27 * q), base = s * 0.9, pk = s * (0.28 + 0.12 * (1 - q));
      g.beginPath(); g.moveTo(0, base);
      for (let x = 0; x <= s; x += 3) { const d = (x - cxp) / wdt; g.lineTo(x, base - (base - pk) * Math.exp(-d * d)); }
      g.lineTo(s, base); g.closePath(); g.fillStyle = `hsl(${hue(m)} 88% 64% / ${eng ? 0.2 : 0.08})`; g.fill(); g.strokeStyle = eng ? col : colSoft; g.lineWidth = 1.5; g.stroke();
    } else if (m === 'echo') {
      // ripples: more feedback = more repeats
      const px = eng ? R + hold.x * R * 0.9 : R, py = eng ? R - hold.y * R * 0.9 : R, fb = eng ? (hold.y + 1) / 2 : 0.4;
      const n = 2 + Math.round(fb * 4);
      for (let i = 1; i <= n; i++) { g.strokeStyle = `hsl(${hue(m)} 88% 64% / ${(eng ? 0.5 : 0.18) * (1 - (i - 1) / (n + 1))})`; g.lineWidth = 1.5; g.beginPath(); g.arc(px, py, i * s * 0.07 * (0.6 + (eng ? (hold.x + 1) / 2 : 0.4)), 0, Math.PI * 2); g.stroke(); }
    } else {
      g.strokeStyle = 'rgba(255,255,255,.08)';
      for (let r = R * 0.2; r < R * 0.95; r += R * 0.15) { g.beginPath(); g.arc(R, R, r, 0, Math.PI * 2); g.stroke(); }
    }
    // puck
    let px, py;
    if (eng) {
      px = isPadMode(m) ? R + hold.x * rOut : R + Math.cos(hold.angle) * (rIn + hold.u * span);
      py = isPadMode(m) ? R - hold.y * rOut : R + Math.sin(hold.angle) * (rIn + hold.u * span);
    } else { px = R; py = radial ? R - (rIn + 0.55 * span) : R; }
    if (m !== 'scratch' && m !== 'blend' && !idleKind) {
      const pr = Math.max(13, s * 0.055);
      if (eng) {
        const gl = g.createRadialGradient(px, py, 0, px, py, pr * 3.2); gl.addColorStop(0, `hsl(${hue(m)} 95% 70% / .8)`); gl.addColorStop(1, `hsl(${hue(m)} 95% 70% / 0)`);
        g.fillStyle = gl; g.beginPath(); g.arc(px, py, pr * 3.2, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#10101a'; g.beginPath(); g.arc(px, py, pr, 0, Math.PI * 2); g.fill();
        g.strokeStyle = col; g.lineWidth = 3; g.stroke();
        g.fillStyle = '#fff'; g.beginPath(); g.arc(px, py, pr * 0.32, 0, Math.PI * 2); g.fill();
      } else {
        g.setLineDash([4, 5]); g.strokeStyle = colSoft; g.lineWidth = 1.5; g.beginPath(); g.arc(px, py, pr, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
        g.fillStyle = 'rgba(232,232,240,.55)'; g.font = '700 10px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(ctl.state.latch ? 'TAP' : 'HOLD', px, py);
      }
    }
    g.restore();
    // light ring (inside the plate, radial modes) and border
    if (radial || eng) drawRing(g, s, s, R, R, R * 0.93, st, { t: now, fingerAngle: fa, shimmer: !reducedQ.matches, clear: false });
    g.strokeStyle = eng ? col : 'rgba(255,255,255,.16)'; g.lineWidth = eng ? 2 : 1; rr(g, 0.5, 0.5, s - 1, s - 1, 18); g.stroke();
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

  // ── live refresh (readouts, LEDs, knob positions) ───────────────────────────────────────────────────────────────────
  let lastDeck = '';
  function refreshDeck() {
    const np = api.host.nowPlaying();
    const k = np ? `${np.title}|${np.sub}|${np.kind}|${np.playing}|${np.rpm}` : '';
    if (k !== lastDeck) {
      lastDeck = k;
      deckT.textContent = np ? np.title : 'Empty deck';
      deckS.textContent = np ? [np.kind === 'cd' ? 'CD' : `VINYL ${np.rpm ? Math.round(np.rpm * 10) / 10 : ''}`.trim(), np.sub].filter(Boolean).join(' · ') : 'Nothing loaded';
      disc.dataset.kind = np ? np.kind : 'none'; disc.classList.toggle('spin', !!(np && np.playing));
      disc.style.setProperty('--spin', `${np && np.rpm ? 60 / np.rpm : 1.8}s`);
    }
  }
  function refresh() {
    const kind = ctl.blockedReason ? (api.host.blockedRaw() in BLOCK ? api.host.blockedRaw() : 'radio') : !api.host.hasRecord() ? 'norecord' : '';
    setIdle(kind);
    const o = ctl.out.readout, m = ctl.mode, why = ctl.blockedReason;
    rackBtns.forEach((b) => {
      const sel = b.dataset.id === m; b.setAttribute('aria-selected', String(sel));
      b.classList.toggle('lit', sel && !idleKind); b.classList.toggle('live', sel && ctl.engaged);
    });
    pLive.textContent = idleKind ? 'OFF' : m === 'scratch' ? 'NORMAL' : ctl.engaged ? 'LIVE' : 'ARMED';
    pLive.classList.toggle('off', !!idleKind || m === 'scratch'); pLive.classList.toggle('on', ctl.engaged);
    pLive.style.setProperty('--c', colour(m));
    plate.style.setProperty('--c', colour(m)); plate.dataset.mode = m; plate.classList.toggle('live', ctl.engaged);
    pDiv.classList.toggle('sm', !(m === 'repeat' || m === 'stutter'));
    pDiv.textContent = why ? '' : o.division && (m === 'repeat' || m === 'stutter') ? o.division : (m === 'blend' || m === 'bandpass' || m === 'echo') ? (o.text || '') : modeInfo(m).label;
    pPct.textContent = m === 'repeat' && o.percent != null && !why ? formatPercent(o.percent) : m === 'stutter' && !why ? `gate ${Math.round(ctl.state.stutter.gate * 100)}%` : '';
    const beat = ctl.tempoState === 'analysing' ? 'Listening for the tempo…' : beatLabel(ctl.beat);
    pSub.textContent = m === 'repeat' || m === 'stutter' ? `${needsTempo(m) ? beat : ''}${o.sliceMs ? ` · loops ${Math.round(o.sliceMs)} ms` : ''}` : needsTempo(m) ? beat : '';
    const ax = AXES[m];
    axX.textContent = ax ? ax.x : (HINTS[m] || ''); axY.textContent = ax ? ax.y : ''; axY.style.display = ax ? '' : 'none';
    plate.classList.toggle('xy', !!ax);
    deckBpm.textContent = needsTempo(m) || ctl.tempo ? `${Math.round(ctl.beat.bpm)}` : '—';
    deckBpm.dataset.u = ctl.beat.fixed ? 'STEADY BPM' : 'BPM';
    const b = (id, v, dis) => { const e = togs[id]; e.setAttribute('aria-pressed', String(!!v)); e.classList.toggle('dim', !!dis); };
    b('latch', ctl.state.latch); b('ring', ctl.state.ring); b('half', ctl.state.bpmScale === 0.5); b('double', ctl.state.bpmScale === 2); b('resume', ctl.state.repeat.resume === 'capture', m !== 'repeat');
    // knobs + fader follow the state; the ones that do nothing in this mode are dimmed
    const divMode = m === 'repeat' || m === 'stutter' || m === 'echo';
    knobs.fxKBeat.set(DIVISIONS.indexOf(ctl.hold.engaged && ctl.hold.div ? ctl.hold.div : curDiv()));
    knobs.fxKGate.set(Math.round(ctl.state.stutter.gate * 100)); knobs.fxKRoom.set(Math.round(ctl.state.echo.balance * 100));
    if (!fdrag) fset(Math.round(ctl.state.blend.amount * 100), false);
    knobs.fxKBeat.el.classList.toggle('dim', !divMode); knobs.fxKGate.el.classList.toggle('dim', m !== 'stutter'); knobs.fxKRoom.el.classList.toggle('dim', m !== 'echo');
    fader.classList.toggle('dim', m !== 'blend');
    knobs.fxKBeat.el.dataset.owner = m === 'stutter' ? 'stutter' : m === 'echo' ? 'echo' : 'repeat';
    knobs.fxKBeat.el.style.setProperty('--c', colour(knobs.fxKBeat.el.dataset.owner));
    padBtns.forEach((e, i) => { const sel = padSel(PADS[i]); e.classList.toggle('sel', sel && !idleKind); const pr = sel && ctl.engaged; e.setAttribute('aria-pressed', String(pr)); e.classList.toggle('live', pr); });
    // stage HUD
    const showHud = !why && ctl.engaged && m !== 'scratch';
    hud.classList.toggle('hidden', !showHud);
    if (showHud) { hudM.textContent = modeInfo(m).label; hudD.textContent = (m === 'repeat' || m === 'stutter') ? o.division : ''; hudP.textContent = m === 'repeat' && o.percent != null ? formatPercent(o.percent) : (m === 'repeat' || m === 'stutter') ? '' : o.text; }
  }
  const unsub = ctl.onChange(() => refresh());

  // ── frame loop ───────────────────────────────────────────────────────────────────────────────────────────────────────
  let shown = false, aod = false, raf = 0, lastT = 0, lastTrack = api.host.getTrack();
  const loop = (now) => {
    if (!shown) return;
    const dt = lastT ? Math.min(0.05, Math.max(0.001, (now - lastT) / 1000)) : 0.016; lastT = now;
    const tr = api.host.getTrack();
    if (tr !== lastTrack) { lastTrack = tr; handle.onTrack(); }          // a record / tape was loaded by someone else: nothing survives it
    ctl.tick(dt, now);
    frameN++;
    if (!aod && frameN % 2 === 0) { drawStageRing(now); drawWave(); drawPad(now); drawMeter(now, dt * 2); refresh(); if (frameN % 16 === 0) refreshDeck(); }
    raf = requestAnimationFrame(loop);
  };
  const setOverlays = (v) => { ringCv.style.display = v ? '' : 'none'; if (!v) hud.classList.add('hidden'); };
  const handle = {
    controller: ctl, bus,
    onShow() { if (shown) return; shown = true; lastT = 0; ringKey = ''; padKey = ''; waveKey = ''; ensureAnalyser(); if (api.host.getTrack() !== lastTrack) { lastTrack = api.host.getTrack(); handle.onTrack(); } setOverlays(true); refresh(); refreshDeck(); raf = requestAnimationFrame(loop); },
    onHide() { if (!shown) return; shown = false; cancelAnimationFrame(raf); ctl.release(); held = null; owner = null; padBtns.forEach((b) => b.classList.remove("down")); setOverlays(false); dropAnalyser(); },
    /** device mode AOD: no ring / wave / plate / meter drawing while on (the controller keeps ticking; nothing is released) */
    setAod(on) { aod = !!on; ringKey = ''; waveKey = ''; padKey = ''; screen.classList.toggle('is-aod', aod); },   // `on` here is the argument, not the listener helper
    onTrack() { ctl.onTrack(); waveKey = ''; lastDeck = ''; refreshDeck(); refresh(); },
    platter: {
      wantsPlatter: () => shown && ctl.wantsPlatter(),
      grabsPlatter: () => ctl.grabsPlatter(),
      pointerDown: (p, s, t) => ctl.pointerDown(p, s, t),
      pointerMove: (p, t) => ctl.pointerMove(p, t),
      pointerUp: () => ctl.pointerUp(),
      rateFor: (r) => ctl.rateFor(r),
    },
    unmount() {
      shown = false; cancelAnimationFrame(raf); clearTimeout(flashTimer);
      unsub(); ctl.dispose(); dropAnalyser();
      for (const f of cleanup.splice(0)) f();
      ringCv.remove(); hud.remove(); root.replaceChildren(); root.classList.remove('fx-root');
      try { if (globalThis.__runoutFx === handle) globalThis.__runoutFx = null; } catch { /* */ }
    },
  };
  try { globalThis.__runoutFx = handle; } catch { /* test hook only */ }
  if (ctl.mode === 'blend' && !api.hasPlatter) ctl.setMode('scratch');   // Blend scratch needs the platter
  if (ctl.mode !== 'scratch') ctl.ensureTempo();
  refresh(); refreshDeck();
  return handle;
}
