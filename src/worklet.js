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
    else if (msg.type === 'pcm') {
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
