// ─────────────────────────────────────────────────────────────────────────────
// controller.js — FX glue with NO DOM: finger events in, worklet / bus commands out (everything decided by derive() in modes.js).
// Injected: engine { setFx(p) }, bus { apply(cmd), dispose() }, host { getTrack(), nominalRate(), omegaNominal(), blocked(), sampleRate() },
// storage (optional). Time is passed in (ms) so tests are deterministic.
// ─────────────────────────────────────────────────────────────────────────────

import { derive, defaultFx, setMode, setParam, holdsPlatter, isPadMode, modeInfo } from './modes.js';
import { loadFx, saveFx } from './persist.js';
import { beatInfo, stepDivision } from './divisions.js';
import { estimateTempo } from './tempo.js';
import { GESTURE_KNOBS as K, clamp, padFromPoint, divisionFromDrag, smooth, spinRelative } from './gesture.js';
import { ringStyle, ringSpeed } from './ring.js';

const TAU = Math.PI * 2;
const angleDelta = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };

export class FxController {
  constructor({ engine, bus, host, storage = null, reducedMotion = () => false }) {
    this.engine = engine; this.bus = bus; this.host = host; this.storage = storage; this.reducedMotion = reducedMotion;
    this.state = loadFx(storage);
    this.tempo = null;                 // { bpm, confidence } from the estimator, or null
    this.tempoState = 'idle';          // idle | analysing | done
    this._tempoCache = new WeakMap();
    this.hold = { engaged: false, latched: false, pointer: false, div: null, div0: null, u0: 0.5, u: 0.5, x: 0, y: 0, angle: 0, lastT: 0, lastMoveT: -1e9, lastP: null, rawV: 0, rawSpin: 0, spin: 0, capT: 0 };
    this.blockedReason = null;
    this.out = derive(this.state, this._rt());
    this._lastKey = ''; this._listeners = new Set(); this._disposed = false;
    this.surface = null;
    this._ringSpeed = 0;
  }

  // ── subscriptions ───────────────────────────────────────────────────────────────────────────────────────────────────
  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit() { for (const f of this._listeners) { try { f(this); } catch { /* a bad listener must not break audio */ } } }

  // ── derived runtime ──────────────────────────────────────────────────────────────────────────────────────────────────
  get beat() { return beatInfo(this.tempo, { scale: this.state.bpmScale }); }
  _rt() {
    const h = this.hold;
    return { engaged: h.engaged && !this.blockedReason, blocked: !!this.blockedReason, u: h.u, x: h.x, y: h.y, spin: h.spin,
      div: h.div, beat: this.beat, sampleRate: this.host.sampleRate(), nominalRate: this.host.nominalRate() };
  }
  get mode() { return this.state.mode; }
  get info() { return modeInfo(this.state.mode); }
  get engaged() { return this.hold.engaged && !this.blockedReason; }

  // ── state changes (all persisted) ────────────────────────────────────────────────────────────────────────────────────
  _commit(next) { this.state = next; saveFx(next, this.storage); this._push(true); this._emit(); }
  setMode(id) {
    if (id === this.state.mode) return;
    this.release();
    this._commit(setMode(this.state, id));
    if (this.mode !== 'scratch') this.ensureTempo();
  }
  setParam(group, key, value) { this._commit(setParam(this.state, group, key, value)); }
  /** Division chips / keys: set the stored division of the current mode (and the one in force if we are holding). */
  setDivision(div) {
    const m = this.state.mode;
    if (m === 'repeat' || m === 'stutter') { this.state = setParam(this.state, m, 'div', div); this.hold.div = this.state[m].div; this.hold.div0 = this.hold.div; this.hold.u0 = this.hold.u; }
    else if (m === 'echo') this.state = setParam(this.state, 'echo', 'delayDiv', div);
    saveFx(this.state, this.storage); this._push(true); this._emit();
  }
  nudgeDivision(dir) { const m = this.state.mode; const cur = this.hold.engaged && this.hold.div ? this.hold.div : (m === 'repeat' ? this.state.repeat.div : m === 'stutter' ? this.state.stutter.div : this.state.echo.delayDiv); this.setDivision(stepDivision(cur, dir)); }

