// ─────────────────────────────────────────────────────────────────────────────
// modes.js — the FX mode list, the (serialisable) FX state, and derive(): the one pure function that turns
// (state, live touch) into the commands for the worklet, the effects bus and the on-screen readout.
// No browser globals. Everything the UI and the controller do to audio goes through derive(), so it is all testable here.
// ─────────────────────────────────────────────────────────────────────────────

import {
  DIVISIONS, sliceFrames, sliceMs, sliceFraction, clampDivision, beatLabel, isDivision,
} from './divisions.js';
import {
  clamp, repeatRateFromSpin, ratePercent, formatPercent, bpFreqFromX, bpQFromY, echoWetFromX, echoFeedbackFromY, blendFromRadius,
} from './gesture.js';

export const FX_VERSION = 1;

export const MODES = Object.freeze([
  { id: 'scratch', label: 'Scratch', desc: 'Drag the platter to scrub. The normal Runout feel.', gesture: 'Drag the platter' },
  { id: 'blend', label: 'Blend scratch', desc: 'Scratch while the song keeps playing underneath.', gesture: 'Drag the platter' },
  { id: 'repeat', label: 'Beat repeat', desc: 'Hold to loop the last slice. Slide in or out to change its length; spin to change its speed.', gesture: 'Hold, slide, spin' },
  { id: 'stutter', label: 'Stutter', desc: 'Hold to retrigger this moment on the beat, with a gate.', gesture: 'Hold, slide' },
  { id: 'bandpass', label: 'Band pass', desc: 'Hold and slide: left or right moves the filter, up or down narrows it.', gesture: 'Hold, slide' },
  { id: 'echo', label: 'Reverb / delay', desc: 'Hold and slide for echo and room. The tail rings out when you let go.', gesture: 'Hold, slide' },
]);
export const MODE_IDS = Object.freeze(MODES.map((m) => m.id));
export const isMode = (id) => MODE_IDS.includes(id);
export const modeInfo = (id) => MODES.find((m) => m.id === id) || MODES[0];

/** Worklet FX mode numbers (src/worklet.js, src/control-layout.js). */
export const W_MODE = Object.freeze({ off: 0, blend: 1, repeat: 2, stutter: 3 });

/** Modes that take over the platter while held: the finger does NOT scratch (the song keeps its normal speed). */
export const holdsPlatter = (mode) => mode === 'repeat' || mode === 'stutter';
/** Modes where the finger is an XY pad on the audio bus (no scratch either). */
export const isPadMode = (mode) => mode === 'bandpass' || mode === 'echo';
/** Modes that need a beat length. */
export const needsTempo = (mode) => mode === 'repeat' || mode === 'stutter' || mode === 'echo';

export function defaultFx() {
  return {
    v: FX_VERSION,
    mode: 'scratch',
    ring: true,           // LED ring on
    latch: false,         // hold-to-engage (false) or tap-to-toggle (true)
    bpmScale: 1,          // 0.5 / 1 / 2: the user's octave fix for the tempo estimate
    blend: { amount: 0.5, byRadius: false },
    repeat: { div: '1/4', resume: 'time' },      // resume: 'time' = as if the song kept playing; 'capture' = back at the capture point
    stutter: { div: '1/8', gate: 0.5 },
    bandpass: { q: 4 },   // only a starting hint; x/y of the finger decide the live values
    echo: { delayDiv: '1/2', balance: 0.5 },     // balance: 0 = all delay ... 1 = all reverb
  };
}

const num = (x, lo, hi, d) => (typeof x === 'number' && Number.isFinite(x) ? clamp(x, lo, hi) : d);
const bool = (x, d) => (typeof x === 'boolean' ? x : d);

/** Make any input into a valid FX state (unknown keys dropped, bad values replaced by defaults, numbers clamped). Never throws. */
export function sanitizeFx(input) {
  const d = defaultFx();
  const o = input && typeof input === 'object' ? input : {};
  const sub = (k) => (o[k] && typeof o[k] === 'object' ? o[k] : {});
  return {
    v: FX_VERSION,
    mode: isMode(o.mode) ? o.mode : d.mode,
    ring: bool(o.ring, d.ring),
    latch: bool(o.latch, d.latch),
    bpmScale: o.bpmScale === 0.5 || o.bpmScale === 2 ? o.bpmScale : 1,
    blend: { amount: num(sub('blend').amount, 0, 1, d.blend.amount), byRadius: bool(sub('blend').byRadius, d.blend.byRadius) },
    repeat: { div: clampDivision(sub('repeat').div, d.repeat.div), resume: sub('repeat').resume === 'capture' ? 'capture' : 'time' },
    stutter: { div: clampDivision(sub('stutter').div, d.stutter.div), gate: num(sub('stutter').gate, 0.1, 1, d.stutter.gate) },
    bandpass: { q: num(sub('bandpass').q, 0.7, 14, d.bandpass.q) },
    echo: { delayDiv: clampDivision(sub('echo').delayDiv, d.echo.delayDiv), balance: num(sub('echo').balance, 0, 1, d.echo.balance) },
  };
}

