// ─────────────────────────────────────────────────────────────────────────────
// bus.js — the FX effects bus: Web Audio chains inserted AFTER AudioEngine.musicBus (the same unity gain node the radio ducks).
//
//   FX off / no effect engaged:  musicBus -> destination            (exactly the original graph; this module has created NOTHING)
//   first time a bus effect is engaged:
//        musicBus -> dry(1) -> out(1) -> destination                 (a "hub" with unity gains: sample-identical to the direct link)
//        musicBus -> [effect chain] -> out                           (band pass, or echo + room)
//   effect released: ramp back to dry, tear the chain down (echo: after its tail rings out), restore musicBus -> destination.
//
// Everything audible moves through setTargetAtTime ramps (no zipper noise). The chain is built lazily, bounded in memory
// (one 1.6 s stereo impulse response, a 2 s delay line), and dispose() leaves the graph exactly as it found it.
// ─────────────────────────────────────────────────────────────────────────────

import { makeImpulseResponse, BUS_KNOBS as B } from './dsp.js';

const sleepers = { set: (f, ms) => setTimeout(f, ms), clear: (h) => clearTimeout(h) };

export class FxBus {
  /** engine: { ctx, musicBus }.  timers: injectable { set, clear } for tests. */
  constructor(engine, timers = sleepers) {
    this.engine = engine;
    this.t = timers;
    this.hub = null;       // { dry, out }
    this.chain = null;     // the live chain (band pass or echo)
    this.dying = new Set();
    this._ir = null;
  }

  get ctx() { return this.engine.ctx; }
  /** true while any FX node exists in the graph */
  get active() { return !!this.hub; }
  get kind() { return this.chain ? this.chain.kind : null; }

  /** Apply the `bus` part of derive(): { kind, engaged, freq, q, wet, feedback, delaySec, balance }. */
  apply(cmd) {
    if (!cmd || !cmd.kind) { if (this.chain) this._release(this.chain, true); return; }
    if (this.chain && this.chain.kind !== cmd.kind) this._release(this.chain, true);
    if (!this.chain) {
      if (!cmd.engaged) return;                      // nothing is built until the effect is first used
      this.chain = this._build(cmd.kind, cmd);
    }
    this.chain.set(cmd);
  }

  _ensureHub() {
    if (this.hub) return this.hub;
    const c = this.ctx, bus = this.engine.musicBus;
    const dry = c.createGain(), out = c.createGain();
    dry.gain.value = 1; out.gain.value = 1;
    bus.connect(dry); dry.connect(out); out.connect(c.destination);
    bus.disconnect(c.destination);                  // same task as the connects above: the swap lands in one render quantum
    this.hub = { dry, out };
    return this.hub;
  }

  _dropHub() {
    const h = this.hub; if (!h) return;
    const c = this.ctx, bus = this.engine.musicBus;
    bus.connect(c.destination);
    try { bus.disconnect(h.dry); } catch { /* */ }
    try { h.dry.disconnect(); h.out.disconnect(); } catch { /* */ }
    this.hub = null;
  }

  _build(kind, cmd) {
    const hub = this._ensureHub();
    const chain = kind === 'bandpass' ? this._bandpass(hub, cmd) : this._echo(hub, cmd);
    chain.kind = kind;
    return chain;
  }

  _bandpass(hub, cmd) {
    const c = this.ctx, bus = this.engine.musicBus;
    const bpf = c.createBiquadFilter(), wet = c.createGain();
    bpf.type = 'bandpass';
    bpf.frequency.value = cmd.freq; bpf.Q.value = cmd.q;
    wet.gain.value = 0;
    bpf.connect(wet); wet.connect(hub.out);
    let fed = false, engaged = false, timer = null;
    const self = {
      set: (m) => {
        const now = c.currentTime;
        if (m.engaged) {
          if (timer !== null) { this.t.clear(timer); timer = null; }
          if (!fed) {                                   // first moment of a hold: jump to the target, then open the path
            bpf.frequency.cancelScheduledValues(now); bpf.frequency.setValueAtTime(m.freq, now);
            bpf.Q.cancelScheduledValues(now); bpf.Q.setValueAtTime(m.q, now);
            bus.connect(bpf); fed = true;
          } else {
            bpf.frequency.setTargetAtTime(m.freq, now, B.rampTau);
            bpf.Q.setTargetAtTime(m.q, now, B.rampTau);
          }
          if (!engaged) { hub.dry.gain.setTargetAtTime(0, now, B.engageTau); wet.gain.setTargetAtTime(1, now, B.engageTau); engaged = true; }
        } else if (engaged) {
          engaged = false;
          hub.dry.gain.setTargetAtTime(1, now, B.engageTau); wet.gain.setTargetAtTime(0, now, B.engageTau);
          timer = this.t.set(() => { timer = null; this._release(self, false); }, 140);
        }
      },
      fade: () => { const now = c.currentTime; hub.dry.gain.setTargetAtTime(1, now, 0.01); wet.gain.setTargetAtTime(0, now, 0.01); },
      dispose: () => {
        if (timer !== null) { this.t.clear(timer); timer = null; }
        try { if (fed) bus.disconnect(bpf); } catch { /* */ }
        try { bpf.disconnect(); wet.disconnect(); } catch { /* */ }
        hub.dry.gain.value = 1;
      },
      fadeMs: 40,
    };
    return self;
  }

