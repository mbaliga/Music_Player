// ─────────────────────────────────────────────────────────────────────────────
// audio-engine.js — the SWAPPABLE audio engine (spec §8).
//
// This is the layer the §3 latency gate may force us to replace with native
// Oboe/AAudio. It is deliberately small and behind a stable interface so that
// swap is "replace one file", not a rewrite:
//
//   await engine.load(pcmChannels, sampleRate)
//   engine.setRate(rate)        — drive playback speed (the platter output)
//   engine.seek(frames)         — hard jump (tonearm set-down)
//   engine.setPlaying(bool)     — music bus on/off (tonearm lift = silent)
//   engine.position             — current readPosition in frames (for the needle)
//   engine.latencyEstimate      — { base, output, total } seconds
//
// Uses a SharedArrayBuffer control channel + planar PCM SAB when the page is
// cross-origin isolated; otherwise falls back to postMessage + a transferred
// buffer (degraded — the §3 gate must be measured on the SAB path).
// ─────────────────────────────────────────────────────────────────────────────

import {
  C_TARGET_RATE, C_READ_POS, C_SEEK_POS, C_SEEK_GEN, C_PLAYING, CONTROL_SLOTS,
} from './control-layout.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.control = null;     // Float64Array view over the control SAB (or plain)
    this.usingSAB = false;
    this.frames = 0;
    this.channels = 2;
    this._fallbackPos = 0;   // updated via postMessage when no SAB
  }

  get isSharedMemory() {
    // Require confirmed cross-origin isolation. A defined-but-false value (the
    // APK WebView / file:// case) must fall back to postMessage; treating an
    // *undefined* value as "capable" risks handing the worklet a SAB it can't
    // actually share — which presents as silence, not a clean degrade.
    return typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true;
  }

  async init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive', // lowest output latency the device offers (§3)
    });
    // Resolve the worklet URL relative to this module so it works under any path.
    const workletUrl = new URL('./worklet.js', import.meta.url);
    await this.ctx.audioWorklet.addModule(workletUrl);
  }

  /**
   * Load decoded PCM. `channels` is an array of Float32Array (one per channel),
   * each `frames` long, already at the context sample rate.
   */
  async load(channels, frames) {
    this.frames = frames;
    this.channels = channels.length;
    this.usingSAB = this.isSharedMemory;

    // Pack planar PCM: channel c at [c*frames, (c+1)*frames).
    const total = this.channels * frames;
    let pcmBuf;
    if (this.usingSAB) {
      pcmBuf = new SharedArrayBuffer(total * Float32Array.BYTES_PER_ELEMENT);
    } else {
      pcmBuf = new ArrayBuffer(total * Float32Array.BYTES_PER_ELEMENT);
    }
    const pcm = new Float32Array(pcmBuf);
    for (let c = 0; c < this.channels; c++) pcm.set(channels[c], c * frames);

    // Control channel.
    let controlBuf;
    if (this.usingSAB) {
      controlBuf = new SharedArrayBuffer(CONTROL_SLOTS * Float64Array.BYTES_PER_ELEMENT);
      this.control = new Float64Array(controlBuf);
      this.control[C_PLAYING] = 1;
    } else {
      this.control = new Float64Array(CONTROL_SLOTS); // local only; not shared
      this.control[C_PLAYING] = 1;
    }

    this.node = new AudioWorkletNode(this.ctx, 'runout-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        channels: this.channels,
        frames,
        pcm: this.usingSAB ? pcmBuf : null,        // SAB shared by reference
        control: this.usingSAB ? controlBuf : null,
      },
    });
    this.node.connect(this.ctx.destination);

    if (!this.usingSAB) {
      // Fallback: hand the PCM over by transfer, drive control by message.
      this.node.port.postMessage(
        { type: 'pcm', pcm: pcmBuf, frames, channels: this.channels },
        [pcmBuf],
      );
      this.node.port.onmessage = (e) => {
        if (e.data.type === 'pos') this._fallbackPos = e.data.value;
      };
    }
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  setRate(rate) {
    if (this.usingSAB) this.control[C_TARGET_RATE] = rate;
    else this.node.port.postMessage({ type: 'rate', value: rate });
  }

  setPlaying(on) {
    if (this.usingSAB) this.control[C_PLAYING] = on ? 1 : 0;
    else this.node.port.postMessage({ type: 'playing', value: !!on });
  }

  /** Hard jump (tonearm set-down). `frames` is the new readPosition. */
  seek(frames) {
    if (this.usingSAB) {
      this.control[C_SEEK_POS] = frames;
      this.control[C_SEEK_GEN] += 1;
    } else {
      this.node.port.postMessage({ type: 'seek', value: frames });
      this._fallbackPos = frames;
    }
  }

  get position() {
    return this.usingSAB ? this.control[C_READ_POS] : this._fallbackPos;
  }

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 44100;
  }

  /** Best-effort latency estimate. True end-to-end needs a loopback mic (§3). */
  get latencyEstimate() {
    const base = this.ctx?.baseLatency || 0;
    const output = this.ctx?.outputLatency || 0;
    return { base, output, total: base + output };
  }
}
