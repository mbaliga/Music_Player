// SPIKE P1 -- THROWAWAY. Simple energy VAD + endpointing (stage 1 of the budget).
// This is a stand-in to make stage 1 measurable and to wire the pipeline; it is NOT a
// production VAD (no ML model, no spectral features). Pure: push Float32 frames in, get events out.

const dbfs = (x) => 20 * Math.log10(Math.max(x, 1e-9));

export class EnergyVad {
  /**
   * @param {{sampleRate:number, frameMs?:number, marginDb?:number, absFloorDb?:number,
   *          hangoverMs?:number, minSpeechMs?:number}} o
   */
  constructor(o) {
    this.sr = o.sampleRate;
    this.frameMs = o.frameMs ?? 20;
    this.marginDb = o.marginDb ?? 12;       // speech if frame is this far above the noise floor...
    this.absFloorDb = o.absFloorDb ?? -55;  // ...and above this absolute level
    this.hangoverMs = o.hangoverMs ?? 300;  // doc stage-1 p50 budget
    this.minSpeechMs = o.minSpeechMs ?? 60;
    this.frameLen = Math.round((this.sr * this.frameMs) / 1000);
    this._buf = new Float32Array(0);
    this._frames = 0;                       // frames consumed so far
    this.noiseDb = -70;                     // adaptive floor (EMA while not speaking)
    this.state = 'idle';                    // idle | speaking
    this._speechRun = 0;
    this._silenceRun = 0;
    this._silenceStartMs = 0;
    this._speechStartMs = 0;
    this._noiseInit = false;
  }

  /** @returns {Array<{type:'speech_start'|'speech_end', atMs:number, speechEndMs?:number, speechStartMs?:number}>} */
  push(samples) {
    const events = [];
    const merged = new Float32Array(this._buf.length + samples.length);
    merged.set(this._buf); merged.set(samples, this._buf.length);
    let off = 0;
    while (merged.length - off >= this.frameLen) {
      let e = 0;
      for (let i = 0; i < this.frameLen; i++) { const s = merged[off + i]; e += s * s; }
      off += this.frameLen;
      const db = dbfs(Math.sqrt(e / this.frameLen));
      this._frames++;
      const frameStartMs = (this._frames - 1) * this.frameMs;
      const frameEndMs = this._frames * this.frameMs;
      if (!this._noiseInit) { this.noiseDb = db; this._noiseInit = true; }
      const isSpeech = db > this.absFloorDb && db > this.noiseDb + this.marginDb;
      if (this.state === 'idle') {
        if (isSpeech) {
          if (this._speechRun === 0) this._speechStartMs = frameStartMs;
          this._speechRun++;
          if (this._speechRun * this.frameMs >= this.minSpeechMs) {
            this.state = 'speaking'; this._silenceRun = 0;
            events.push({ type: 'speech_start', atMs: frameEndMs, speechStartMs: this._speechStartMs });
          }
        } else {
          this._speechRun = 0;
          this.noiseDb += 0.1 * (db - this.noiseDb); // track floor only while quiet
        }
      } else if (isSpeech) {
        this._silenceRun = 0;
      } else {
        if (this._silenceRun === 0) this._silenceStartMs = frameStartMs;
        this._silenceRun++;
        if (this._silenceRun * this.frameMs >= this.hangoverMs) {
          this.state = 'idle'; this._speechRun = 0;
          // speechEndMs = start of the silence run = our best estimate of true end of speech.
          events.push({ type: 'speech_end', atMs: frameEndMs, speechEndMs: this._silenceStartMs });
        }
      }
    }
    this._buf = merged.slice(off);
    return events;
  }
}