  _impulse() {
    if (!this._ir) {
      const c = this.ctx, d = makeImpulseResponse(c.sampleRate);
      const buf = c.createBuffer(2, d[0].length, c.sampleRate);
      buf.getChannelData(0).set(d[0]); buf.getChannelData(1).set(d[1]);
      this._ir = buf;
    }
    return this._ir;
  }

  _echo(hub, cmd) {
    const c = this.ctx, bus = this.engine.musicBus;
    const send = c.createGain(), delay = c.createDelay(B.maxDelay), damp = c.createBiquadFilter(), fb = c.createGain();
    const dWet = c.createGain(), conv = c.createConvolver(), rWet = c.createGain();
    send.gain.value = 0; fb.gain.value = Math.min(0.85, cmd.feedback); delay.delayTime.value = cmd.delaySec;
    damp.type = 'lowpass'; damp.frequency.value = B.damping;
    conv.buffer = this._impulse();
    dWet.gain.value = 0; rWet.gain.value = 0;
    bus.connect(send);
    send.connect(delay); delay.connect(damp); damp.connect(fb); fb.connect(delay);
    delay.connect(dWet); dWet.connect(hub.out);
    send.connect(conv); conv.connect(rWet); rWet.connect(hub.out);
    let tail = null, fadeT = null, held = false;
    const clearTimers = () => { if (tail !== null) { this.t.clear(tail); tail = null; } if (fadeT !== null) { this.t.clear(fadeT); fadeT = null; } };
    const levels = (m, now) => {
      const a = (m.balance ?? 0.5) * Math.PI / 2;
      dWet.gain.setTargetAtTime(Math.cos(a) * 0.9, now, B.rampTau);
      rWet.gain.setTargetAtTime(Math.sin(a) * 0.9, now, B.rampTau);
    };
    const self = {
      set: (m) => {
        const now = c.currentTime;
        fb.gain.setTargetAtTime(Math.min(0.85, Math.max(0, m.feedback)), now, B.rampTau);
        delay.delayTime.setTargetAtTime(Math.min(B.maxDelay - 0.05, Math.max(0.005, m.delaySec)), now, 0.06);   // slow: a tape-style glide, never a click
        levels(m, now);
        if (m.engaged) { clearTimers(); send.gain.setTargetAtTime(m.wet, now, B.rampTau); held = true; }
        else if (held) {
          held = false;
          send.gain.setTargetAtTime(0, now, B.rampTau);                                                           // the input closes; the tail keeps ringing
          clearTimers();
          fadeT = this.t.set(() => { fadeT = null; const n = c.currentTime; dWet.gain.setTargetAtTime(0, n, 0.12); rWet.gain.setTargetAtTime(0, n, 0.12); }, (B.tailSeconds - 0.4) * 1000);
          tail = this.t.set(() => { tail = null; this._release(self, false); }, B.tailSeconds * 1000);
        }
      },
      fade: () => { const n = c.currentTime; send.gain.setTargetAtTime(0, n, 0.01); dWet.gain.setTargetAtTime(0, n, 0.02); rWet.gain.setTargetAtTime(0, n, 0.02); },
      dispose: () => {
        clearTimers();
        try { bus.disconnect(send); } catch { /* */ }
        for (const n of [send, delay, damp, fb, dWet, conv, rWet]) { try { n.disconnect(); } catch { /* */ } }
      },
      fadeMs: 60,
    };
    return self;
  }

  /** Take a chain out of the graph. `fade`: ramp its wet path down first (mode change / close); otherwise it is already silent. */
  _release(chain, fade) {
    if (this.chain === chain) this.chain = null;
    const finish = () => { this.dying.delete(chain); chain.dispose(); if (!this.chain && this.dying.size === 0) this._dropHub(); };
    if (!fade) { finish(); return; }
    this.dying.add(chain);
    chain.fade();
    this.t.set(finish, chain.fadeMs + 30);
  }

  /** Remove every FX node and restore musicBus -> destination now. Safe to call twice. */
  dispose() {
    const all = [this.chain, ...this.dying].filter(Boolean);
    this.chain = null; this.dying.clear();
    for (const ch of all) ch.dispose();
    this._dropHub();
    this._ir = null;
  }
}
