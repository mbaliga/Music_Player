// ─────────────────────────────────────────────────────────────────────────────
// main.js — v0 wiring: input → platter physics → audio engine → render.
//
// Control path (spec §3):
//   touch (raf cadence) → platter physics → target rate
//                       → SAB control channel → worklet (per-sample slew) → DAC
//
// Who owns audio time `t`: the WORKLET integrates readPosition from rate
// (sample-accurate, jitter-immune). This thread only READS it back to position
// the needle. We never integrate audio time on the main thread (spec §4).
// ─────────────────────────────────────────────────────────────────────────────

import { AudioEngine } from './audio-engine.js';
import { synthesizeTrack, loadFile } from './track.js';
import {
  createPlatter, stepPlatter, rateFromOmega, omegaNominal,
  computeEnvelope, radiusAtTime, timeAtRadius, angleDelta, clamp, TAU,
  DEFAULT_PARAMS,
} from './model.js';
import { bakeGroove, drawFrame, makeGeometry } from './render.js';

// The track is mastered for one fixed reference speed. The needle plays it
// correctly at this RPM (rate = 1). Moving the speed dial above/below it shifts
// pitch AND tempo together — the authentic 33→45 transform (spec §5).
const REFERENCE_RPM = 33 + 1 / 3;

const state = {
  engine: new AudioEngine(),
  params: { ...DEFAULT_PARAMS },
  platter: createPlatter(),
  rpm: REFERENCE_RPM,        // current speed-dial setting
  track: null,
  envelope: new Float32Array(0),
  sprite: null,
  geom: null,
  T: 1,                      // track duration (seconds)
  frames: 0,

  // input
  touchingPlatter: false,
  braking: false,
  seeking: false,
  pointer: { x: 0, y: 0 },
  prevFingerAngle: 0,
  fingerOmega: 0,
  seekRadius: 0,

  // wear / atmosphere
  playCount: Number(localStorage.getItem('runout.playCount') || 0),
  reachedEnd: false,

  lastFrameTime: 0,
};

const el = (id) => document.getElementById(id);
const canvas = el('disc');
const ctx = canvas.getContext('2d');

// ── boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  await state.engine.init();
  await loadTrack(synthesizeTrack(state.engine.sampleRate, 24));
  sizeCanvas();
  window.addEventListener('resize', sizeCanvas);
  installInput();
  installControls();
  requestAnimationFrame(loop);
  updateLatencyReadout();
}

async function loadTrack(track) {
  state.track = track;
  state.frames = track.frames;
  state.T = track.frames / state.engine.sampleRate;

  // Envelope: windowed RMS over a mono mixdown. (Off-thread in v1; cheap enough
  // inline for one synthesized track in v0.)
  const [L, R] = track.channels;
  const mono = (i) => (R ? (L[i] + R[i]) * 0.5 : L[i]);
  state.envelope = computeEnvelope(mono, track.frames, 1024);

  await state.engine.load(track.channels, track.frames);
  state.engine.setRate(0);
  state.reachedEnd = false;
  el('trackName').textContent = track.name;
  rebake();
}

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const wrap = canvas.parentElement;
  // On mobile (single-col) wrap.clientHeight is 0 because the row is auto-sized;
  // fall back to viewport fractions. On desktop it's the actual stage height.
  const stageH = wrap.clientHeight > 10 ? wrap.clientHeight : window.innerHeight;
  const css = Math.min(
    wrap.clientWidth,
    stageH,
    window.innerHeight * 0.62,
  );
  canvas.style.width = css + 'px';
  canvas.style.height = css + 'px';
  canvas.width = Math.round(css * dpr);
  canvas.height = Math.round(css * dpr);
  state.geom = makeGeometry(canvas.width);
  rebake();
}

function rebake() {
  if (!state.geom || !state.envelope) return;
  state.sprite = bakeGroove(state.envelope, state.geom);
}