  // ── owner / blocked ─────────────────────────────────────────────────────────────────────────────────────────────────
  /** Called every frame and on demand: a radio station / mixtape that owns the engine switches FX off with a plain message. */
  refreshBlocked() {
    const r = this.host.blocked() || null;
    if (r !== this.blockedReason) {
      this.blockedReason = r;
      if (r) { this.hold.engaged = false; this.hold.pointer = false; this.hold.latched = false; }
      this._push(true); this._emit();
    }
    return r;
  }

  // ── tempo ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  ensureTempo() {
    const tr = this.host.getTrack();
    if (!tr || !tr.channels) { this.tempo = null; this.tempoState = 'done'; return; }
    if (this._tempoCache.has(tr)) { this.tempo = this._tempoCache.get(tr); this.tempoState = 'done'; this._emit(); return; }
    this.tempoState = 'analysing'; this._emit();
    const run = () => {
      if (this._disposed || this.host.getTrack() !== tr) return;
      const t = estimateTempo(tr.channels, tr.frames, this.host.sampleRate());
      this._tempoCache.set(tr, t); this.tempo = t; this.tempoState = 'done'; this._push(true); this._emit();
    };
    (this.host.defer || ((f) => setTimeout(f, 30)))(run);
  }

  /** A new record / tape was loaded: nothing survives it. */
  onTrack() {
    this.release(); this.tempo = null; this.tempoState = 'idle';
    this.engine.setFx(derive(defaultFx(), this._rt()).worklet);
    if (this.state.mode !== 'scratch') this.ensureTempo();
    this._emit();
  }

  // ── pointer interface ───────────────────────────────────────────────────────────────────────────────────────────────
  /** Should main.js route platter pointer events here? */
  wantsPlatter() { return this.state.mode !== 'scratch' && !this.refreshBlocked(); }
  /** Does the finger also "hold" the platter (the old scratch behaviour) in this mode? Blend and repeat/stutter keep the platter in hand; pads don't. */
  grabsPlatter() { return !isPadMode(this.state.mode); }
  /** Playback rate the engine should use this frame. Platter scratch normally; the normal rate while a hold / pad effect owns the finger. */
  rateFor(platterRate) {
    if (!this.engaged) return platterRate;
    const m = this.state.mode;
    return holdsPlatter(m) || isPadMode(m) ? this.host.nominalRate() : platterRate;
  }

  /** surface = { cx, cy, rIn, rOut } in the same coordinate space as the points. */
  pointerDown(p, surface, nowMs) {
    if (this.refreshBlocked()) return false;
    const h = this.hold; this.surface = surface;
    const m = this.state.mode;
    if (this.state.latch && h.engaged && h.latched) { this.release(); return true; }
    h.engaged = true; h.pointer = true; h.latched = !!this.state.latch;
    h.div = m === 'repeat' ? this.state.repeat.div : m === 'stutter' ? this.state.stutter.div : null; h.div0 = h.div;
    this._place(p, nowMs, true); h.u0 = h.u; h.rawSpin = 0; h.spin = 0; h.capT = this.host.positionSec ? this.host.positionSec() : 0;
    this._push(true); this._emit();
    return true;
  }
  pointerMove(p, nowMs) {
    if (!this.hold.engaged || !this.hold.pointer) return;
    this._place(p, nowMs, false);
  }
  /** -> { resetPlatter } : true when a hold effect just ended (main.js then puts the platter back to nominal speed). */
  pointerUp() {
    const h = this.hold; h.pointer = false;
    if (h.latched) return { resetPlatter: false };
    const was = h.engaged; this.release();
    return { resetPlatter: was && holdsPlatter(this.state.mode) };
  }
  release() {
    const h = this.hold;
    if (!h.engaged && !h.latched) return;
    h.engaged = false; h.latched = false; h.pointer = false; h.rawSpin = 0; h.spin = 0;
    this._push(true); this._emit();
  }

  _place(p, nowMs, first) {
    const h = this.hold, S = this.surface;
    const dx = p.x - S.cx, dy = p.y - S.cy, r = Math.hypot(dx, dy);
    if (!first && h.lastP) { const dt0 = Math.max(0.001, (nowMs - h.lastT) / 1000); h.rawV = Math.hypot(p.x - h.lastP.x, p.y - h.lastP.y) / dt0 / (S.rOut || 1); }
    h.lastP = { x: p.x, y: p.y };
    const span = S.rOut - S.rIn;
    h.u = span > 0 ? clamp((r - S.rIn) / span, 0, 1) : 0.5;
    const pad = padFromPoint(p.x, p.y, S.cx, S.cy, S.rOut);
    h.x = pad.x; h.y = pad.y;
    const ang = Math.atan2(dy, dx);
    if (!first && r > S.rIn * 0.25) {
      const dt = Math.max(0.001, (nowMs - h.lastT) / 1000);
      const w = clamp(angleDelta(h.angle, ang) / dt, -40, 40);
      h.rawSpin = spinRelative(w, this.host.omegaNominal());
      h.lastMoveT = nowMs;
    }
    h.angle = ang; h.lastT = nowMs;
    const m = this.state.mode;
    if ((m === 'repeat' || m === 'stutter') && h.div0) {
      const nd = divisionFromDrag(h.div0, h.u0, h.u, h.div);
      if (nd !== h.div) { h.div = nd; this.state = setParam(this.state, m, 'div', nd); saveFx(this.state, this.storage); this._emit(); }
    }
    this._push(false);
  }

  /** Keyboard / button "finger": press and hold at the pad centre; arrows nudge. */
  keyDown(surface, nowMs) { if (!this.engaged) this.pointerDown({ x: surface.cx, y: surface.cy - surface.rOut * 0.3 }, surface, nowMs); }
  keyUp() { this.pointerUp(); }
  nudge(dx, dy, nowMs) {
    const h = this.hold; if (!h.engaged || !this.surface) return;
    const S = this.surface, m = this.state.mode;
    if (m === 'repeat' || m === 'stutter') {
      if (dx) this.nudgeDivision(dx > 0 ? -1 : 1);                       // right = longer, left = shorter
      if (dy && m === 'repeat') { h.rawSpin = clamp(h.rawSpin + dy * 1.0, -3, 12); h.lastMoveT = nowMs; }
    } else {
      h.x = clamp(h.x + dx * 0.15, -1, 1); h.y = clamp(h.y + dy * 0.15, -1, 1);
    }
    this._push(false);
  }

  // ── per-frame ────────────────────────────────────────────────────────────────────────────────────────────────────────
  tick(dt, nowMs) {
    if (this._disposed) return;
    this.refreshBlocked();
    const h = this.hold;
    const moving = nowMs - h.lastMoveT < 90 || !h.pointer;                 // a resting finger measures 0 spin; keyboard "spin" persists until reset
    const target = h.pointer ? (moving ? h.rawSpin : 0) : h.rawSpin;
    h.spin = smooth(h.spin, target, dt, K.spinSmoothTau);
    const v = h.pointer && moving ? (h.rawV || 0) * 3 : 0;                    // hand travel (radius-lengths/s) also lights the ring in pad modes
    this._ringSpeed = smooth(this._ringSpeed, this.engaged ? ringSpeed(Math.max(Math.abs(h.spin), v)) : 0, dt, 0.08);
    this._push(false);
  }

  _push(force) {
    if (this._disposed) return;
    const d = derive(this.state, this._rt());
    this.out = d;
    const w = d.worklet;
    const key = `${w.mode}|${w.engage}|${w.len}|${w.rate.toFixed(3)}|${w.gate.toFixed(3)}|${w.amount.toFixed(3)}|${w.resume}`;
    if (force || key !== this._lastKey) { this._lastKey = key; this.engine.setFx(w); }
    this.bus.apply(d.bus);
  }

  /** The ring's current look (pure ringStyle over live values). */
  ring() {
    return ringStyle({ mode: this.state.mode, speed: this._ringSpeed, engaged: this.engaged, enabled: this.state.ring, reduced: this.reducedMotion(), blocked: !!this.blockedReason });
  }

  dispose() {
    if (this._disposed) return;
    this.release();
    this.engine.setFx(derive(defaultFx(), this._rt()).worklet);
    this.bus.dispose();
    this._disposed = true; this._listeners.clear();
  }
}
