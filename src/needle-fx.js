// needle-fx.js — tiny synthesized tonearm sounds (browser glue, no samples).
// A lift is a soft click + a breath of low rumble; a set-down is a body thump
// plus a bright stylus tick and a short burst of groove hiss that settles.
// Played on the page's AudioContext, separate from the worklet music bus, so
// the "silence while lifted" behaviour is untouched. Levels are knobs below.

export const NEEDLE_FX = Object.freeze({
  liftLevel: 0.07,
  dropLevel: 0.16,
  hissLevel: 0.03,   // groove hiss burst right after a set-down
});

export class NeedleFX {
  constructor(ctx) {
    this.ctx = ctx;
    this._noise = null;
  }

  _noiseBuf() {
    if (!this._noise) {
      const n = Math.floor(this.ctx.sampleRate * 0.4);
      const b = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      this._noise = b;
    }
    return this._noise;
  }

  _burst({ at, dur, freq, q, gain, type = 'bandpass' }) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this._noiseBuf();
    const f = c.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f); f.connect(g); g.connect(c.destination);
    src.start(at, Math.random() * 0.2, dur + 0.02);
  }

  _thump({ at, freq, dur, gain }) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq * 1.8, at);
    o.frequency.exponentialRampToValueAtTime(freq, at + 0.03);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(c.destination);
    o.start(at); o.stop(at + dur + 0.02);
  }

  lift() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    this._burst({ at: t, dur: 0.05, freq: 2600, q: 1.2, gain: NEEDLE_FX.liftLevel });
    this._thump({ at: t, freq: 70, dur: 0.12, gain: NEEDLE_FX.liftLevel * 0.8 });
  }

  drop() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    this._thump({ at: t, freq: 55, dur: 0.18, gain: NEEDLE_FX.dropLevel });
    this._burst({ at: t, dur: 0.035, freq: 3800, q: 0.9, gain: NEEDLE_FX.dropLevel * 0.7 });
    this._burst({ at: t + 0.012, dur: 0.22, freq: 5500, q: 0.5, gain: NEEDLE_FX.hissLevel, type: 'highpass' });
  }
}