// ── the frame loop ─────────────────────────────────────────────────────────
function loop(now) {
  const dt = state.lastFrameTime ? Math.min(0.05, (now - state.lastFrameTime) / 1000) : 0.016;
  state.lastFrameTime = now;

  // 1. Resolve finger angular velocity (scrub) from the current pointer angle.
  if (state.touchingPlatter && dt > 0) {
    const ang = pointerAngle();
    state.fingerOmega = angleDelta(state.prevFingerAngle, ang) / dt;
    state.prevFingerAngle = ang;
  }

  // 2. Step the platter physics (pure model). Motor target follows the dial.
  const omegaTarget = omegaNominal(state.rpm);
  state.platter = stepPlatter(
    state.platter,
    {
      touching: state.touchingPlatter,
      fingerOmega: state.fingerOmega,
      braking: state.braking,
      omegaTarget,
    },
    dt,
    state.params,
  );

  // 3. Platter ω → playback rate (normalized to the FIXED reference RPM).
  const rate = state.seeking ? 0 : rateFromOmega(state.platter.omega, REFERENCE_RPM);
  state.engine.setRate(rate);

  // 4. Read audio time back from the worklet to position the needle.
  const t = state.engine.position / state.engine.sampleRate;

  // wear: bump play count once when the needle first reaches the runout
  if (!state.reachedEnd && t >= state.T - 0.05 && !state.seeking) {
    state.reachedEnd = true;
    state.playCount += 1;
    localStorage.setItem('runout.playCount', String(state.playCount));
  }
  if (t < state.T - 0.2) state.reachedEnd = false;

  // 5. Render: rotated blit of the baked groove + the screen-fixed needle.
  const needleT = state.seeking ? timeAtRadius(state.seekRadius, state.T, state.geom.rOut, state.geom.rIn) : t;
  drawFrame(ctx, state.sprite, {
    theta: state.platter.theta,
    t: needleT,
    T: state.T,
    dust: clamp(state.playCount / 20, 0, 1),
    lifted: state.seeking,
  }, state.geom);

  updateHud(rate, t);
  requestAnimationFrame(loop);
}

// ── input ────────────────────────────────────────────────────────────────────
// Pointer events keep the layer multitouch-capable (two-hand gestures reserved
// for later, spec §5). v0 uses the primary pointer.

function pointerAngle() {
  const { cx, cy } = state.geom;
  const p = canvasPoint(state.pointer);
  return Math.atan2(p.y - cy, p.x - cx);
}

function canvasPoint(client) {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return { x: (client.x - rect.left) * sx, y: (client.y - rect.top) * sy };
}

function radialDist(client) {
  const { cx, cy } = state.geom;
  const p = canvasPoint(client);
  return Math.hypot(p.x - cx, p.y - cy);
}

function installInput() {
  canvas.addEventListener('pointerdown', async (e) => {
    canvas.setPointerCapture(e.pointerId);
    await state.engine.resume();
    state.pointer = { x: e.clientX, y: e.clientY };
    const d = radialDist(state.pointer);
    const { rIn, rOut } = state.geom;

    // Grab the tonearm (seek) when starting near/outside the outer edge; grab
    // the platter (scrub) when starting on the groove annulus.
    if (d > rOut * 0.9) {
      state.seeking = true;
      state.engine.setPlaying(false);     // tonearm lifted = music bus silent
      state.seekRadius = clamp(d, rIn, rOut);
    } else if (d >= rIn * 0.9) {
      state.touchingPlatter = true;
      state.prevFingerAngle = pointerAngle();
      state.fingerOmega = 0;
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    state.pointer = { x: e.clientX, y: e.clientY };
    if (state.seeking) {
      const { rIn, rOut } = state.geom;
      state.seekRadius = clamp(radialDist(state.pointer), rIn, rOut);
    }
  });

  const endPointer = () => {
    if (state.seeking) {
      // Tonearm set-down: hard jump to the time under the needle, music resumes.
      const tSeek = timeAtRadius(state.seekRadius, state.T, state.geom.rOut, state.geom.rIn);
      state.engine.seek(tSeek * state.engine.sampleRate);
      state.engine.setPlaying(true);
      state.seeking = false;
    }
    if (state.touchingPlatter) {
      // Release: motor reclaims, ω winds back up to speed — you hear it.
      state.touchingPlatter = false;
      state.fingerOmega = 0;
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // Palm brake — spacebar mirrors the on-screen HOLD-TO-BRAKE pad.
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); state.braking = true; }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { e.preventDefault(); state.braking = false; }
  });
}

