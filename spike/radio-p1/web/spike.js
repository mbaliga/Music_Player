// SPIKE P1 -- THROWAWAY device/headless harness. One page, three tests, one results blob.
import { speechLike } from '../lib/synth.mjs';
import { echoMetrics, classifyEcho } from '../lib/echo.mjs';
import { VirtualClock, RealClock, runTurn, provenanceFor } from '../lib/pipeline.mjs';
import { makeFakeAdapters, defaultFakeConfig } from '../lib/adapters-fake.mjs';
import { buildReport, formatReportMarkdown } from '../lib/budget.mjs';

const $ = (id) => document.getElementById(id);
const RESULTS = { schema: 'runout-radio-spike-p1/1', startedAt: new Date().toISOString(), env: null, echo: [], background: null, latency: null };
const show = (id, text) => { $(id).textContent = text; };
const refreshAll = () => { $('outAll').textContent = JSON.stringify(RESULTS, null, 1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ctx = null;
async function ensureCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  if (ctx.state !== 'running') await ctx.resume();
  return ctx;
}
function workletUrl(src) { return URL.createObjectURL(new Blob([src], { type: 'text/javascript' })); }

const CAP_WORKLET = `
class Cap extends AudioWorkletProcessor {
  constructor(){ super(); this.buf = new Float32Array(2048); this.n = 0; this.first = -1; }
  process(inputs){
    const c = inputs[0] && inputs[0][0]; if (!c) return true;
    if (this.first < 0) this.first = currentFrame;
    for (let i = 0; i < c.length; i++) { this.buf[this.n++] = c[i]; if (this.n === this.buf.length) { this.port.postMessage({ startFrame: this.first, data: this.buf.slice() }); this.first += this.n; this.n = 0; } }
    return true;
  }
}
registerProcessor('cap', Cap);`;

const TICK_WORKLET = `
class Tick extends AudioWorkletProcessor {
  constructor(){ super(); this.exp = -1; this.gaps = 0; this.maxGapFrames = 0; this.blocks = 0; this.ph = 0; }
  process(inputs, outputs){
    const o = outputs[0][0], L = o.length;
    if (this.exp >= 0 && currentFrame !== this.exp) { this.gaps++; this.maxGapFrames = Math.max(this.maxGapFrames, Math.abs(currentFrame - this.exp)); }
    this.exp = currentFrame + L;
    for (let i = 0; i < L; i++) { this.ph += 2*Math.PI*330/sampleRate; o[i] = 0.05*Math.sin(this.ph); }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(o);
    if (++this.blocks % 375 === 0) this.port.postMessage({ blocks: this.blocks, gaps: this.gaps, maxGapMs: this.maxGapFrames/sampleRate*1000, frame: currentFrame });
    return true;
  }
}
registerProcessor('tick', Tick);`;

// ───────────────── 0. environment ─────────────────
async function probeEnv() {
  const c = await ensureCtx();
  const sup = navigator.mediaDevices?.getSupportedConstraints?.() || {};
  let perm = 'n/a'; try { perm = (await navigator.permissions.query({ name: 'microphone' })).state; } catch {}
  const env = {
    ua: navigator.userAgent, secureContext: window.isSecureContext, crossOriginIsolated: self.crossOriginIsolated,
    capacitor: window.Capacitor ? { platform: window.Capacitor.getPlatform?.(), native: window.Capacitor.isNativePlatform?.(), plugins: Object.keys(window.Capacitor.Plugins || {}) } : null,
    spikeNativePlugin: Boolean(window.Capacitor?.Plugins?.SpikeBackground),
    getUserMedia: Boolean(navigator.mediaDevices?.getUserMedia), supportedConstraints: { echoCancellation: sup.echoCancellation, noiseSuppression: sup.noiseSuppression, autoGainControl: sup.autoGainControl, voiceIsolation: sup.voiceIsolation, latency: sup.latency, channelCount: sup.channelCount },
    audioWorklet: Boolean(c.audioWorklet), mediaSession: 'mediaSession' in navigator, wakeLock: 'wakeLock' in navigator,
    micPermission: perm, audioContext: { sampleRate: c.sampleRate, baseLatencyMs: +(c.baseLatency * 1000).toFixed(2), outputLatencyMs: c.outputLatency != null ? +(c.outputLatency * 1000).toFixed(2) : null, state: c.state },
    visibility: document.visibilityState, connection: navigator.connection ? { type: navigator.connection.type, effectiveType: navigator.connection.effectiveType, rtt: navigator.connection.rtt } : null,
  };
  RESULTS.env = env; show('outEnv', JSON.stringify(env, null, 1)); refreshAll(); return env;
}

// ───────────────── 1. echo ─────────────────
const MIC_MODES = [
  { id: 'raw-all-off', audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } },
  { id: 'browser-defaults', audio: true },
  { id: 'aec-only', audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } },
  { id: 'aec+ns+agc', audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } },
];

