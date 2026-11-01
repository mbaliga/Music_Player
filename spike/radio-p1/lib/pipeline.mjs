// SPIKE P1 -- THROWAWAY. Caller-loop pipeline skeleton with pluggable adapters and per-stage
// timestamps (docs/RADIO_ARCHITECTURE.md section 8.2 / 13 "Latency harness").
//
//   mic -> VAD/endpointing -> STT -> (uplink) -> writer(LLM) -> chunker -> TTS -> playback
//
// Adapter contracts (all async, all receive nothing global: the clock is injected):
//   Mic       { kind, stream(onFrame:(Float32Array)=>void|Promise, clock) -> Promise<void>   resolves at end of input }
//   Stt       { kind, finalize({samples,hintText}, clock) -> Promise<{text}> }
//   Transport { kind, send(req, clock) -> Promise<void> }         device -> backend hop
//   Writer    { kind, stream(req, clock) -> AsyncIterable<string>} tokens; first yield = first token
//   Tts       { kind, synthesize(text, clock) -> Promise<{firstByteAt:number, audio:any}> }
//   Playback  { kind, play(audio, clock) -> Promise<{readyAt:number, audibleAt:number}> }
// `kind` is 'fake' | 'real' | 'measured' | 'reported' and flows into the report as provenance.
import { EnergyVad } from './vad.mjs';

export const MARKS = ['speech_end', 'vad_endpoint', 'stt_final', 'uplink_done', 'llm_first_token',
  'first_chunk', 'tts_first_byte', 'playback_ready', 'audible'];

/** Map mark timestamps to the budget's 8 stage durations. Missing marks give NaN for adjacent stages. */
export function stagesFromMarks(m) {
  const d = (a, b) => (Number.isFinite(m[a]) && Number.isFinite(m[b]) ? m[b] - m[a] : NaN);
  return {
    vad_endpoint: d('speech_end', 'vad_endpoint'),
    stt_final: d('vad_endpoint', 'stt_final'),
    uplink: d('stt_final', 'uplink_done'),
    llm_ttft: d('uplink_done', 'llm_first_token'),
    first_chunk: d('llm_first_token', 'first_chunk'),
    tts_ttfb: d('first_chunk', 'tts_first_byte'),
    downlink: d('tts_first_byte', 'playback_ready'),
    output: d('playback_ready', 'audible'),
  };
}

/**
 * Virtual clock for deterministic tests / fast simulation: sleep() advances time instantly.
 * Only valid when the pipeline is sequential (it is), i.e. no real concurrency to interleave.
 */
export class VirtualClock {
  constructor(t0 = 0) { this.t = t0; }
  now() { return this.t; }
  async sleep(ms) { this.t += Math.max(0, ms); }
  async sleepUntil(t) { if (t > this.t) this.t = t; }
}
export class RealClock {
  now() { return performance.now(); }
  sleep(ms) { return new Promise((r) => setTimeout(r, Math.max(0, ms))); }
  async sleepUntil(t) { const d = t - this.now(); if (d > 0) await this.sleep(d); }
}

/**
 * Splits streaming text into the first "speakable" chunk: first clause boundary
 * (, ; : . ! ? or dash) once at least minChars have accumulated (doc: chunk at first
 * clause/comma, not sentence end). Pure.
 */
export function createChunker({ minChars = 12 } = {}) {
  let buf = '';
  return {
    /** @returns {string|null} the chunk when ready, else null */
    push(token) {
      buf += token;
      for (let i = minChars - 1; i < buf.length - 1; i++) {
        if (/[,;:.!?\u2014]/.test(buf[i]) && /\s/.test(buf[i + 1])) {
          const chunk = buf.slice(0, i + 1).trim();
          buf = buf.slice(i + 1);
          return chunk;
        }
      }
      return null;
    },
    flush() { const c = buf.trim(); buf = ''; return c || null; },
  };
}

