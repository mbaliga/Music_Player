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
// Gapless queue hook (additive, optional): prepareNext / joinNext / dropNext /
// hasNext — see the comment block above prepareNext. A plain load() still
// replaces the whole deck, exactly as before (and now frees the old one).
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
    this._deck = null;       // active deck (node + control + PCM); see _makeDeck
    this._next = null;       // queued next deck (gapless hook), or null
    this._rate = 0;          // last rate set (carried across a gapless join)
  }

  get isSharedMemory() {
    // Require confirmed cross-origin isolation. A defined-but-false value (the
    // APK WebView / file:// case) must fall back to postMessage; treating an
    // *undefined* value as "capable" risks handing the worklet a SAB it can't
    // actually share — which presents as silence, not a clean degrade.
    return typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true;
  }

  /**
   * The music bus: one unity GainNode every deck feeds, which feeds ctx.destination. Additive hook for the radio
   * host (docs/RADIO_ARCHITECTURE.md 4.4): automating this gain ducks the music under speech without touching
   * decks. At unity (the default) it changes nothing audible.
   */
  get musicBus() {
    if (!this._bus) {
      this._bus = this.ctx.createGain();
      this._bus.connect(this.ctx.destination);
    }
    return this._bus;
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
   * Build one playback "deck": a worklet node (+ its own PCM copy and control
   * channel) feeding a gain node. `active` decks start live; a queued next deck
   * starts silent and parked at frame 0.
   */
  _makeDeck(channels, frames, active) {
    const usingSAB = this.isSharedMemory;
    const nch = channels.length;
    // Pack planar PCM: channel c at [c*frames, (c+1)*frames).
    const total = nch * frames;
    const pcmBuf = usingSAB
      ? new SharedArrayBuffer(total * Float32Array.BYTES_PER_ELEMENT)
      : new ArrayBuffer(total * Float32Array.BYTES_PER_ELEMENT);
    const pcm = new Float32Array(pcmBuf);
    for (let c = 0; c < nch; c++) pcm.set(channels[c], c * frames);

    // Control channel (shared when SAB, local-only otherwise).
    let controlBuf = null;
    let control;
    if (usingSAB) {
      controlBuf = new SharedArrayBuffer(CONTROL_SLOTS * Float64Array.BYTES_PER_ELEMENT);
      control = new Float64Array(controlBuf);
    } else {
      control = new Float64Array(CONTROL_SLOTS);
    }
    control[C_PLAYING] = active ? 1 : 0;

    const node = new AudioWorkletNode(this.ctx, 'runout-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        channels: nch,
        frames,
        pcm: usingSAB ? pcmBuf : null,        // SAB shared by reference
        control: usingSAB ? controlBuf : null,
      },
    });
    const gain = this.ctx.createGain();
    node.connect(gain);
    gain.connect(this.musicBus);

    const deck = { node, gain, control, usingSAB, frames, channels: nch, fallbackPos: 0 };
    if (!usingSAB) {
      // Fallback: hand the PCM over by transfer, drive control by message.
      node.port.postMessage({ type: 'pcm', pcm: pcmBuf, frames, channels: nch }, [pcmBuf]);
      node.port.onmessage = (e) => {
        if (e.data.type === 'pos') deck.fallbackPos = e.data.value;
      };
      if (!active) node.port.postMessage({ type: 'playing', value: false });
    }
    return deck;
  }

  /** Make `deck` the one the public interface (rate/seek/position) talks to. */
  _adopt(deck) {
    this._deck = deck;
    this.node = deck.node;
    this.control = deck.control;
    this.usingSAB = deck.usingSAB;
    this.frames = deck.frames;
    this.channels = deck.channels;
  }

  /** Silence + release a deck's node and PCM (the worklet drops its buffer). */
  _freeDeck(deck) {
    if (!deck) return;
    try { deck.node.port.postMessage({ type: 'free' }); } catch {}
    try { deck.node.disconnect(); deck.gain.disconnect(); } catch {}
    deck.control = null;
  }

  // The non-SAB position report lives on the active deck.
  get _fallbackPos() { return this._deck ? this._deck.fallbackPos : 0; }
  set _fallbackPos(v) { if (this._deck) this._deck.fallbackPos = v; }

  /**
   * Load decoded PCM. `channels` is an array of Float32Array (one per channel),
   * each `frames` long, already at the context sample rate. Replaces (and frees)
   * the previous deck and any queued next deck.
   */
  async load(channels, frames) {
    const old = this._deck;
    const deck = this._makeDeck(channels, frames, true);
    this.dropNext();
    this._adopt(deck);
    this._rate = 0;
    this._freeDeck(old); // a replaced deck must not keep playing under the new one
  }

  // ── Gapless queue hook (additive; the interface above is unchanged) ─────────
  // Bounded memory: at most TWO decks hold PCM (active + queued next), and the
  // previous one is released right after the join. The queue policy (when to
  // preload, memory budget, when to join) is pure and lives in queue.js.
  //
  //   await engine.prepareNext(channels, frames)  decode-ahead: builds a silent
  //                                               parked deck; callers may drop
  //                                               their `channels` afterwards
  //   engine.hasNext / engine.nextFrames          is a next deck queued?
  //   engine.joinNext({ fadeSec })                swap to it NOW: equal-power
  //                                               crossfade over fadeSec (min
  //                                               ~5 ms, so a join never clicks),
  //                                               carries the current rate, frees
  //                                               the old deck after the fade.
  //                                               Returns true if it joined.
  //   engine.dropNext()                           discard a queued deck
  //
  // After joinNext() the public interface (setRate/seek/position) addresses the
  // NEW deck from frame 0. Vinyl scrub is untouched: with nothing queued none of
  // this code runs.
  async prepareNext(channels, frames) {
    this.dropNext();
    this._next = this._makeDeck(channels, frames, false);
    return { frames };
  }

  get hasNext() { return !!this._next; }
  get nextFrames() { return this._next ? this._next.frames : 0; }

  dropNext() {
    if (this._next) { this._freeDeck(this._next); this._next = null; }
  }

  joinNext({ fadeSec = 0.05 } = {}) {
    const nx = this._next;
    const prev = this._deck;
    if (!nx || !prev) return false;
    this._next = null;
    const fade = Math.max(0.005, Math.min(12, fadeSec));
    const now = this.ctx.currentTime;
    // Equal-power curves (sin/cos) via value curves: smooth and sample-accurate.
    const N = 64, up = new Float32Array(N), down = new Float32Array(N);
    for (let i = 0; i < N; i++) { const x = (i / (N - 1)) * Math.PI / 2; up[i] = Math.sin(x); down[i] = Math.cos(x); }
    nx.gain.gain.setValueAtTime(0, now);
    nx.gain.gain.setValueCurveAtTime(up, now, fade);
    prev.gain.gain.cancelScheduledValues(now);
    prev.gain.gain.setValueAtTime(1, now);
    prev.gain.gain.setValueCurveAtTime(down, now, fade);
    // Start the new deck at the current rate; the old one keeps its own until freed.
    const rate = this._rate || 0;
    if (nx.usingSAB) { nx.control[C_TARGET_RATE] = rate; nx.control[C_PLAYING] = 1; }
    else {
      nx.node.port.postMessage({ type: 'rate', value: rate });
      nx.node.port.postMessage({ type: 'playing', value: true });
    }
    this._adopt(nx);
    setTimeout(() => this._freeDeck(prev), Math.ceil((fade + 0.3) * 1000));
    return true;
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  setRate(rate) {
    this._rate = rate;
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
