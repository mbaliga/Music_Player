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
import { bakeMatSprite, bakeRecord, drawFrame, makeGeometry, setLayout, getLayoutName, armTransform } from './render.js';
import { Walkthrough } from './walkthrough.js';
import { LibraryManager, GridView } from './library.js';

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
const armEl = el('arm');

// ── boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  await state.engine.init();
  await loadTrack(synthesizeTrack(state.engine.sampleRate, 24));
  sizeCanvas();
  window.addEventListener('resize', sizeCanvas);
  installInput();
  installControls();
  installToolbar();
  installLibrary();
  installLayout();
  installPinchTransition();
  requestAnimationFrame(loop);
  updateLatencyReadout();
  showBuildId();
}

// ── Layout: Utilitarian (full disc, vertical) vs Cinematic (cropped, immersive)
function applyLayout(name) {
  setLayout(name);
  document.documentElement.dataset.layout = name;
  localStorage.setItem('runout.layout', name);
  sizeCanvas();   // recomputes geometry + re-points the SVG arm transform
}

function installLayout() {
  const saved = localStorage.getItem('runout.layout') || 'cinematic';
  applyLayout(saved);

  const pop = el('settingsPop');
  const gear = el('btnSettings');
  const toggle = (show) => {
    const open = show ?? pop.classList.contains('hidden');
    pop.classList.toggle('hidden', !open);
    gear.classList.toggle('active', open);
  };
  gear.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  pop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { if (!pop.classList.contains('hidden')) toggle(false); });

  pop.querySelectorAll('.sp-opt').forEach((b) => {
    b.addEventListener('click', () => { applyLayout(b.dataset.layout); toggle(false); });
  });
}

// Stamp which build this is, so a stale/cached APK download is obvious at a
// glance. The SHA is injected into the <meta> at CI build time; in local dev
// the placeholder is left untouched and we just say "dev".
function showBuildId() {
  const meta = document.querySelector('meta[name="build-id"]');
  const raw = meta?.getAttribute('content') || '';
  const id = (!raw || raw.includes('BUILD_ID')) ? 'dev' : raw;
  const node = el('buildId');
  if (node) node.textContent = 'build: ' + id;
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
  // Geometry is computed from the canvas's ACTUAL pixel box (in CSS px), so the
  // disc stays circular at any stage aspect. We back the canvas at device-pixel
  // resolution; drawFrame installs a uniform device scale. The SVG arm shares the
  // same CSS-px coordinate space via its viewBox, so it always lines up.
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(1, rect.width), H = Math.max(1, rect.height);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  state.geom = makeGeometry(W, H);
  armEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  armEl.querySelector('#armGroup').setAttribute('transform', armTransform(state.geom));
  rebake();
}

function rebake() {
  // Mat (slipmat) is static + track-independent → bake once. The record's groove
  // IS the waveform → rebake per track from the envelope.
  if (!state.matSprite) state.matSprite = bakeMatSprite();
  if (state.envelope) state.recordSprite = bakeRecord(state.envelope);
}