// Positive control for the harness itself (NOT an AEC test): the "mic" is a MediaStream fed from the played
// signal through a known delay + gain + noise, entirely inside the AudioContext.
function simulatedMic(c, { delayMs, gainDb, noiseDb }) {
  const dest = c.createMediaStreamDestination(), delay = c.createDelay(1), gain = c.createGain();
  delay.delayTime.value = delayMs / 1000; gain.gain.value = 10 ** (gainDb / 20);
  delay.connect(gain).connect(dest);
  const nb = c.createBuffer(1, c.sampleRate * 2, c.sampleRate), d = nb.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.sqrt(3) * 10 ** (noiseDb / 20); // uniform noise at ~noiseDb RMS
  const ns = c.createBufferSource(); ns.buffer = nb; ns.loop = true; ns.connect(dest); ns.start();
  return { stream: dest.stream, tap: delay };
}

async function captureWhilePlaying(mode, playSec, sim) {
  const c = await ensureCtx();
  const simMic = sim ? simulatedMic(c, sim) : null;
  const stream = simMic ? simMic.stream : await navigator.mediaDevices.getUserMedia({ audio: mode.audio });
  const track = stream.getAudioTracks()[0];
  const settings = track.getSettings();
  await c.audioWorklet.addModule(workletUrl(CAP_WORKLET)).catch(() => {}); // re-registering throws; ignore on 2nd call
  const node = new AudioWorkletNode(c, 'cap', { numberOfOutputs: 0 });
  const chunks = []; let firstFrame = null;
  node.port.onmessage = (e) => { if (firstFrame === null) firstFrame = e.data.startFrame; chunks.push(e.data.data); };
  c.createMediaStreamSource(stream).connect(node);
  await sleep(1800);                                               // baseline (silence) + AEC convergence
  const ref = speechLike(c.sampleRate, playSec * 1000, { seed: 21, level: 0.5 });
  const buf = c.createBuffer(1, ref.length, c.sampleRate); buf.copyToChannel(ref, 0);
  const src = c.createBufferSource(); src.buffer = buf; src.connect(c.destination); if (simMic) src.connect(simMic.tap);
  const when = c.currentTime + 0.15; src.start(when);
  await sleep((playSec + 1.5) * 1000);
  node.disconnect(); stream.getTracks().forEach((t) => t.stop());
  const cap = new Float32Array(chunks.length * 2048); chunks.forEach((d, i) => cap.set(d, i * 2048));
  const playStartSample = Math.round(when * c.sampleRate - firstFrame);
  return { ref, cap, playStartSample, settings, sampleRate: c.sampleRate };
}

function wavBlobUrl(f32, sr) {
  const n = f32.length, b = new DataView(new ArrayBuffer(44 + n * 2)), w = (o, s) => { for (let i = 0; i < s.length; i++) b.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); b.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, sr, true); b.setUint32(28, sr * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); w(36, 'data'); b.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) b.setInt16(44 + i * 2, Math.max(-1, Math.min(1, f32[i])) * 32767, true);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}