// ── controls / HUD ───────────────────────────────────────────────────────────
function installControls() {
  // Speed dial: discrete buttons + continuous slider (spec §5).
  document.querySelectorAll('[data-rpm]').forEach((b) => {
    b.addEventListener('click', () => setRpm(Number(b.dataset.rpm)));
  });
  const rpmSlider = el('rpmSlider');
  rpmSlider.addEventListener('input', () => setRpm(Number(rpmSlider.value)));

  // Palm-brake pad (hold).
  const brakePad = el('brakePad');
  const press = (v) => () => { state.braking = v; brakePad.classList.toggle('active', v); };
  brakePad.addEventListener('pointerdown', press(true));
  brakePad.addEventListener('pointerup', press(false));
  brakePad.addEventListener('pointerleave', press(false));

  // Live feel knobs — dialing these by hand is most of v0's job (spec §4).
  bindKnob('knobJ', 'J');
  bindKnob('knobK', 'k');
  bindKnob('knobC', 'c');
  bindKnob('knobBrake', 'brakeDamp');

  // Load a local file (drag-drop or picker).
  const file = el('fileInput');
  file.addEventListener('change', async () => {
    if (file.files[0]) {
      await state.engine.resume();
      await loadTrack(await loadFile(file.files[0], state.engine.ctx));
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) { await state.engine.resume(); await loadTrack(await loadFile(f, state.engine.ctx)); }
  });

  setRpm(REFERENCE_RPM);
}

function setRpm(rpm) {
  state.rpm = rpm;
  el('rpmSlider').value = String(rpm);
  el('rpmReadout').textContent = rpm.toFixed(1).replace(/\.0$/, '');
}

function bindKnob(id, key) {
  const k = el(id);
  k.value = String(state.params[key]);
  const out = el(id + 'Val');
  const sync = () => {
    state.params[key] = Number(k.value);
    if (out) out.textContent = Number(k.value).toFixed(2);
  };
  k.addEventListener('input', sync);
  sync();
}

function updateLatencyReadout() {
  const lat = state.engine.latencyEstimate;
  const ms = (s) => (s * 1000).toFixed(1);
  const total = lat.total * 1000;
  const verdict = total < 30 ? 'on the sound ✓' : total < 50 ? 'acceptable' : 'breaks the illusion ✗';
  el('latency').innerHTML =
    `output-latency est: <b>${ms(lat.total)} ms</b> ` +
    `(base ${ms(lat.base)} + output ${ms(lat.output)}) — ${verdict}<br>` +
    `<span class="dim">memory: ${state.engine.usingSAB ? 'SharedArrayBuffer (lock-free control)' : 'postMessage fallback — not cross-origin isolated, measure the SAB path for the §3 gate'}</span>`;
}

let hudCounter = 0;
function updateHud(rate, t) {
  if ((hudCounter++ & 0x7) !== 0) return; // ~8 Hz
  el('rate').textContent = rate.toFixed(2) + '×';
  el('pos').textContent = `${t.toFixed(1)} / ${state.T.toFixed(1)} s`;
  el('wear').textContent = `${state.playCount} plays`;
}

boot().catch((err) => {
  document.getElementById('latency').textContent = 'boot error: ' + err.message;
  console.error(err);
});