/** Microphone-replay adapter: feeds a Float32Array in real-time-spaced frames of frameMs. kind='measured'-capable. */
export class BufferMic {
  constructor(samples, sampleRate, { frameMs = 20, kind = 'fake' } = {}) {
    this.samples = samples; this.sr = sampleRate; this.frameMs = frameMs; this.kind = kind;
  }
  async stream(onFrame, clock) {
    const len = Math.round((this.sr * this.frameMs) / 1000);
    const t0 = clock.now();
    for (let i = 0; i + len <= this.samples.length; i += len) {
      await clock.sleepUntil(t0 + ((i + len) / this.sr) * 1000);
      const stop = await onFrame(this.samples.subarray(i, i + len), clock.now());
      if (stop === 'stop') return;
    }
  }
}

/**
 * Runs one caller turn and returns { marks, stages, text, firstChunk }.
 * `truthSpeechEndMs` (ms from stream start) is the ground-truth end of speech when known (synthetic
 * input); otherwise the VAD's own start-of-silence estimate is used and the result is flagged.
 */
export async function runTurn({ adapters, clock, vadOptions, sampleRate, truthSpeechEndMs = null, writerReq = {}, chunker = createChunker() }) {
  const { mic, stt, transport, writer, tts, playback } = adapters;
  const marks = {};
  const vad = new EnergyVad({ sampleRate, ...vadOptions });
  const streamStart = clock.now();
  let endpointed = false;
  const collected = [];

  await mic.stream(async (frame, tNow) => {
    collected.push(frame);
    for (const ev of vad.push(frame)) {
      if (ev.type === 'speech_end' && !endpointed) {
        endpointed = true;
        marks.vad_endpoint = tNow;
        marks.speech_end = truthSpeechEndMs != null ? streamStart + truthSpeechEndMs : streamStart + ev.speechEndMs;
        marks._speechEndSource = truthSpeechEndMs != null ? 'ground-truth' : 'vad-estimate';
      }
    }
    return endpointed ? 'stop' : undefined;
  }, clock);
  if (!endpointed) return { marks, stages: stagesFromMarks(marks), error: 'no endpoint detected' };

  const total = collected.reduce((a, f) => a + f.length, 0), all = new Float32Array(total);
  let o = 0; for (const f of collected) { all.set(f, o); o += f.length; }

  const sttRes = await stt.finalize({ samples: all, hintText: writerReq.hintText }, clock);
  marks.stt_final = clock.now();
  await transport.send({ text: sttRes.text }, clock);
  marks.uplink_done = clock.now();

  let first = true, chunk = null;
  for await (const tok of writer.stream({ ...writerReq, userText: sttRes.text }, clock)) {
    if (first) { marks.llm_first_token = clock.now(); first = false; }
    chunk = chunker.push(tok);
    if (chunk) break;
  }
  if (!chunk) chunk = chunker.flush();
  if (!chunk) return { marks, stages: stagesFromMarks(marks), error: 'writer produced no speakable text' };
  marks.first_chunk = clock.now();

  const synth = await tts.synthesize(chunk, clock);
  marks.tts_first_byte = synth.firstByteAt ?? clock.now();
  const pb = await playback.play(synth.audio, clock);
  marks.playback_ready = pb.readyAt;
  marks.audible = pb.audibleAt;
  return { marks, stages: stagesFromMarks(marks), text: sttRes.text, firstChunk: chunk };
}

/** Provenance map for the report from the adapters' declared kinds + the VAD input type. */
export function provenanceFor(adapters, { vadMeasured = true } = {}) {
  const k = (a, d = 'unspecified') => (a && a.kind) || d;
  const norm = (x) => (x === 'fake' ? 'configured-fake' : x === 'real' ? 'measured' : x);
  return {
    vad_endpoint: vadMeasured ? 'measured' : 'configured-fake',
    stt_final: norm(k(adapters.stt)),
    uplink: norm(k(adapters.transport)),
    llm_ttft: norm(k(adapters.writer)),
    first_chunk: norm(k(adapters.writer)),
    tts_ttfb: norm(k(adapters.tts)),
    downlink: norm(k(adapters.playback)),
    output: norm(k(adapters.playback, 'reported')),
  };
}