async function runEcho(opts = {}) {
  const route = opts.sim ? 'SIMULATED-HARNESS-CONTROL' : $('route').value, playSec = opts.playSec || +$('playSec').value || 5;
  $('echoDl').innerHTML = '';
  const rows = [];
  for (const mode of (opts.sim ? [{ id: 'sim', audio: true }] : MIC_MODES)) {
    show('outEcho', rows.map(fmtEchoRow).join('\n') + `\nrunning ${mode.id} ...`);
    try {
      const r = await captureWhilePlaying(mode, playSec, opts.sim);
      const m = echoMetrics(r.ref, r.cap, r.sampleRate, { playStartSample: r.playStartSample });
      const row = { route, mode: mode.id, sim: opts.sim || null, granted: { echoCancellation: r.settings.echoCancellation, noiseSuppression: r.settings.noiseSuppression, autoGainControl: r.settings.autoGainControl, sampleRate: r.settings.sampleRate, latency: r.settings.latency }, metrics: m, verdict: classifyEcho(m), at: new Date().toISOString() };
      rows.push(row); RESULTS.echo.push(row);
      const a = document.createElement('a'); a.href = wavBlobUrl(r.cap, r.sampleRate); a.download = `echo-${route}-${mode.id}.wav`; a.textContent = `capture ${mode.id} `; $('echoDl').append(a, ' ');
    } catch (e) { const row = { route, mode: mode.id, error: String(e) }; rows.push(row); RESULTS.echo.push(row); }
    refreshAll();
  }
  show('outEcho', rows.map(fmtEchoRow).join('\n'));
  return rows;
}
function fmtEchoRow(r) {
  if (r.error) return `${r.mode}: ERROR ${r.error}`;
  const m = r.metrics;
  return `${r.route}/${r.mode}: granted AEC=${r.granted.echoCancellation} NS=${r.granted.noiseSuppression} AGC=${r.granted.autoGainControl} | lag ${m.rho >= 0.2 ? m.lagMs.toFixed(0) + ' ms' : 'n/a (rho<0.2, no coupled copy found)'}, echoReturn ${m.echoReturnDb.toFixed(1)} dB, rho ${m.rho.toFixed(2)}, floor ${m.noiseFloorDb.toFixed(1)} dBFS, playback ${m.playbackRmsDb.toFixed(1)} dBFS, excess ${m.excessDb.toFixed(1)} dB => ${r.verdict.toUpperCase()}`;
}

// ───────────────── 2. background ─────────────────
const BG_KEY = 'radioP1.bg.v1';
let bg = null;
const lsGet = () => { try { return JSON.parse(localStorage.getItem(BG_KEY) || 'null'); } catch { return null; } };
const lsSet = (v) => { try { localStorage.setItem(BG_KEY, JSON.stringify(v)); } catch {} };

async function startBg() {
  if (bg) return;
  const c = await ensureCtx();
  await c.audioWorklet.addModule(workletUrl(TICK_WORKLET)).catch(() => {});
  const node = new AudioWorkletNode(c, 'tick', { outputChannelCount: [2] });
  node.connect(c.destination);
  const state = { startedWall: Date.now(), startedCtx: c.currentTime, beats: [], events: [], worklet: null, opts: { ms: $('optMs').checked, wl: $('optWl').checked, native: $('optNative').checked } };
  node.port.onmessage = (e) => { state.worklet = e.data; };
  const ev = (type, extra = {}) => { state.events.push({ t: Date.now() - state.startedWall, type, ctxState: c.state, hidden: document.hidden, ...extra }); };
  c.onstatechange = () => ev('ctxstate');
  document.addEventListener('visibilitychange', () => ev('visibility'));
  if (state.opts.ms && 'mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: 'Radio spike tone', artist: 'Runout P1' });
      navigator.mediaSession.playbackState = 'playing';
      for (const a of ['play', 'pause', 'stop']) navigator.mediaSession.setActionHandler(a, () => ev('mediasession-action', { action: a }));
      ev('mediasession-set');
    } catch (e) { ev('mediasession-error', { e: String(e) }); }
  }
  let wl = null;
  if (state.opts.wl && navigator.wakeLock) { try { wl = await navigator.wakeLock.request('screen'); ev('wakelock-granted'); wl.onrelease = () => ev('wakelock-released'); } catch (e) { ev('wakelock-error', { e: String(e) }); } }
  const P = window.Capacitor?.Plugins?.SpikeBackground;
  if (state.opts.native && P) { try { ev('native-start', { r: await P.start() }); } catch (e) { ev('native-start-error', { e: String(e) }); } }
  else if (state.opts.native) ev('native-unavailable');
  const timer = setInterval(() => {
    state.beats.push({ w: Date.now() - state.startedWall, c: +(c.currentTime - state.startedCtx).toFixed(3), s: c.state, h: document.hidden, g: state.worklet?.gaps ?? null, b: state.worklet?.blocks ?? null });
    if (state.beats.length % 10 === 0) lsSet(persistable(state));
  }, 1000);
  bg = { c, node, timer, state, wl };
  ev('started'); show('outBg', 'running ... lock the screen now. Press Summarize when back.');
}
const persistable = (s) => ({ ...s, savedAt: Date.now() });