/** Immutable updates. `setMode` / `setParam` validate through sanitizeFx so the state can never become invalid. */
export function setMode(st, mode) { return isMode(mode) ? sanitizeFx({ ...st, mode }) : st; }
export function setParam(st, group, key, value) {
  if (group === 'root') return sanitizeFx({ ...st, [key]: value });
  if (!st[group] || typeof st[group] !== 'object') return st;
  return sanitizeFx({ ...st, [group]: { ...st[group], [key]: value } });
}

const WORKLET_OFF = Object.freeze({ mode: 0, engage: 0, len: 0, rate: 1, gate: 1, amount: 0, resume: 0 });
const BUS_OFF = Object.freeze({ kind: null, engaged: false, freq: 1000, q: 4, wet: 0, feedback: 0.4, delaySec: 0.25, balance: 0.5 });

/**
 * rt = { engaged, blocked, u, x, y, spin, div, beat, sampleRate, nominalRate }
 *   engaged: the finger / pad is held (or latched);  blocked: a radio station / mixtape owns the engine
 *   u: radial 0..1 of the finger;  x,y: pad coordinates (-1..1, +y up);  spin: signed smoothed finger spin vs nominal
 *   div: the division currently in force while holding (hysteresis lives in the controller)
 *   beat: beatInfo() result;  sampleRate;  nominalRate: the normal playback rate (speed-dial relative to the reference rpm)
 * -> { worklet, bus, readout }
 */
export function derive(st, rt) {
  const out = { worklet: { ...WORKLET_OFF }, bus: { ...BUS_OFF }, readout: { text: '', division: null, percent: null, sliceMs: null, sliceFrac: null, beat: rt?.beat ? beatLabel(rt.beat) : '', fixedBeat: !!rt?.beat?.fixed, rateMult: 1 } };
  if (!rt || rt.blocked) return out;
  const eng = !!rt.engaged;
  const sr = rt.sampleRate > 0 ? rt.sampleRate : 44100;
  const beatSec = rt.beat?.beatSec > 0 ? rt.beat.beatSec : 0.5;
  const nominal = Number.isFinite(rt.nominalRate) && rt.nominalRate > 0 ? rt.nominalRate : 1;

  switch (st.mode) {
    case 'blend': {
      const amt = st.blend.byRadius && eng ? blendFromRadius(rt.u) : st.blend.amount;
      out.worklet = { ...WORKLET_OFF, mode: W_MODE.blend, engage: eng ? 1 : 0, rate: nominal, amount: amt };
      out.readout.text = `blend ${Math.round(amt * 100)}%`;
      break;
    }
    case 'repeat': {
      const div = isDivision(rt.div) ? rt.div : st.repeat.div;
      const m = repeatRateFromSpin(rt.spin);
      const pct = ratePercent(m);
      out.worklet = { ...WORKLET_OFF, mode: W_MODE.repeat, engage: eng ? 1 : 0, len: sliceFrames(div, beatSec, sr), rate: m, gate: 1, resume: st.repeat.resume === 'capture' ? 1 : 0 };
      Object.assign(out.readout, { division: div, percent: pct, rateMult: m, sliceMs: sliceMs(div, beatSec), sliceFrac: sliceFraction(div),
        text: `${div} ${formatPercent(pct)}` });
      break;
    }
    case 'stutter': {
      const div = isDivision(rt.div) ? rt.div : st.stutter.div;
      out.worklet = { ...WORKLET_OFF, mode: W_MODE.stutter, engage: eng ? 1 : 0, len: sliceFrames(div, beatSec, sr), rate: 1, gate: st.stutter.gate, resume: 0 };
      Object.assign(out.readout, { division: div, sliceMs: sliceMs(div, beatSec), sliceFrac: sliceFraction(div), text: `${div} gate ${Math.round(st.stutter.gate * 100)}%` });
      break;
    }
    case 'bandpass': {
      const freq = bpFreqFromX(rt.x), q = eng ? bpQFromY(rt.y) : st.bandpass.q;
      out.bus = { ...BUS_OFF, kind: 'bandpass', engaged: eng, freq, q, wet: 1 };
      out.readout.text = eng ? `${freq >= 1000 ? (freq / 1000).toFixed(1) + ' kHz' : Math.round(freq) + ' Hz'}  Q ${q.toFixed(1)}` : 'band pass';
      break;
    }
    case 'echo': {
      const wet = echoWetFromX(rt.x), fb = echoFeedbackFromY(rt.y);
      const div = isDivision(st.echo.delayDiv) ? st.echo.delayDiv : '1/2';
      out.bus = { ...BUS_OFF, kind: 'echo', engaged: eng, wet, feedback: fb, delaySec: clamp(beatSec * (DIVISIONS.includes(div) ? sliceFraction(div) : 0.5), 0.02, 1.9), balance: st.echo.balance };
      Object.assign(out.readout, { division: div, text: eng ? `wet ${Math.round(wet * 100)}%  fb ${Math.round(fb * 100)}%` : 'reverb / delay' });
      break;
    }
    default: break; // scratch: nothing changes (the normal platter path)
  }
  return out;
}
