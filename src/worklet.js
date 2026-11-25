// ─────────────────────────────────────────────────────────────────────────────
// worklet.js — the AudioWorklet that OWNS the read loop (spec §3).
//
// This is the crux of the whole app. Decoded PCM lives in a SharedArrayBuffer;
// this processor holds the one float `readPosition` (fractional sample index)
// that IS the playback position. Each output sample:  readPosition += rate,
// then sample the buffer by interpolation. Owning the loop here is the reason
// we do NOT use AudioBufferSourceNode: arbitrary rate — fractional, zero, and
// negative (true reverse) — falls out of one line.
//
// Runs in AudioWorkletGlobalScope: no DOM, no ES-module imports, no main thread.
// The control channel is a lock-free Float64 SAB (indices below MUST match
// control-layout.js). A non-SAB postMessage fallback is supported for
// environments without cross-origin isolation.
// ─────────────────────────────────────────────────────────────────────────────

// Control SAB indices — keep in sync with src/control-layout.js
const C_TARGET_RATE = 0; // main → worklet : desired playback rate
const C_READ_POS    = 1; // worklet → main : current readPosition (frames)
const C_SEEK_POS    = 2; // main → worklet : requested seek position (frames)
const C_SEEK_GEN    = 3; // main → worklet : bumped to request a seek
const C_SEEK_ACK     = 4; // worklet → main : last seek gen consumed
const C_PLAYING     = 5; // main → worklet : 1 = engine live, 0 = silent
// FX section (see control-layout.js). All zero = off: process() then runs the original loop below, untouched.
const C_FX_MODE = 8, C_FX_ENGAGE = 9, C_FX_LEN = 10, C_FX_RATE = 11, C_FX_GATE = 12, C_FX_AMOUNT = 13, C_FX_RESUME = 14;

class RunoutProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};

    this.channels = o.channels || 2;
    this.frames = o.frames || 0;
    // Planar PCM: channel c occupies [c*frames, (c+1)*frames) in the buffer.
    this.pcm = o.pcm ? new Float32Array(o.pcm) : new Float32Array(0);
    this.control = o.control ? new Float64Array(o.control) : null;

    this.readPosition = 0;   // the single source of truth for audio time
    this.currentRate = 0;    // slew-limited actual rate (kills zipper noise)
    this.targetRate = 0;
    this.playing = 1;
    this.lastSeekGen = 0;

    // FX state (src/fx). Inert while fxMode === 0 && fxMix === 0.
    this.fxMode = 0; this.fxEngage = 0; this.fxLen = 0; this.fxRate = 1; this.fxGate = 1; this.fxAmount = 0; this.fxResume = 0;
    this.fxMix = 0;          // wet amount, slewed
    this.fxCur = 0;          // the mode in force (kept while the mix ramps out after fxMode returns to 0)
    this.fxWas = 0;          // was engaged last block
    this.slStart = 0; this.slPhase = 0; this.slLen = 0; this.slOut = 0; this.slRate = 1; this.capPos = 0;
    this.wrapAge = 1e9; this.retAge = 1e9; this.firstPeriod = 0; this.underPos = 0;
    this.holdL = 0; this.holdR = 0; this.lastWetL = 0; this.lastWetR = 0;
    this.xfadeN = Math.max(8, Math.round(0.002 * sampleRate));          // 2 ms loop / retarget cross-fade
    this.gateRamp = Math.max(8, Math.round(0.0015 * sampleRate));       // 1.5 ms stutter attack / release
    this.mixCoef = 1 - Math.exp(-1 / (0.003 * sampleRate));
    this.rateCoef = 1 - Math.exp(-1 / (0.005 * sampleRate));

    // One-pole rate smoothing. tau is small — the platter inertia (§4) does most
    // of the smoothing physically; this is just a per-sample safety net so fast
    // rate changes don't click. Kept gentle to avoid adding perceptual latency.
    const tau = o.slewTau || 0.0015; // seconds
    this.slewCoeff = 1 - Math.exp(-1 / (tau * sampleRate));

    this.port.onmessage = (e) => this.onMessage(e.data);
    this._posReportCounter = 0;
  }

  onMessage(msg) {
    // postMessage fallback path (no SAB). The SAB path ignores all of this.
    if (msg.type === 'rate') this.targetRate = msg.value;
    else if (msg.type === 'seek') this.readPosition = msg.value;
    else if (msg.type === 'playing') this.playing = msg.value ? 1 : 0;
    else if (msg.type === 'fx') {
      this.fxMode = msg.mode | 0; this.fxEngage = msg.engage ? 1 : 0; this.fxLen = msg.len || 0; this.fxRate = msg.rate ?? 1;
      this.fxGate = msg.gate ?? 1; this.fxAmount = msg.amount || 0; this.fxResume = msg.resume ? 1 : 0;
    }
    else if (msg.type === 'free') { // gapless hook: drop the PCM so it can be collected
      this.pcm = new Float32Array(0); this.frames = 0; this.playing = 0; this.control = null;
    } else if (msg.type === 'pcm') {
      this.pcm = new Float32Array(msg.pcm);
      this.frames = msg.frames;
      this.channels = msg.channels;
      this.readPosition = 0;
    }
  }

  // 4-point cubic (Catmull-Rom / Hermite) interpolation. Linear is the floor;
  // this is meaningfully better for scrub fidelity (spec §3).
  sampleChannel(ch, pos) {
    const base = ch * this.frames;
    const n = this.frames;
    if (n === 0) return 0;
    if (pos >= n - 1) return 0;   // the runout: the needle at the very end reads silence, not the last sample held as DC
    const i = Math.floor(pos);
    const frac = pos - i;
    const i0 = clampIdx(i - 1, n);
    const i1 = clampIdx(i, n);
    const i2 = clampIdx(i + 1, n);
    const i3 = clampIdx(i + 2, n);
    const y0 = this.pcm[base + i0];
    const y1 = this.pcm[base + i1];
    const y2 = this.pcm[base + i2];
    const y3 = this.pcm[base + i3];
    // Catmull-Rom
    const a0 = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
    const a1 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const a2 = -0.5 * y0 + 0.5 * y2;
    const a3 = y1;
    return ((a0 * frac + a1) * frac + a2) * frac + a3;
  }

  readControl() {
    const c = this.control;
    if (!c) return;
    this.targetRate = c[C_TARGET_RATE];
    this.playing = c[C_PLAYING];
    if (c.length > C_FX_RESUME) {
      this.fxMode = c[C_FX_MODE] | 0; this.fxEngage = c[C_FX_ENGAGE]; this.fxLen = c[C_FX_LEN]; this.fxRate = c[C_FX_RATE];
      this.fxGate = c[C_FX_GATE]; this.fxAmount = c[C_FX_AMOUNT]; this.fxResume = c[C_FX_RESUME];
    }
    // Handle a pending seek (tonearm set-down): hard jump to the new position.
    const gen = c[C_SEEK_GEN];
    if (gen !== this.lastSeekGen) {
      this.readPosition = c[C_SEEK_POS];
      this.lastSeekGen = gen;
      c[C_SEEK_ACK] = gen;
    }
  }

  publishPosition() {
    if (this.control) {
      this.control[C_READ_POS] = this.readPosition;
    } else {
      // Throttle the fallback position report to every 4th block (~10 ms at a
      // 128-frame quantum) — smooth enough for the needle, light on messaging.
      if ((this._posReportCounter++ & 0x3) === 0) {
        this.port.postMessage({ type: 'pos', value: this.readPosition });
      }
    }
  }

  // ── FX render path (blend scratch / beat repeat / stutter). Allocation-free; the song's PCM is the only buffer ("capture" is just
  // a read window into it, so bounded memory is automatic). The main head is advanced exactly as in the plain loop; the FX adds a
  // second read head (the slice, or the song under the scratch) and crossfades it with the main head by `fxMix`.
  renderFx(out, blockLen) {
    const n = this.frames, outCh = out.length, chans = this.channels;
    if (this.fxMode !== 0) this.fxCur = this.fxMode;
    const mode = this.fxCur;
    const engaged = this.fxMode !== 0 && this.fxEngage > 0.5 ? 1 : 0;
    const len = this.fxLen > 1 ? this.fxLen : 0;

    if (engaged && !this.fxWas) {                       // rising edge: capture
      this.capPos = this.readPosition;
      this.slLen = len; this.slOut = 0; this.slPhase = 0; this.slRate = this.fxRate; this.retAge = 1e9;
      if (mode === 2) { this.slStart = Math.max(0, this.readPosition - len); this.wrapAge = 0; }   // wrap-age 0 = enter through the continuation cross-fade
      else if (mode === 3) { this.slStart = this.readPosition; this.firstPeriod = 1; this.wrapAge = 1e9; }
      else if (mode === 1) { this.underPos = this.readPosition; }
    } else if (!engaged && this.fxWas && (mode === 2 || mode === 3) && this.fxResume > 0.5) {
      this.readPosition = this.capPos;                  // "resume at the capture point"; the wet mix is still ramping out
    } else if (engaged && mode === 2 && len > 0 && len !== this.slLen) {   // division changed while holding: re-capture the newest slice
      this.holdL = this.lastWetL; this.holdR = this.lastWetR; this.retAge = 0;
      this.slLen = len; this.slStart = Math.max(0, this.readPosition - len); this.slPhase = 0; this.wrapAge = 1e9;
    }
    this.fxWas = engaged;
    const mixTarget = engaged ? (mode === 1 ? Math.max(0, Math.min(1, this.fxAmount)) : 1) : 0;
    const X = this.xfadeN, G = this.gateRamp;

    for (let s = 0; s < blockLen; s++) {
      this.currentRate += (this.targetRate - this.currentRate) * this.slewCoeff;
      let pos = this.readPosition + this.currentRate;
      if (pos < 0) { pos = 0; this.currentRate = 0; }
      else if (pos > n - 1) { pos = n - 1; this.currentRate = 0; }
      this.readPosition = pos;

      this.fxMix += (mixTarget - this.fxMix) * this.mixCoef;
      if (mixTarget === 0 && this.fxMix < 1e-4) this.fxMix = 0;
      else if (Math.abs(mixTarget - this.fxMix) < 1e-5) this.fxMix = mixTarget;
      const mix = this.fxMix;

      if (mix === 0) {                                  // idle (or finished ramping out): the plain sample
        for (let ch = 0; ch < outCh; ch++) out[ch][s] = this.sampleChannel(ch < chans ? ch : 0, pos);
        continue;
      }

      // advance the second head / compute its per-sample geometry once
      let sp = 0, sp2 = 0, w = 1, env = 1;
      if (mode === 2) {
        this.slRate += (this.fxRate - this.slRate) * this.rateCoef;
        sp = this.slStart + this.slPhase; sp2 = sp + this.slLen;
        w = this.wrapAge < X ? this.wrapAge / X : 1;
        this.slPhase += this.slRate; this.wrapAge++;
        while (this.slPhase >= this.slLen) { this.slPhase -= this.slLen; this.wrapAge = 0; }
      } else if (mode === 3) {
        const P = this.slLen > 1 ? this.slLen : 1;
        if (this.slOut >= P) { this.slOut = 0; this.slPhase = 0; this.firstPeriod = 0; }
        const A = Math.min(G, P * 0.25), gl = this.fxGate * P;
        if (!this.firstPeriod && this.slOut < A) env = this.slOut / A;
        if (this.slOut >= gl) env = 0; else if (this.slOut > gl - A) env = Math.min(env, (gl - this.slOut) / A);
        sp = this.slStart + this.slPhase;
        this.slPhase += 1; this.slOut++;
      } else if (mode === 1) {
        this.underPos += this.fxRate;
        if (this.underPos < 0) this.underPos = 0; else if (this.underPos > n - 1) this.underPos = n - 1;
        sp = this.underPos;
      }
      const rw = this.retAge < X ? this.retAge / X : 1;
      if (this.retAge < X) this.retAge++;

      for (let ch = 0; ch < outCh; ch++) {
        const src = ch < chans ? ch : 0;
        const dry = this.sampleChannel(src, pos);
        let wet = this.sampleChannel(src, sp);
        if (mode === 2) {
          if (w < 1) wet = w * wet + (1 - w) * this.sampleChannel(src, sp2);
          if (rw < 1) wet = rw * wet + (1 - rw) * (ch === 0 ? this.holdL : this.holdR);
          if (ch === 0) this.lastWetL = wet; else this.lastWetR = wet;
        } else if (mode === 3) wet *= env;
        out[ch][s] = dry + (wet - dry) * mix;
      }
    }
  }

  // AudioWorklet calls process(inputs, outputs, parameters) — inputs FIRST.
  // We have no inputs (numberOfInputs: 0); the audio sink is outputs[0].
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true; // no output sink this quantum
    const blockLen = out[0].length;
    this.readControl();

    const n = this.frames;
    if (n === 0 || !this.playing) {
      for (let ch = 0; ch < out.length; ch++) out[ch].fill(0);
      // Still slew the rate toward target so we don't snap on resume.
      this.currentRate += (this.targetRate - this.currentRate) * this.slewCoeff * blockLen;
      this.publishPosition();
      return true;
    }

    // FX section: only when a mode is selected (or its wet mix is still ramping out). Otherwise the loop below is the original.
    if (this.fxMode !== 0 || this.fxMix > 0) { this.renderFx(out, blockLen); this.publishPosition(); return true; }

    const outCh = out.length;
    for (let s = 0; s < blockLen; s++) {
      // Per-sample slew toward target rate — smooth, immune to frame cadence.
      this.currentRate += (this.targetRate - this.currentRate) * this.slewCoeff;
      let pos = this.readPosition + this.currentRate;

      // Clamp at the ends: the needle rests at the lead-in / runout rather than
      // wrapping. (One continuous spiral per track — no loop. Spec §11.4.)
      if (pos < 0) { pos = 0; this.currentRate = 0; }
      else if (pos > n - 1) { pos = n - 1; this.currentRate = 0; }
      this.readPosition = pos;

      for (let ch = 0; ch < outCh; ch++) {
        const src = ch < this.channels ? ch : 0; // mono → both ears
        out[ch][s] = this.sampleChannel(src, pos);
      }
    }

    this.publishPosition();
    return true;
  }
}

function clampIdx(i, n) {
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}

registerProcessor('runout-processor', RunoutProcessor);