export function summarizeBg(s) {
  if (!s || !s.beats.length) return { note: 'no data' };
  const b = s.beats; let maxStall = 0, maxWallGap = 0, stalls = 0;
  for (let i = 1; i < b.length; i++) {
    const wd = b[i].w - b[i - 1].w, cd = (b[i].c - b[i - 1].c) * 1000, stall = Math.max(0, wd - cd);
    maxWallGap = Math.max(maxWallGap, wd); if (stall > 250) stalls++; maxStall = Math.max(maxStall, stall);
  }
  const last = b[b.length - 1];
  return {
    wallMinutes: +(last.w / 60000).toFixed(2), audioClockMinutes: +(last.c / 60).toFixed(2),
    totalDriftMs: Math.round(last.w - last.c * 1000),
    maxStallMsBetweenHeartbeats: Math.round(maxStall), heartbeatsWithStallOver250ms: stalls,
    maxHeartbeatIntervalMs: maxWallGap, hiddenHeartbeats: b.filter((x) => x.h).length, nonRunningHeartbeats: b.filter((x) => x.s !== 'running').length,
    workletDiscontinuities: s.worklet?.gaps ?? null, workletMaxJumpMs: s.worklet?.maxGapMs ?? null, workletBlocks: s.worklet?.blocks ?? null,
    events: s.events, opts: s.opts,
    readThis: 'Pass for S2 needs: nonRunningHeartbeats 0, stalls 0, workletDiscontinuities 0 AND no audible dropout (second-device recording). maxHeartbeatIntervalMs >> 1000 means JS timers were throttled while hidden (scheduler lookahead implication).',
  };
}
async function stopBg() {
  if (!bg) return;
  clearInterval(bg.timer); lsSet(persistable(bg.state)); bg.node.disconnect(); bg.wl?.release?.();
  const P = window.Capacitor?.Plugins?.SpikeBackground; if (P) { try { await P.stop(); } catch {} }
  RESULTS.background = summarizeBg(bg.state); bg = null; refreshAll(); show('outBg', JSON.stringify(RESULTS.background, null, 1));
}
function sumBg() { const s = bg ? bg.state : lsGet(); RESULTS.background = summarizeBg(s); refreshAll(); show('outBg', JSON.stringify(RESULTS.background, null, 1)); }

// ───────────────── 3. live caller-loop latency ─────────────────
async function openLiveMic() {
  const c = await ensureCtx();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  await c.audioWorklet.addModule(workletUrl(CAP_WORKLET)).catch(() => {});
  const node = new AudioWorkletNode(c, 'cap', { numberOfOutputs: 0 });
  const src = c.createMediaStreamSource(stream); src.connect(node);
  let handler = null;
  node.port.onmessage = (e) => { if (handler) handler(e.data.data); };
  return {
    kind: 'measured', sampleRate: c.sampleRate,
    stream(onFrame, clock) {
      return new Promise((resolve) => {
        let chain = Promise.resolve(), done = false;
        handler = (f) => { chain = chain.then(async () => { if (done) return; if ((await onFrame(f, clock.now())) === 'stop') { done = true; handler = null; resolve(); } }); };
      });
    },
    close() { node.disconnect(); stream.getTracks().forEach((t) => t.stop()); },
  };
}