// ── the frame loop ─────────────────────────────────────────────────────────
function loop(now) {
  // Floor dt as well as cap it: on a 120 Hz panel (or when two rAF timestamps
  // land sub-millisecond apart) an un-floored dt makes angleDelta/dt explode —
  // and at dt≈0 it's Infinity/NaN, which would become the kinematic ω and
  // poison the audio rate. 1 ms floor keeps the scrub velocity finite.
  const dt = state.lastFrameTime ? clamp((now - state.lastFrameTime) / 1000, 0.001, 0.05) : 0.016;
  state.lastFrameTime = now;

  // 1. Resolve finger angular velocity (scrub) from the current pointer angle.
  if (state.touchingPlatter && dt > 0) {
    const ang = pointerAngle();
    // Clamp to a sane hand-scrub range so a single jumpy frame can't fling the
    // platter (or feed a NaN into the rate). ±40 rad/s ≈ 380 rpm — well past any
    // real backspin, so legitimate scrubs are untouched.
    state.fingerOmega = clamp(angleDelta(state.prevFingerAngle, ang) / dt, -40, 40);
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

  // 5. Render: static mat + the record spinning on top. The tonearm is the
  // screen-fixed SVG overlay; we only toggle its "lifted" pose on a silent seek.
  drawFrame(ctx, { mat: state.matSprite, record: state.recordSprite }, {
    theta: state.platter.theta,
    dust: clamp(state.playCount / 20, 0, 1),
  }, state.geom);

  if (state.seeking !== state._armLifted) {
    state._armLifted = state.seeking;
    armEl.classList.toggle('lifted', state.seeking);
  }

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
  // Geometry is in CSS px (the canvas box), so a client point maps straight in.
  const rect = canvas.getBoundingClientRect();
  return { x: client.x - rect.left, y: client.y - rect.top };
}

function radialDist(client) {
  const { cx, cy } = state.geom;
  const p = canvasPoint(client);
  return Math.hypot(p.x - cx, p.y - cy);
}

function installInput() {
  canvas.addEventListener('pointerdown', async (e) => {
    if (pinch.active) return;            // a two-finger pinch owns this gesture
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
  document.querySelectorAll('[data-rpm]').forEach((b) => {
    b.classList.toggle('active', Math.abs(Number(b.dataset.rpm) - rpm) < 0.01);
  });
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

// ── Library open / close + pinch transition ──────────────────────────────────
// The whole app screen lives in `.app`; the library is a fixed full-screen
// overlay above it. Pinch OUT zooms `.app` down while the library fades in
// (zoom out of one record into the crate); pinch IN reverses it.

const appEl = () => document.querySelector('.app');
const libEl = () => el('libOverlay');
const barEl = () => document.querySelector('.toolbar');

// Shared pinch state, read by the canvas pointerdown guard above.
const pinch = { active: false, mode: null, d0: 0, progress: 0 };

function clearTransientStyles() {
  const a = appEl(), l = libEl(), b = barEl();
  a.style.transition = ''; a.style.transform = ''; a.style.opacity = '';
  l.style.transition = ''; l.style.opacity = '';
  b.style.transition = ''; b.style.opacity = '';
}

function openLibrary() {
  clearTransientStyles();
  libEl().classList.remove('hidden');
}

function closeLibrary() {
  clearTransientStyles();
  libEl().classList.add('hidden');
}

function installPinchTransition() {
  const touchDist = (t) => Math.hypot(
    t[0].clientX - t[1].clientX,
    t[0].clientY - t[1].clientY,
  );

  // NON-PASSIVE touch listeners. The instant a 2nd finger lands we call
  // preventDefault() so the Android WebView never starts its own scroll/zoom —
  // which would otherwise fire pointercancel and kill the gesture. This is THE
  // fix: a passive listener can't preventDefault, so the pinch never survived.
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && !pinch.active) {
      e.preventDefault();
      beginPinch(touchDist(e.touches));
    }
  }, { passive: false });

  document.addEventListener('touchmove', (e) => {
    if (pinch.active && e.touches.length === 2) {
      e.preventDefault();
      updatePinch(touchDist(e.touches));
    }
  }, { passive: false });

  const end = (e) => { if (pinch.active && e.touches.length < 2) endPinch(); };
  document.addEventListener('touchend', end);
  document.addEventListener('touchcancel', end);

  function beginPinch(d0) {
    // Cancel any in-progress disc gesture so it doesn't fight the pinch.
    state.touchingPlatter = false;
    state.seeking = false;
    state.fingerOmega = 0;

    pinch.active = true;
    pinch.progress = 0;
    pinch.d0 = d0 || 1;
    pinch.mode = libEl().classList.contains('hidden') ? 'open' : 'close';

    const a = appEl(), l = libEl();
    a.style.transition = 'none';
    l.style.transition = 'none';
    if (pinch.mode === 'open') {
      l.classList.remove('hidden');
      l.style.opacity = '0';
    }
  }

  function updatePinch(d) {
    const a = appEl(), l = libEl(), b = barEl();
    if (pinch.mode === 'open') {
      const t = clamp((d / pinch.d0 - 1) * 2.2, 0, 1); // spread → t
      pinch.progress = t;
      a.style.transform = `scale(${1 - t * 0.4})`;
      a.style.opacity = String(1 - t * 0.5);
      b.style.opacity = String(1 - t);
      l.style.opacity = String(t);
    } else {
      const t = clamp((pinch.d0 / d - 1) * 2.2, 0, 1); // squeeze → t
      pinch.progress = t;
      l.style.opacity = String(1 - t);
      a.style.transform = `scale(${0.6 + t * 0.4})`;
      a.style.opacity = String(0.5 + t * 0.5);
      b.style.opacity = String(t);
    }
  }

  function endPinch() {
    const a = appEl(), l = libEl(), b = barEl();
    const commit = pinch.progress > 0.4;
    const wantLib = pinch.mode === 'open' ? commit : !commit;

    const T = 'transform .3s cubic-bezier(.4,0,.2,1), opacity .3s';
    a.style.transition = T;
    b.style.transition = 'opacity .3s';
    l.style.transition = 'opacity .3s';

    requestAnimationFrame(() => {
      if (wantLib) {
        l.style.opacity = '1';
        a.style.transform = 'scale(0.4)';
        a.style.opacity = '0';
        b.style.opacity = '0';
      } else {
        l.style.opacity = '0';
        a.style.transform = '';
        a.style.opacity = '';
        b.style.opacity = '';
      }
      setTimeout(() => {
        if (wantLib) openLibrary(); else closeLibrary();
      }, 320);
    });

    pinch.active = false;
    pinch.mode = null;
  }
}

// ── Toolbar: walkthrough, mode, theme ────────────────────────────────────────
function installToolbar() {
  const root = document.documentElement;
  const walkthrough = new Walkthrough();

  // Show walkthrough on first run.
  walkthrough.showIfFirstRun();
  el('btnWalkthrough').addEventListener('click', () => walkthrough.show(0));

  // Audiophile / Casual mode toggle.
  const btnMode = el('btnMode');
  let mode = 'casual';
  btnMode.addEventListener('click', () => {
    mode = mode === 'casual' ? 'audiophile' : 'casual';
    root.dataset.mode = mode;
    btnMode.textContent = mode === 'audiophile' ? '♦' : '◦';
    btnMode.classList.toggle('active', mode === 'audiophile');
  });

  // Light / dark theme toggle. Persist choice.
  const btnTheme = el('btnTheme');
  const applyTheme = (t) => {
    root.dataset.theme = t;
    btnTheme.textContent = t === 'dark' ? '☾' : '☀';
    localStorage.setItem('runout.theme', t);
  };
  const savedTheme = localStorage.getItem('runout.theme') || 'dark';
  applyTheme(savedTheme);
  btnTheme.addEventListener('click', () => {
    applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  // Library open handled in installLibrary (needs grid refresh).
}

// ── Library overlay ───────────────────────────────────────────────────────────
function installLibrary() {
  const library = new LibraryManager();
  const gridEl  = el('albumGrid');
  const scanBtn = el('libScan');
  const progressEl = document.createElement('div');
  progressEl.className = 'lib-progress';
  progressEl.style.display = 'none';
  el('libGridWrap').insertBefore(progressEl, gridEl);

  const grid = new GridView(gridEl, library, async (file) => {
    el('libOverlay').classList.add('hidden');
    await state.engine.resume();
    const track = await loadFile(file, state.engine.ctx);
    await loadTrack(track);
  });

  // Render the grid immediately so it's ready when the pinch transition opens it.
  grid.render();

  el('btnLibrary').addEventListener('click', () => { openLibrary(); grid.render(); });
  el('libClose').addEventListener('click', closeLibrary);

  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true;
    scanBtn.textContent = 'Scanning…';
    progressEl.style.display = 'block';
    progressEl.textContent = 'Starting…';

    await library.scan((done, total) => {
      progressEl.textContent = `${done} / ${total} files…`;
      grid.render(); // live-fill the grid as albums come in
    });

    scanBtn.disabled = false;
    scanBtn.textContent = 'Scan music folder…';
    progressEl.style.display = 'none';
    grid.render();
  });

  el('sortChips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-sort]');
    if (!chip) return;
    el('sortChips').querySelectorAll('.sort-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    grid.setSort(chip.dataset.sort);
  });
}

boot().catch((err) => {
  document.getElementById('latency').textContent = 'boot error: ' + err.message;
  console.error(err);
});