function livePlayback(c) {
  const clip = speechLike(c.sampleRate, 900, { seed: 77, level: 0.3 });
  return {
    kind: 'reported',
    async play(_, clock) {
      const t0 = clock.now();
      const buf = c.createBuffer(1, clip.length, c.sampleRate); buf.copyToChannel(clip, 0);
      const s = c.createBufferSource(); s.buffer = buf; s.connect(c.destination);
      const when = c.currentTime + 0.005; s.start(when);
      const readyAt = clock.now();                       // decode/jitter is nil here: local buffer
      const outLat = (c.outputLatency || 0) + (c.baseLatency || 0);
      // audible = scheduled start + REPORTED latency (not measured; needs loopback)
      return { readyAt, audibleAt: readyAt + 5 + outLat * 1000 }   /* 5 ms = scheduling lead */;
    },
  };
}

async function runLive() {
  const n = +$('turns').value || 5, hang = +$('hang').value || 300;
  const c = await ensureCtx(), mic = await openLiveMic(), turns = [], rows = [];
  let provenance = null;
  for (let i = 0; i < n; i++) {
    show('outLat', `turn ${i + 1}/${n}: SPEAK a short phrase now, then stop...\n` + rows.join('\n'));
    const cfg = defaultFakeConfig({ seed: 500 + i, llm_ttft: +$('cfgLlm').value, tts_ttfb: +$('cfgTts').value });
    const adapters = makeFakeAdapters(mic, cfg);
    adapters.playback = livePlayback(c);
    provenance = provenanceFor(adapters, { vadMeasured: false });
    provenance.vad_endpoint = 'self-referenced';        // live: speech_end is the VAD's own estimate, so stage 1 ~= hangover by construction
    const clock = new RealClock();
    const r = await Promise.race([runTurn({ adapters, clock, vadOptions: { hangoverMs: hang }, sampleRate: mic.sampleRate }), sleep(20000).then(() => ({ error: 'timeout: no speech heard in 20 s' }))]);
    if (r.error) { rows.push(`turn ${i + 1}: ${r.error}`); continue; }
    turns.push(r.stages); rows.push(`turn ${i + 1}: total ${Object.values(r.stages).reduce((a, b) => a + b, 0).toFixed(0)} ms`);
    await sleep(1500);
  }
  mic.close();
  const report = buildReport(turns, { provenance: provenance || {} });
  RESULTS.latency = { report, markdown: formatReportMarkdown(report, 'Live-mic turns with FAKE stages 2-6'), reportedOutputLatencyMs: (c.outputLatency || 0) * 1000, baseLatencyMs: c.baseLatency * 1000 };
  refreshAll(); show('outLat', RESULTS.latency.markdown);
  return report;
}

// ───────────────── wiring + test API ─────────────────
const wire = (id, fn) => $(id).addEventListener('click', async () => { try { await fn(); } catch (e) { alert(`${id}: ${e}`); console.error(e); } });
wire('btnEnv', probeEnv); wire('btnEcho', () => runEcho()); wire('btnBgStart', startBg); wire('btnBgStop', stopBg); wire('btnBgSum', sumBg);
wire('btnBgClear', async () => { try { localStorage.removeItem(BG_KEY); } catch {} show('outBg', 'cleared'); });
wire('btnLat', runLive);
wire('btnCopy', async () => { await navigator.clipboard.writeText(JSON.stringify(RESULTS, null, 1)); });
wire('btnDl', async () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(RESULTS, null, 1)], { type: 'application/json' })); a.download = `radio-p1-results-${Date.now()}.json`; a.click(); });
window.__spike = { RESULTS, probeEnv, runEcho, startBg, stopBg, sumBg, runLive, summarizeBg };
