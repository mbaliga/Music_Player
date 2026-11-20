// ─────────────────────────────────────────────────────────────────────────────
// main.js — wiring: input → platter physics → audio engine → the turntable stage.
//
// Control path (spec §3):
//   touch (raf cadence) → platter physics → target rate
//                       → SAB control channel → worklet (per-sample slew) → DAC
//
// Who owns audio time `t`: the WORKLET integrates readPosition from rate
// (sample-accurate, jitter-immune). This thread only READS it back to position
// the arm. We never integrate audio time on the main thread (spec §4).
//
// The Albums page is the "Vinyl player" (src/turntable/, docs/TURNTABLE.md): stage.js draws and owns the gestures, this file owns the audio.
// ─────────────────────────────────────────────────────────────────────────────

import { AudioEngine } from './audio-engine.js';
import { synthesizeTrack, loadFile } from './track.js';
import {
  createPlatter, stepPlatter, rateFromOmega, omegaNominal,
  computeEnvelope, angleDelta, clamp, DEFAULT_PARAMS,
} from './model.js';
import { Walkthrough } from './walkthrough.js';
import {
  TONEARM_KNOBS, estimateDurations, buildArmLayout, locateS, seekTargetS, sFor, stepIndex,
  previousTarget, gapCentreS,
} from './tonearm.js';
import { NeedleFX } from './needle-fx.js';
import { CdView } from './cd-view.js';
import { CD_KNOBS, formatTime } from './cd.js';
import { MixtapeUI } from './mixtape-ui.js';
import { createShell } from './shell/nav.js';
import { initDeviceMode } from './devicemode/index.js';   // Device mode: lock key, frozen face, keep-awake, always-on display (docs/DEVICE_MODE.md)
let deviceMode = null;
import { mountBooth } from './shell/booth.js';
import { createEngineGate } from './engine-gate.js';
import { LibraryManager } from './library.js';
import { deviceLibrary, installDeviceLibrary } from './device/index.js';   // the phone's own audio library (Android app only; docs/DEVICE_LIBRARY.md)
import { createStage } from './turntable/stage.js';
import { FINISHED } from './turntable/state.js';
import { mountTurntableLibrary } from './turntable/library.js';
import { albumsToCoverflow, builtinTestPressing, TEST_PRESSING_ID } from './turntable/library-layout.js';
import {
  parseTheme, clearThemeVars,
  storeTheme, loadStoredTheme, clearStoredTheme, builtinThemeTemplate, exportThemeText,
} from './theme.js';
import { initSettings } from './settings/wire.js';
import { createSearchLauncher } from './search/wire.js';
import { bindSearchActions } from './search/actions.js';
import { libraryPrefs, clearLibraryCache } from './library-prefs.js';

// The track is mastered for one fixed reference speed. The needle plays it
// correctly at this RPM (rate = 1). Moving the speed dial above/below it shifts
// pitch AND tempo together — the authentic 33→45 transform (spec §5).
const REFERENCE_RPM = 33 + 1 / 3;
const SPEEDS = { '33': REFERENCE_RPM, '45': 45, '78': 78 };
const TRIM = { min: 0.7, max: 1.3, step: 0.02 };   // the stage's −/+ buttons: ×.98 / ×1.02 of the chosen speed
const LS = { speed: 'runout.tt.speed', last: 'runout.tt.last' };
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

const state = {
  engine: new AudioEngine(),
  params: { ...DEFAULT_PARAMS },
  platter: createPlatter(),
  rpm: REFERENCE_RPM,        // current speed (preset x trim, or the fine-speed slider)
  speedBase: '33',           // '33' | '45' | '78' | null (fine slider)
  trim: 1,
  track: null,
  envelope: new Float32Array(0),
  T: 1,                      // track duration (seconds)
  frames: 0,

  // input
  touchingPlatter: false,
  braking: false,
  seeking: false,            // the tonearm is held (lifted, silent)
  prevFingerAngle: 0,
  fingerOmega: 0,

  // wear / atmosphere
  playCount: Number(localStorage.getItem('runout.playCount') || 0),
  reachedEnd: false,

  lastFrameTime: 0,

  // album context. queue = { kind:'vinyl'|'cd', index, items:[{file,title,dur}], albumId } or null for a single loose track.
  // layout = tonearm.js band layout on the unit chord (arm position s: 0 outer .. 1 inner) for the record.
  queue: null,
  layout: null,
  albumId: null,             // id of the album shown on the platter (library id, or TEST_PRESSING_ID)
  view: 'vinyl',             // 'vinyl' platter | 'cd' player
  vinylOwned: true,          // false while a mixtape / radio track is what the engine holds: the loop then keeps it at nominal speed as before
  cdPlaying: true,
  cdMute: false,             // brief CD "re-read" silence after a skip
  jumping: false,            // a track change is decoding (arm stays lifted)
  jumpS: 0,                  // where the arm shows while jumping
  trail: [],
  ghost: null,
  _inGap: false,
};

const el = (id) => document.getElementById(id);
let stage = null;           // src/turntable/stage.js
let tlib = null;            // the zoom-out library component
let library = null;        // LibraryManager
let shelf = [];            // library.albums() rows, index-aligned with `albums`
let albums = [];           // album objects for the library component (albumsToCoverflow)
const view = { kind: 'all', sort: 'artist' };

// ── settings: read before first paint (theme, accent, text size, motion), see src/settings/ and docs/SETTINGS.md ──────────────
const settings = initSettings();
const lsOk = () => { try { return window.localStorage; } catch { return null; } };
// the radio-side reads (saved stations, the flag, the canned index) and fx/persist.js are fetched on demand: the boot path stays free of
// radio and FX code (test/radio-core/boot-path, test/fx-ship). The bridge module is the single door for everything radio Search/Settings read.
let radioStoreMod = null, fxPersistMod = null;
const loadRadioStore = () => (radioStoreMod ? Promise.resolve(radioStoreMod) : import('./search/stations-bridge.js').then((m) => (radioStoreMod = m)));
const loadFxPersist = () => (fxPersistMod ? Promise.resolve(fxPersistMod) : import('./fx/persist.js').then((m) => (fxPersistMod = m)));

// ── boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  deviceMode = initDeviceMode(); window.runoutDeviceMode = deviceMode;   // first: its capture-phase guards must come before the shell's and the stage's listeners
  await state.engine.init();
  state.fx = new NeedleFX(state.engine.ctx);
  installTurntable();
  await loadTrack(synthesizeTrack(state.engine.sampleRate, 24), null, false, false);
  state.albumId = TEST_PRESSING_ID;
  installControls();
  installAlbumNav();
  installLibrary();     // albums (the zoom-out library), mixtapes, the lazy radio / booth hooks and the shell itself
  installDetails();     // needs the page headers the shell creates
  installToolbar();     // the drawer footer: walkthrough, mode, theme
  installCustomTheme();
  installSettingsAndSearch();
  requestAnimationFrame(loop);
  updateLatencyReadout();
  showBuildId();
}

// ── Settings section + global Search ─────────────────────────────────────────────────────────────────────────────────────
// The gear popover is gone: the Settings section (src/settings/page.js) has its functions. Search (src/search/) opens from the magnifier
// in the drawer and in every page header, Ctrl/Cmd+K and "/". What the app does for a setting / a search result is bound here.
let search = null;
const customThemeApi = { open: () => {}, subscribe: (fn) => settings.onCustomTheme(fn) };
function installSettingsAndSearch() {
  const S = settings.store;
  // haptics: the cassette player reads it live; the platter's gap buzz checks it in the loop
  const applyHaptics = () => { if (state.mixtapes) state.mixtapes.haptics = !!S.get('haptics'); };
  applyHaptics();
  // default speed: applied at once when changed here; at boot only when the turntable has no remembered speed of its own
  const RPM_ID = (v) => (v >= 77 ? '78' : v >= 44 ? '45' : '33');
  if (!lsGet(LS.speed) && RPM_ID(S.get('playback.defaultRpm')) !== state.speedBase) setSpeed(RPM_ID(S.get('playback.defaultRpm')));
  // audiophile mode (the old diamond button): persisted now
  const btnMode = el('btnMode');
  const applyMode = () => {
    const on = !!S.get('playback.audiophile');
    document.documentElement.dataset.mode = on ? 'audiophile' : 'casual';
    btnMode.textContent = on ? '♦' : '◦'; btnMode.classList.toggle('active', on);
  };
  applyMode();
  btnMode.addEventListener('click', () => S.set('playback.audiophile', !S.get('playback.audiophile')));
  S.subscribe((all, path) => {
    if (path === 'haptics' || path === '*') applyHaptics();
    if (path === 'playback.audiophile' || path === '*') applyMode();
    if (path === 'playback.defaultRpm') setSpeed(RPM_ID(all.playback.defaultRpm));
    if (path === 'radio.aiStations' && radio && radio._aiOn() !== all.radio.aiStations) radio._setAi(all.radio.aiStations);
  });
  el('btnTheme').addEventListener('click', () => settings.toggleLightDark());

  // Search
  search = createSearchLauncher({
    storage: lsOk(),
    remember: () => S.get('privacy.rememberSearches'),
    getSources: () => ({
      library,
      mixtapes: state.mixtapes ? state.mixtapes.list : [],
      radioModel: radio ? radio.store : (radioStoreMod ? radioStoreMod.loadModel(lsOk()) : null),
      aiOn: (settings.store.refresh(), !!settings.store.get('radio.aiStations')),
    }),
    getCannedIndex: async () => (await loadRadioStore()).loadCannedIndex(document.baseURI),
    prepare: () => loadRadioStore().catch(() => {}),
    onOpen: () => { shell && shell.close(); },
  });
  el('btnSearch').addEventListener('click', () => search.open());
  library.onChange?.(() => search.invalidate());
  bindSearchActions(searchActionsImpl());
}

// What the Settings page needs of the app (src/settings/page.js documents the shape).
function settingsDeps(devLib) {
  const stored = () => { try { return loadStoredTheme(); } catch { return null; } };
  const model = () => (radio ? radio.store : (radioStoreMod ? radioStoreMod.loadModel(lsOk()) : { favs: [], recents: [] }));
  const commit = (m) => { if (radio) { radio._commit(m); radio._renderSaved(); } else if (radioStoreMod) radioStoreMod.saveModel(lsOk(), m); };
  return {
    store: settings.store,
    customTheme: {
      status: () => { const s = stored(); return s ? `Custom: ${s.name}` : 'Built-in (default)'; },
      open: () => customThemeApi.open(),
      exportText: () => exportThemeText(stored() || builtinThemeTemplate()),
      reset: () => { clearStoredTheme(); clearThemeVars(); settings.customThemeChanged(); },
      subscribe: (fn) => settings.onCustomTheme(fn),
    },
    layouts: [],   // the old compact / utilitarian / cinematic turntable layouts no longer exist (T1/T2's single stage): the row is hidden
    library: {
      prefs: libraryPrefs,
      deviceAvailable: () => !!(devLib && devLib.isAvailable()),
      mountScanCard: (c) => { if (devLib && devLib.isAvailable() && devLib.mountScanCard) devLib.mountScanCard(c); },
      scanNow: async () => { if (devLib && devLib.isAvailable() && libraryPrefs.get().sources.device) await devLib.allowAndScan(); else await scanLibrary(); },
      clearCache: async () => { await clearLibraryCache(); flash('CACHE CLEARED'); },
    },
    playback: { openDeckDetails: () => { shell.go('albums'); const s = el('deckSheet'); if (s && s.hidden) el('btnDeck').click(); } },
    radio: {
      favouriteCount: () => model().favs.length, recentCount: () => model().recents.length,
      clearFavourites: () => commit({ ...model(), favs: [] }), clearRecents: () => commit(radioStoreMod ? radioStoreMod.clearRecents(model()) : model()),
      resetVoices: () => loadRadioStore().then((m) => m.resetHostVoices(lsOk())).catch(() => {}),
    },
    booth: { ringOn: () => { try { return fxPersistMod ? !!fxPersistMod.loadFx(lsOk()).ring : null; } catch { return null; } } },
    deviceMode: deviceMode ? { open: () => import('./devicemode/sheet.js').then((m) => m.openSheet({ settings: deviceMode.settings })).catch(() => {}) } : null,
    privacy: { clearSearches: () => search && search.clearRecents() },
    about: { build: (el('buildId') && el('buildId').textContent) || 'build: dev', walkthrough: () => { shell.close(); walkthrough && walkthrough.show(0); } },
  };
}

// What a search result does. Each returns true when handled. Seams for the coverflow (T1/T2) and the mixtape maker (D) are marked.
function searchActionsImpl() {
  const gotoSection = async (id) => { shell.go(id, { close: true }); await shell.ensure(id); };
  const trackObj = (id) => (library.tracks || []).find((t) => t.id === id) || null;
  const locate = (id) => {   // { index into `albums`, trackIndex } of the library track, making the album visible if a filter hides it
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < shelf.length; i++) { const k = shelf[i].tracks.findIndex((t) => t.id === id); if (k >= 0) return { index: i, trackIndex: k }; }
      if (view.kind === 'all') break;
      view.kind = 'all'; tlib.setFilter && tlib.setFilter('all'); rebuildAlbums();
    }
    return null;
  };
  const albumIndex = (albumId) => { let i = shelf.findIndex((a) => a.id === albumId); if (i < 0 && view.kind !== 'all') { view.kind = 'all'; tlib.setFilter && tlib.setFilter('all'); rebuildAlbums(); i = shelf.findIndex((a) => a.id === albumId); } return i; };
  // play the library track `id` the way a tap in the library does (album queue, CD view for CDs)
  async function playLibraryTrack(id) {
    const at = locate(id);
    if (!at) return false;
    const a = albums[at.index];
    await gotoSection('albums');
    await state.engine.resume();
    stage.dispatch({ type: 'zoomTo', z: 0 });
    if (a.kind === 'cd') { delete el('pageAlbums').dataset.lib; if (await loadAlbum(at.index, at.trackIndex)) { state.cdPlaying = true; return true; } return false; }
    stage.dispatch({ type: 'stop', s: 0 });
    if (!(await loadAlbum(at.index, at.trackIndex))) return false;
    stage.setDisplay({ lit: true });
    playTarget({ index: at.trackIndex, time: 0 }, { needle: false });
    return true;
  }
  return {
    playTrack: (id) => playLibraryTrack(id),
    // SEAM (T1/T2): focus the album on the coverflow and zoom out to it. Uses tlib.focus + the stage's zoomTo (docs/TURNTABLE_LIBRARY.md).
    async openAlbum(albumId) {
      const i = albumIndex(albumId);
      if (i < 0) return false;
      await gotoSection('albums');
      tlib.focus(i, { animate: false });
      stage.dispatch({ type: 'zoomTo', z: 1 });
      return true;
    },
    // artist "Play all": the artist's songs as one queue
    async playTracks(ids) {
      const list = ids.map(trackObj).filter(Boolean);
      const first = list.findIndex((t) => t.file);
      if (first < 0) { flash('RE-LINK FILES'); return false; }
      await gotoSection('albums');
      await state.engine.resume();
      stage.dispatch({ type: 'zoomTo', z: 0 }); stage.dispatch({ type: 'stop', s: 0 });
      const track = await loadFile(list[first].file, state.engine.ctx);
      state.albumId = null;
      await loadTrack(track, queueFor({ kind: 'vinyl', id: null, tracks: list }, first));
      stage.setDisplay({ lit: true });
      playTarget({ index: first, time: 0 }, { needle: false });
      syncDisplay(); syncAlbumUI();
      return true;
    },
    // artist drill-down lives in the search overlay; Albums has no artist filter yet (SEAM: sort 'artist' + focus the first album)
    async openArtist(name) {
      const lk = (library.albums('artist') || []).findIndex((a) => String(a.artist).toLowerCase() === String(name).toLowerCase());
      if (lk < 0) return false;
      await gotoSection('albums'); tlib.focus(lk, { animate: false }); stage.dispatch({ type: 'zoomTo', z: 1 });
      return true;
    },
    async openMixtape(id) {
      const m = state.mixtapes && state.mixtapes.byId(id);
      if (!m) return false;
      await gotoSection('mixtapes');
      await state.mixtapes.startPlayback(m);
      return true;
    },
    async playStation(s) {
      await gotoSection('radio').catch(() => {});
      if (!radio) return false;
      let station = s;
      if (typeof s === 'string') { const [type, ...rest] = s.split('|'); const id = rest.join('|'); station = [...radio.store.favs, ...radio.store.recents].map((e) => ({ ...e.snap, type: e.type, id: e.id })).find((x) => x.type === type && x.id === id); }
      if (!station || !station.type) return false;
      radio.play(station);
      return true;
    },
    // addToMixtape(trackIds): opens the mixtape editor on a NEW unsaved draft holding these library tracks (Workstream D: MixtapeUI.startFrom).
    async addToMixtape(ids) {
      if (!state.mixtapes || !Array.isArray(ids) || !ids.length) return false;
      await gotoSection('mixtapes');
      return !!state.mixtapes.startFrom({ trackIds: ids });
    },
  };
}

// `q` is the album context when the track was picked from an album/CD; every other caller (file picker, drop, mixtape) passes none
// and gets a plain single-track record.
// Radio decodes are cancellable: every Stop / source switch / user-started track bumps the gate, and a radio load or prepare
// that began earlier refuses to install its song (see sr./engine-gate.js).
// `foreign` = a mixtape tape player loaded it: the engine is then not the vinyl player's (see state.vinylOwned).
const engineGate = createEngineGate();
let foreignPlaybackHook = null; // set once the Radio tab exists: ends an engine-backed station when the user starts their own track
async function loadTrack(track, q = null, fromRadio = false, foreign = false) {
  if (!fromRadio) { engineGate.bump(); try { foreignPlaybackHook && foreignPlaybackHook(); } catch { /* */ } }
  state.vinylOwned = !(fromRadio || foreign);
  state.track = track;
  state.frames = track.frames;
  state.T = track.frames / state.engine.sampleRate;
  state.queue = q;
  if (q) q.items[q.index].dur = state.T;
  setView(q?.kind === 'cd' ? 'cd' : 'vinyl');

  // Envelope: windowed RMS over a mono mixdown (mixtape level meter, You Radio). The spiral's min/max peaks are a separate pass
  // over the same PCM (turntable/spiral.js computePeaks), made in refreshRecord().
  const [L, R] = track.channels;
  const mono = (i) => (R ? (L[i] + R[i]) * 0.5 : L[i]);
  state.envelope = computeEnvelope(mono, track.frames, 1024);

  await state.engine.load(track.channels, track.frames);
  state.engine.setPlaying(!state.radioOn); // load() re-arms the bus; keep it muted under a live station
  state.engine.setRate(0);
  state.reachedEnd = false;
  refreshRecord();
  syncAlbumUI();
}

// Record layout: one band per album track (single track = the classic record), on the unit chord.
function rebuildLayout() {
  const known = state.queue ? state.queue.items.map((it) => it.dur) : [state.T];
  state.layout = buildArmLayout(estimateDurations(known));
}
// Spiral peaks + the dot display's name / pips for what the engine holds now.
function refreshRecord() {
  rebuildLayout();
  if (!stage) return;
  const ch = state.track && state.track.channels;
  stage.setRecord({ layout: state.layout, current: state.queue?.index ?? 0, channels: ch || null, frames: state.frames });
  if (!ch) stage.setRecordFromEnvelope(state.layout, state.queue?.index ?? 0, state.envelope);   // a gapless join: the engine owns the PCM now
  syncDisplay();
}
function trackTitle() {
  const q = state.queue;
  return (q && q.items[q.index].title) || (state.track && state.track.name) || '';
}
function syncDisplay(extra = null) {
  if (!stage) return;
  const q = state.queue;
  stage.setDisplay({ name: trackTitle(), trackCount: q ? q.items.length : 1, trackIndex: q ? q.index : 0, ...(extra || null) });
}
let flashT = 0;
function flash(text) {   // a short message on the dot display ("RADIO ON", "RE-LINK FILES")
  stage.setDisplay({ name: text, lit: true, trackCount: 1 });
  clearTimeout(flashT); flashT = setTimeout(() => syncDisplay(), 2400);
}

// arm position s (0..1 along the album chord) for the audio time t
function currentS(t) {
  if (state.jumping) return state.jumpS;
  const q = state.queue;
  return q && state.layout ? sFor(state.layout, q.index, Math.min(t, state.T)) : clamp(state.T > 0 ? t / state.T : 0, 0, 1);
}

// ── the frame loop ─────────────────────────────────────────────────────────
// Physics + the engine's rate run every frame as before (mixtapes, radio and the Booth ride the same loop); DRAWING is demand-driven
// inside stage.update (it redraws only while something moves or changed).
function loop(now) {
  // Floor dt as well as cap it: on a 120 Hz panel (or when two rAF timestamps
  // land sub-millisecond apart) an un-floored dt makes angleDelta/dt explode —
  // and at dt≈0 it's Infinity/NaN, which would become the kinematic ω and
  // poison the audio rate. 1 ms floor keeps the scrub velocity finite.
  const dt = state.lastFrameTime ? clamp((now - state.lastFrameTime) / 1000, 0.001, 0.05) : 0.016;
  state.lastFrameTime = now;
  const pl = stage.player;

  // 1. Resolve finger angular velocity (scrub) from the current pointer angle (stage coordinates: a rotation of the screen, so
  //    the rotation SENSE is the same in portrait and landscape).
  if (state.touchingPlatter && dt > 0) {
    const ang = stage.scratchAngle();
    if (ang != null) {
      // Clamp to a sane hand-scrub range so a single jumpy frame can't fling the
      // platter (or feed a NaN into the rate). ±40 rad/s ≈ 380 rpm — well past any
      // real backspin, so legitimate scrubs are untouched.
      state.fingerOmega = clamp(angleDelta(state.prevFingerAngle, ang) / dt, -40, 40);
      state.prevFingerAngle = ang;
    }
  }

  // 2. Step the platter physics (pure model). The motor runs while the vinyl record is playing (Stop = motor off), or always for
  //    a mixtape / radio track as before. The motor target follows the speed.
  const vinylIdle = state.vinylOwned && state.view === 'vinyl' && !pl.playing;   // stopped, arm lowering, or arm held: frozen + silent
  const omegaTarget = vinylIdle ? 0 : omegaNominal(state.rpm);
  state.platter = stepPlatter(
    state.platter,
    { touching: state.touchingPlatter, fingerOmega: state.fingerOmega, braking: state.braking, omegaTarget },
    dt,
    state.params,
  );

  // 3. Platter ω → playback rate (normalized to the FIXED reference RPM).
  // CD view: steady 1x (or 0 when paused / re-reading) -- no platter, no pitch bend.
  const rate = state.view === 'cd'
    ? (state.cdPlaying && !state.jumping && !state.cdMute ? 1 : 0)
    : (vinylIdle || state.seeking || state.jumping ? 0 : rateFromOmega(state.platter.omega, REFERENCE_RPM));
  state.engine.setRate(rate);

  // 4. Read audio time back from the worklet to position the arm.
  const t = state.engine.position / state.engine.sampleRate;

  // wear: bump play count once when the needle first reaches the runout
  if (!state.reachedEnd && t >= state.T - 0.05 && !state.seeking && !state.jumping) {
    state.reachedEnd = true;
    state.playCount += 1;
    localStorage.setItem('runout.playCount', String(state.playCount));
    // A CD runs on to the next track by itself; so does a record side with more tracks on it (the needle crosses the gap).
    if (state.view === 'cd' && state.queue && stepIndex(state.queue.index, 1, state.queue.items.length) != null) {
      goTo({ index: state.queue.index + 1, time: 0 }, false);
    } else if (state.view === 'vinyl' && state.vinylOwned && pl.playing) onVinylTrackEnd();
  }
  if (t < state.T - 0.2) state.reachedEnd = false;

  // 5. Draw (vinyl) / CD view
  if (state.view === 'cd') {
    state.cd.draw({ t, T: state.T, playing: state.cdPlaying, dt, loading: state.jumping });
  }
  const e = state.envelope;
  stage.update(dt, {
    posS: currentS(t),
    dust: clamp(state.playCount / 20, 0, 1),
    level: e && e.length ? e[Math.max(0, Math.min(e.length - 1, Math.floor((t / Math.max(1e-3, state.T)) * e.length)))] : 0,
  });

  state.mixtapes?.tick(t, state.T, rate, dt);
  updateHud(rate, t);
  requestAnimationFrame(loop);
}

// The record ran out: the next track of the side (the needle crosses the gap and goes on), or the end of the album (frozen at the runout).
function onVinylTrackEnd() {
  const q = state.queue;
  if (q && stepIndex(q.index, 1, q.items.length) != null) {
    playTarget({ index: q.index + 1, time: 0 }, { needle: false });
  } else {
    stage.dispatch({ type: 'finished' });
  }
}

// ── the turntable stage: gestures in, hooks out ──────────────────────────────────────────────────────────────────────────
function installTurntable() {
  const host = el('ttStage');
  stage = createStage(host, {
    toggle: onToggle,
    speed: (id) => setSpeed(id),
    nudge: (dir) => { state.trim = clamp(+(state.trim * (dir < 0 ? 1 - TRIM.step : 1 + TRIM.step)).toFixed(4), TRIM.min, TRIM.max); applyRpm(); },
    // platter: dragging the disc scratches with the platter physics (finger angular velocity -> ω -> rate), the palm brake is a hold on the label
    scratchBegin: (angle) => { state.engine.resume(); state.touchingPlatter = true; state.prevFingerAngle = angle; state.fingerOmega = 0; },
    scratchEnd: () => { state.touchingPlatter = false; state.fingerOmega = 0; },   // release: the motor reclaims, ω winds back up to speed
    brake: (on) => { state.braking = on; },
    // the tonearm dimple: a silent seek along the carriage
    canGrab: () => state.view === 'vinyl' && !state.jumping && state.vinylOwned,
    armGrab: (s) => { state.engine.resume(); state.seeking = true; state.engine.setPlaying(false); state.fx?.lift(); state.trail = []; updateGhost(s); },
    armMove: (s) => updateGhost(s),
    armRelease: onArmRelease,
    armNudge: (dir) => nudgePlayhead(dir),
    effect: onStageEffect,
    beginAudio: onBeginAudio,
    analyser: () => getAnalyser(),
  });
  stage.setLibrary(tlib = mountTurntableLibrary(stage.libHost, { ...libraryDeps(), scanLabel: deviceLibrary.isAvailable() ? { long: 'Scan phone', short: 'Scan', hint: 'Scan your phone to fill the shelf' } : undefined }));
  wireLibrary();
  stage.setSpeedUI(state.speedBase);
  // rt test hooks (the prototype's window.__rt, plus the app handle for scripts/verify-turntable.py)
  window.__rt = Object.assign(stage.rt, {
    app: () => ({ state, stage, tlib, albums, shelf }),
    goTo: (t, n) => goTo(t, n),
  });
}

function onStageEffect(e) {
  if (e === 'silence') { if (state.vinylOwned && state.view === 'vinyl') state.engine.setPlaying(false); }
}
// the arm is down: open the bus (spin-up is the platter physics: ω climbs while the rate was held at 0)
function onBeginAudio() {
  if (!(state.vinylOwned && state.view === 'vinyl')) return;
  state.engine.setPlaying(!state.radioOn);
  state.fx?.drop();
}

let _ana = null;
function getAnalyser() {
  if (_ana) return _ana;
  try {
    const a = state.engine.ctx.createAnalyser();
    a.fftSize = 64; a.smoothingTimeConstant = 0.7;
    state.engine.musicBus.connect(a);    // a tap on the output (the real mix), nothing is connected after it
    _ana = a;
  } catch { _ana = null; }
  return _ana;
}

// ── Play / Stop ───────────────────────────────────────────────────────────────────────────────────────────────────────────
async function onToggle() {
  await state.engine.resume();
  const pl = stage.player;
  if (pl.playing || pl.starting) {
    stage.dispatch({ type: 'toggle', s: currentS(state.engine.position / state.engine.sampleRate) });   // Stop: freeze + the arm slides back and folds away
    return;
  }
  const owner = engineOwner();
  if (owner) { flash(owner === 'radio' ? 'RADIO ON' : 'TAPE ON'); return; }   // the engine is a station's / a tape's right now
  stage.setDisplay({ lit: true });
  if (!state.vinylOwned) {   // a loose track left by a mixtape / radio: take it over, resume where it is
    state.vinylOwned = true;
    stage.dispatch({ type: 'play', s: currentS(state.engine.position / state.engine.sampleRate) });
    return;
  }
  if (pl.frozenS > FINISHED) { playTarget({ index: 0, time: 0 }, { needle: false }); return; }   // a finished record restarts from 0
  stage.dispatch({ type: 'toggle' });                     // resumes where it stopped (frozenS)
}

// Put the needle down at `target` ({index, time}), lower the arm and play. Used by the library, next / previous, a finished record.
async function playTarget(target, { needle = false } = {}) {
  await state.engine.resume();
  state.vinylOwned = true;
  state.engine.setPlaying(false);
  stage.setDisplay({ lit: true });
  const s = sFor(state.layout, target.index, target.time);
  stage.dispatch({ type: 'play', s });
  state.jumpS = s;
  await goTo(target, needle);
}

// ── speed ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function setSpeed(id) { state.speedBase = id; state.trim = 1; applyRpm(); }
function applyRpm() { setRpm(SPEEDS[state.speedBase] * state.trim, true); }
function setRpm(rpm, fromPreset = false) {
  state.rpm = rpm;
  if (!fromPreset) { state.speedBase = null; state.trim = 1; }
  const slider = el('rpmSlider');
  if (slider) slider.value = String(rpm);
  const out = el('rpmReadout');
  if (out) out.textContent = rpm.toFixed(1).replace(/\.0$/, '');
  stage && stage.setSpeedUI(state.speedBase);
  lsSet(LS.speed, { base: state.speedBase, trim: state.trim, rpm });
}

// ── tonearm: ghost marker, set-down, track jumping ───────────────────────────────────────────────────────────────────────
// Pure mapping lives in tonearm.js (s -> track/gap, arm flick); this is only the glue. Tunables: TONEARM_KNOBS / ARM_KNOBS there.
function updateGhost(s) {
  const L = state.layout;
  const loc = locateS(L, s), tgt = seekTargetS(L, s);
  const multi = L.bands.length > 1, gap = loc.zone === 'gap';
  const label = gap ? `▸ track ${tgt.index + 1}` : (multi ? `${tgt.index + 1} · ` : '') + formatTime(tgt.time);
  if (gap && !state._inGap && settings.store.get('haptics')) { try { navigator.vibrate?.(8); } catch { /* no haptics */ } }
  state._inGap = gap;
  state.ghost = { s: gap ? gapCentreS(loc.gap) : s, label, gap };
  stage.setGhost(state.ghost);
}

function onArmRelease(s, flickDir) {
  const q = state.queue;
  let target = null;
  if (flickDir && q) {
    target = flickDir === 'next'
      ? (stepIndex(q.index, 1, q.items.length) != null ? { index: q.index + 1, time: 0 } : null)
      : previousTarget(q.index, state.engine.position / state.engine.sampleRate, q.items.length);
  }
  if (!target) target = seekTargetS(state.layout, s);
  state.ghost = null; stage.setGhost(null); state._inGap = false;
  state.seeking = false;
  const ts = sFor(state.layout, target.index, target.time);
  stage.dispatch({ type: 'play', s: ts });   // the arm settles on the target (a gap drop lands on the next track's 0:00)
  state.jumpS = ts;
  stage.setDrop(ts);
  goTo(target, true);
}
// keyboard: nudge the playhead along the track with the dimple focused (left = toward the inner groove)
function nudgePlayhead(dir) {
  const q = state.queue, t = state.engine.position / state.engine.sampleRate;
  const idx = q ? q.index : 0;
  const target = { index: idx, time: clamp(t + dir * 5, 0, Math.max(0, state.T - 0.5)) };
  stage.dispatch({ type: 'play', s: sFor(state.layout, target.index, target.time) });
  goTo(target, false);
}

// Commit a (index, time) target. Same track: a hard seek. Other track: decode it, then seek. `needle` = play the vinyl set-down
// sound/animation (CD skips are silent).
function goTo(target, needle) {
  const q = state.queue;
  const sr = state.engine.sampleRate;
  if (!q || target.index === q.index) {
    state.engine.seek(target.time * sr);
    state.reachedEnd = false;
    if (state.view === 'cd') cdSkipMute(); else finishDrop(needle);
    return Promise.resolve();
  }
  return jumpTo(target, needle);
}

async function jumpTo(target, needle) {
  const q = state.queue;
  if (!q || state.jumping) return;
  state.jumping = true;
  if (state.view === 'vinyl') { state.jumpS = sFor(state.layout, target.index, target.time); syncDisplay({ loading: true }); }
  state.engine.setPlaying(false);
  try {
    await state.engine.resume();
    const track = await loadFile(q.items[target.index].file, state.engine.ctx);
    q.index = target.index;
    await loadTrack(track, q);
    state.engine.seek(target.time * state.engine.sampleRate);
  } catch (err) {
    console.error('track jump failed', err);
  } finally {
    state.jumping = false;
    syncDisplay({ loading: false });
  }
  if (state.view === 'cd') cdSkipMute(); else finishDrop(needle);
}

// Needle lands: thump + ripple, then the music bus reopens a beat later (if the record is meant to be playing).
function finishDrop(needle) {
  if (needle) state.fx?.drop();
  setTimeout(() => {
    if (state.view === 'vinyl' && !(stage.player.playing || stage.player.starting)) return;   // stopped meanwhile: stay silent
    state.engine.setPlaying(!state.radioOn);
  }, needle ? TONEARM_KNOBS.dropDelayMs : 0);
}

// CD "re-read": a few ms of silence on any skip, then straight back at 1x.
function cdSkipMute() {
  state.cdMute = true;
  state.engine.setPlaying(!state.radioOn);
  setTimeout(() => { state.cdMute = false; }, CD_KNOBS.skipMuteMs);
}

// Album context for a pick from the library: the shelf item (vinyl LP or one CD disc) that holds the picked track.
function queueFor(item, index) {
  return {
    kind: item.kind,
    index,
    albumId: item.id,
    items: item.tracks.map((t) => ({ file: t.file, title: t.title, dur: Number.isFinite(t.durationSec) && t.durationSec > 0 ? t.durationSec : null })),
  };
}

function setView(v) {
  if (state.view === v && state._viewSet) return;
  state._viewSet = true;
  state.view = v;
  const page = el('pageAlbums');
  page.dataset.view = v;
  if (v === 'vinyl') delete page.dataset.lib;
  state.cd?.show(v === 'cd');
  if (v === 'cd') { state.cdPlaying = true; stage && stage.dispatch({ type: 'stop' }); }
}

function syncAlbumUI() {
  const q = state.queue;
  const n = q ? q.items.length : 0;
  el('trkNav').classList.toggle('hidden', !(n > 1 && state.view === 'vinyl'));
  if (q) el('trkIdx').textContent = `${q.index + 1} / ${n}`;
  if (q && state.view === 'cd') {
    state.cd.setTracks(q.items.map((it) => it.title), estimateDurations(q.items.map((it) => it.dur)), q.index);
  }
  tlib && tlib.setNowPlaying && tlib.setNowPlaying({ albumId: state.albumId, trackIndex: q ? q.index : 0 });
}

function stepTrack(dir) {
  const q = state.queue;
  if (!q || state.jumping) return;
  const t = state.engine.position / state.engine.sampleRate;
  const target = dir > 0
    ? (stepIndex(q.index, 1, q.items.length) != null ? { index: q.index + 1, time: 0 } : null)
    : previousTarget(q.index, t, q.items.length);
  if (!target) return;
  if (state.view === 'vinyl') { state.fx?.lift(); playTarget(target, { needle: true }); }
  else goTo(target, false);
}

function installAlbumNav() {
  el('btnPrevTrk').addEventListener('click', async () => { await state.engine.resume(); stepTrack(-1); });
  el('btnNextTrk').addEventListener('click', async () => { await state.engine.resume(); stepTrack(1); });
  state.cd = new CdView({
    root: el('cdView'), canvas: el('cdCanvas'), list: el('cdList'),
    prev: el('cdPrev'), next: el('cdNext'), play: el('cdPlay'),
    num: el('cdNum'), time: el('cdTime'), title: el('cdTitle'),
  }, {
    onTrack: (i) => { if (state.queue && !state.jumping) goTo({ index: i, time: 0 }, false); },
    onSeekFrac: (f) => { if (!state.jumping) goTo({ index: state.queue?.index ?? 0, time: f * state.T }, false); },
    onPrev: () => stepTrack(-1),
    onNext: () => stepTrack(1),
    onToggle: async () => { await state.engine.resume(); state.cdPlaying = !state.cdPlaying; },
  });
  // from the CD view the library is one tap away (the stage is hidden behind the CD player; zoom is a vinyl-side gesture)
  el('cdLibBtn').addEventListener('click', () => { el('pageAlbums').dataset.lib = '1'; stage.dispatch({ type: 'setZ', z: 1 }); });
  setView(state.view);
}

// ── controls / HUD ───────────────────────────────────────────────────────────────────────────────────────────────────────
function installControls() {
  // Fine speed (the continuous dial, spec §5): the 33 / 45 / 78 buttons and −/+ live on the stage; this slider is in Deck details.
  const rpmSlider = el('rpmSlider');
  rpmSlider.addEventListener('input', () => setRpm(Number(rpmSlider.value)));

  // Live feel knobs — dialing these by hand is most of v0's job (spec §4).
  bindKnob('knobJ', 'J');
  bindKnob('knobK', 'k');
  bindKnob('knobC', 'c');
  bindKnob('knobBrake', 'brakeDamp');

  // Load a local file (drag-drop or picker).
  const loadLoose = async (f) => {
    await state.engine.resume();
    state.albumId = null;
    await loadTrack(await loadFile(f, state.engine.ctx));
    stage.setDisplay({ lit: true });
    stage.dispatch({ type: 'play', s: 0 });
  };
  const file = el('fileInput');
  file.addEventListener('change', async () => { if (file.files[0]) await loadLoose(file.files[0]); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) await loadLoose(f);
  });

  // Palm brake: the spacebar (hold) mirrors a hold on the platter label. A focused control keeps Space for itself.
  const inControl = () => { const a = document.activeElement; return !!(a && a.closest && a.closest('[role="button"], button, input, select, textarea, [role="slider"]')); };
  window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !inControl()) { e.preventDefault(); state.braking = true; } });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space' && state.braking && !inControl()) { e.preventDefault(); state.braking = false; } });
  // Esc zooms back in from the library
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && stage.zoom > 0.5 && !document.querySelector('.wt-overlay:not(.hidden)')) { stage.dispatch({ type: 'zoomTo', z: 0 }); } });

  const saved = lsGet(LS.speed);
  if (saved && SPEEDS[saved.base]) { state.speedBase = saved.base; state.trim = clamp(Number(saved.trim) || 1, TRIM.min, TRIM.max); applyRpm(); }
  else if (saved && Number.isFinite(saved.rpm)) setRpm(clamp(saved.rpm, 8, 100));
  else applyRpm();
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

// ── Deck details: the old side panel, now a sheet opened from the small control on the Albums page ──────────────────────
function installDetails() {
  const page = el('pageAlbums'), sheet = el('deckSheet');
  const actions = page.querySelector('.page-actions');
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'tt-details-btn'; btn.id = 'btnDeck'; btn.setAttribute('aria-label', 'Deck details'); btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="M4 8h9M17 8h3M4 16h3M11 16h9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="15" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="9" cy="16" r="2" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>';
  actions.append(btn);
  const set = (open) => { sheet.hidden = !open; btn.setAttribute('aria-expanded', String(open)); if (open) sheet.querySelector('.tt-sheet-close').focus({ preventScroll: true }); else btn.focus({ preventScroll: true }); };
  btn.addEventListener('click', () => set(sheet.hidden));
  sheet.querySelector('.tt-sheet-close').addEventListener('click', () => set(false));
  sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); set(false); } });
}

const appEl = () => el('pageAlbums');
let shell = null;   // the navigation shell (src/shell/nav.js), created by installLibrary


// ── Albums: the zoom-out library (T2's component, mounted into the stage), Mixtapes, Radio, Booth + the shell ───────────
// The old library overlay is gone: its three tabs are now the sections Albums / Mixtapes / Radio (+ Booth), see src/shell/.
// Boot work is the shell, the Albums stage + library and the Mixtapes stack. Radio code (src/radio-player.js and everything it lazy-loads)
// is fetched on the first visit to Radio, and the FX component on the first visit to Booth.
let radio = null;   // RadioUI, once the Radio section has been opened

function libraryDeps() {
  return { dpr: Math.min(2.5, window.devicePixelRatio || 1) };
}

// albums for the component: the scanned library (filtered / sorted), or the built-in test pressing when there is nothing yet
const SORTS = { artist: 'artist', album: 'album', genre: 'genre', colour: 'color', color: 'color' };
function rebuildAlbums() {
  shelf = library ? library.albums(SORTS[view.sort] || 'artist').filter((a) => view.kind === 'all' || a.kind === view.kind) : [];
  albums = albumsToCoverflow(shelf);
  if (!shelf.length && view.kind === 'all') {
    albums = [builtinTestPressing({ durationSec: 24, title: 'Test pressing', artist: 'Runout' })];
  }
  tlib.setAlbums(albums);
  const at = albums.findIndex((a) => a.id === state.albumId);
  if (at >= 0) tlib.focus(at, { animate: false });
  syncAlbumUI();
}
const indexOfAlbum = (id) => albums.findIndex((a) => a.id === id);

// load album `index` of the library list (decode ONE track: the engine decodes whole files, the queue keeps a single resident track)
let loadToken = 0;
async function loadAlbum(index, trackIndex = 0) {
  const a = albums[index];
  if (!a) return false;
  if (a.builtin) {
    const tok = ++loadToken;
    stage.setDisplay({ loading: true });
    await state.engine.resume();
    await loadTrack(synthesizeTrack(state.engine.sampleRate, 24));
    if (tok !== loadToken) return false;
    state.albumId = a.id; state.cdAlbum = false;
    stage.setDisplay({ loading: false, lit: true }); syncDisplay();
    syncAlbumUI();
    return true;
  }
  const item = shelf[index];
  const trackObj = item && item.tracks[trackIndex];
  if (!trackObj) return false;
  if (!trackObj.file) { flash('RE-LINK FILES'); return false; }   // persisted metadata only: needs the file back (a user gesture)
  const tok = ++loadToken;
  stage.setDisplay({ loading: true });
  try {
    await state.engine.resume();
    const track = await loadFile(trackObj.file, state.engine.ctx);
    if (tok !== loadToken) return false;      // a newer pick superseded this decode
    state.albumId = item.id;
    await loadTrack(track, queueFor(item, trackIndex));
  } catch (err) {
    console.error('album load failed', err);
    flash('CANNOT READ FILE');
    return false;
  } finally {
    if (tok === loadToken) stage.setDisplay({ loading: false });
  }
  lsSet(LS.last, { id: item.id, index: trackIndex });
  syncDisplay(); syncAlbumUI();
  return true;
}

function wireLibrary() {
  // tap a track in the library: zoom back in and play that track
  tlib.on('selectTrack', async (albumId, trackIndex) => {
    const idx = indexOfAlbum(albumId);
    if (idx < 0) return;
    const a = albums[idx];
    stage.dispatch({ type: 'zoomTo', z: 0 });
    await state.engine.resume();
    if (a.kind === 'cd') {                       // CD cases open the CD view (src/cd.js) as before, not the platter
      delete el('pageAlbums').dataset.lib;
      if (await loadAlbum(idx, trackIndex)) { state.cdPlaying = true; }
      return;
    }
    if (state.albumId === a.id && state.queue && state.view === 'vinyl') {   // already on the platter: just move the needle
      playTarget({ index: Math.min(trackIndex, state.queue.items.length - 1), time: 0 }, { needle: true });
      return;
    }
    stage.dispatch({ type: 'stop', s: 0 });
    if (await loadAlbum(idx, trackIndex)) {
      stage.setDisplay({ lit: true });
      if (a.builtin) stage.dispatch({ type: 'play', s: 0 });
      else playTarget({ index: trackIndex, time: 0 }, { needle: false });
    }
  });
  // tap the centre cover: back to the player (a CD goes back to its CD view)
  tlib.on('tapCover', (albumId) => {
    const a = albums[indexOfAlbum(albumId)];
    stage.dispatch({ type: 'zoomTo', z: 0 });
    if (a && a.kind === 'cd' && state.queue && state.queue.kind === 'cd') delete el('pageAlbums').dataset.lib;
  });
  // swipe sideways: when the carousel settles on another album, load it (debounced: a fling past covers decodes nothing)
  let focusTimer = 0;
  tlib.on('focus', (index) => {
    clearTimeout(focusTimer);
    focusTimer = setTimeout(async () => {
      const a = albums[index];
      if (!a || a.id === state.albumId || a.kind === 'cd') return;   // CD cases stay shelved until a track is picked
      stage.dispatch({ type: 'stop', s: 0 });
      await loadAlbum(index, 0);
    }, 420);
  });
  tlib.on('filter', (kind) => { view.kind = kind; rebuildAlbums(); });
  tlib.on('sort', (sort) => { view.sort = sort; rebuildAlbums(); });
  tlib.on('scan', () => scanLibrary());
}

let scanning = false;
async function scanLibrary() {
  if (scanning) return;
  scanning = true;
  try {
    if (deviceLibrary.isAvailable()) {   // Android app: the toolbar's Scan means "scan the phone" (permission first, never a folder picker)
      const ph = deviceLibrary.status.get().phase;
      if (ph === 'blocked') await deviceLibrary.source.openSettings();
      else if (ph === 'needs-permission' || ph === 'denied') await deviceLibrary.allowAndScan();
      else await deviceLibrary.scan({ force: true });
      rebuildAlbums();
      return;
    }
    const pending = library.linkSummary?.needsRelink || 0;
    const onProgress = (done, total) => { flash(`SCANNING ${done}/${total}`); if (done % 25 === 0 || done === total) rebuildAlbums(); };
    if (pending) await library.relink(onProgress); else await library.scan(onProgress);
    rebuildAlbums();
  } finally { scanning = false; syncDisplay(); }
}

function installLibrary() {
  library = new LibraryManager();
  // Persisted library metadata (tags only, no audio) -> albums + mixtape refs resolve before any re-scan;
  // those tracks show "needs re-link" until then.
  library.restore().then((n) => { if (n) { rebuildAlbums(); state.mixtapes?.refresh?.(); restoreLast(); } }).catch(() => {});
  rebuildAlbums();
  if (deviceLibrary.isAvailable()) {   // Android app only: device tracks stream into the same library; the card explains / asks / shows progress
    let t = 0;
    library.onChange(() => { clearTimeout(t); t = setTimeout(() => { rebuildAlbums(); state.mixtapes?.refresh?.(); }, 400); });
    installDeviceLibrary(library).then(() => { rebuildAlbums(); restoreLast(); }).catch(() => {});
    const host = document.createElement('div'); host.className = 'dv-host'; el('pageAlbums').appendChild(host);
    deviceLibrary.mountScanCard(host);
  }

  // Mixtapes: custom playlists (pure model in mixtape.js; this is wiring only).
  state.mixtapes = new MixtapeUI({
    getLibraryTracks: () => library.tracks,
    closeLibrary: () => { /* the player opens over the page; nothing to close */ },
    playFile: async (file) => {
      await state.engine.resume();
      const track = await loadFile(file, state.engine.ctx);
      await loadTrack(track, null, false, true);
      state.albumId = null;
      return track;
    },
    relink: () => library.relink(),
    // Cassette player hooks (src/mixtape-ui.js): real seek / pause / wind-mute / level meter.
    seekFrac: (frac) => {
      if (!(state.T > 0)) return;
      state.engine.seek(clamp(frac, 0, 0.99) * state.T * state.engine.sampleRate);
      state.reachedEnd = false;
    },
    setPaused: (on) => { state.braking = on; },
    muteBus: (on) => state.engine.setPlaying(!on && !state.radioOn),
    levelAt: (t, T) => {
      const e = state.envelope;
      return e && T > 0 ? e[Math.max(0, Math.min(e.length - 1, Math.floor((t / T) * e.length)))] : 0;
    },
    // Gapless hooks (queue.js model; AudioEngine.prepareNext/joinNext).
    decodeNext: async (file) => {
      const track = await loadFile(file, state.engine.ctx, { copy: false });
      const [L, R] = track.channels;
      track.envelope = computeEnvelope((i) => (L[i] + R[i]) * 0.5, track.frames, 1024); // off the join path
      return track;
    },
    prepareNext: (track) => state.engine.prepareNext(track.channels, track.frames),
    joinNext: (fadeSec) => state.engine.joinNext({ fadeSec }),
    dropNext: () => state.engine.dropNext(),
    adoptTrack: (track) => {
      // The engine already switched decks; mirror loadTrack()'s non-engine state.
      state.vinylOwned = false;
      state.track = { frames: track.frames, name: track.name, channels: null };
      state.frames = track.frames;
      state.T = track.frames / state.engine.sampleRate;
      state.envelope = track.envelope;
      state.reachedEnd = false;
      refreshRecord();
    },
  });
  state.mixtapes.mount(el('mtList'), el('mtNew'), el('mtImport'));

  // ── the shell ──
  shell = createShell({
    onSearch: () => search && search.open(),
    isPageGestureLive: () => state.touchingPlatter || state.seeking || (stage && stage.isGestureLive()),
    onSection: (id) => { el('shell').dataset.section = id; },
    hooks: {
      albums: { onShow: () => { stage.resize(); stage.kick(); } },
      mixtapes: { onShow: () => state.mixtapes.refresh() },
      radio: {
        // Lazy: the radio code is fetched here, on the first visit. The session lives on after the user leaves the section.
        async mount(host) {
          const { RadioUI } = await import('./radio-player.js');
          radio = new RadioUI({
            onActive: (on) => { state.radioOn = on; state.engine.setPlaying(!on); },
            aiHost: makeAiHost(library), // You Radio (src/radio/offline) plays your library through this engine
          });
          radio.mount(host.querySelector('#paneRadio'));
          foreignPlaybackHook = () => radio.foreignPlayback();
          return { onShow: () => radio.activate() };
        },
      },
      booth: {
        // Lazy: Workstream X's FX component (src/shell/booth.js has the one-line mount point). deps are what it can use of the app.
        // The Booth works on the record on the platter: entering it puts the needle down if the deck was stopped (the old deck was
        // always spinning, so the effects always had something to chew on).
        async mount(host) {
          const c = (await mountBooth(host.querySelector('#boothHost'), boothDeps())) || {};
          return { ...c, onShow() { boothShown(); c.onShow && c.onShow(); } };
        },
        onShow: () => boothShown(),
      },
      settings: {
        // Lazy: src/settings/page.js is fetched on the first visit. Deps are what the page needs of the app (docs/SETTINGS.md).
        async mount(host) {
          const { mountSettings } = await import('./settings/page.js');
          const dev = await import('./device/index.js').catch(() => null);
          await Promise.all([loadRadioStore(), loadFxPersist()]).catch(() => {});
          const lib = dev && dev.deviceLibrary;
          const page = mountSettings(host.querySelector('#settingsHost'), settingsDeps(lib));
          return { onShow: () => page.onShow(), onHide: () => page.onHide() };
        },
      },
    },
  });
  deviceMode.mountKeys();   // the lock key goes into every section header the shell just built
  el('shell').dataset.section = shell.current;
  setInterval(refreshNowPlaying, 500);
}

function boothShown() {
  const pl = stage.player;
  if (pl.playing || pl.starting || !state.vinylOwned || engineOwner() || state.view !== 'vinyl') return;
  stage.setDisplay({ lit: true });
  stage.dispatch({ type: pl.frozenS > FINISHED ? 'play' : 'toggle', s: 0 });
}

// the last album the player had, put back on the carousel after a restart (files need re-linking before it can play)
function restoreLast() {
  const last = lsGet(LS.last);
  if (!last || !last.id) return;
  const i = indexOfAlbum(last.id);
  if (i >= 0) tlib.focus(i, { animate: false });
}

// ── Drawer footer: walkthrough, mode, theme ────────────────────────────────────────
let walkthrough = null;
function installToolbar() {
  walkthrough = new Walkthrough();

  // Show walkthrough on first run.
  walkthrough.showIfFirstRun();
  el('btnWalkthrough').addEventListener('click', () => { shell?.close(); walkthrough.show(0); });

  // The ◦/♦ audiophile button, the ☾/☀ theme button and the settings they stand for: installSettingsAndSearch() below.
}


// ── Custom theme: JSON paste → mandatory verbatim preview → Apply ───────────
// Independent of the dark/light toggle above (installToolbar): a custom
// theme supplies ITS OWN light and dark color sets, and the toggle just
// decides which of those (or which of the built-in pair) is currently shown.

// Re-applies whichever theme is active — the stored custom one, or none (the
// built-in default) — for the given mode ('dark'|'light'). Called at boot and
// every time the dark/light toggle flips, so a custom theme's own light/dark
// pair tracks that toggle exactly like the built-in colors do.

function installCustomTheme() {
  const overlay = el('themeOverlay');
  const stepEdit = el('themeStepEdit');
  const stepPreview = el('themeStepPreview');
  const input = el('themeInput');
  const previewText = el('themePreviewText');
  const errorBox = el('themeError');
  const okBox = el('themeOk');
  const applyBtn = el('themeApplyBtn');

  // The last successfully parsed theme from the CURRENT preview screen, or
  // null. Apply only ever commits this — never re-parses on click — so
  // there's no window where a malformed paste could sneak through.
  let pendingParsed = null;

  function refreshStatus() { settings.customThemeChanged(); }   // re-applies the palette and repaints the Settings page

  function showEdit() {
    stepPreview.classList.add('hidden');
    stepEdit.classList.remove('hidden');
  }

  function showPreview() {
    // The preview renders the EXACT textarea text back, byte-for-byte —
    // via .textContent (never innerHTML, never reformatted/pretty-printed),
    // so the user sees precisely what they typed before anything can apply.
    const raw = input.value;
    previewText.textContent = raw;

    const result = parseTheme(raw);
    pendingParsed = result.ok ? result.theme : null;

    if (result.ok) {
      errorBox.classList.add('hidden');
      okBox.classList.remove('hidden');
      okBox.textContent = `Looks good — "${result.theme.name}". Apply to use it.`;
      applyBtn.disabled = false;
    } else {
      okBox.classList.add('hidden');
      errorBox.classList.remove('hidden');
      errorBox.textContent = result.error;
      applyBtn.disabled = true; // malformed input can never be applied
    }

    stepEdit.classList.add('hidden');
    stepPreview.classList.remove('hidden');
  }

  function openOverlay() {
    // Re-opening pre-fills the currently active custom theme's JSON (if any)
    // rather than starting blank, so tweaking one is easy.
    const stored = loadStoredTheme();
    input.value = stored ? JSON.stringify(stored, null, 2) : '';
    pendingParsed = null;
    showEdit();
    overlay.classList.remove('hidden');
  }

  function closeOverlay() {
    overlay.classList.add('hidden');
  }

  customThemeApi.open = openOverlay;   // the Settings page's "Import JSON..." button

  el('themePreviewBtn').addEventListener('click', showPreview);
  el('themeBack').addEventListener('click', showEdit);
  el('themeCancel1').addEventListener('click', closeOverlay);   // Cancel/back discards — nothing was ever applied.
  el('themeCancel2').addEventListener('click', closeOverlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });

  el('themeResetDefault').addEventListener('click', () => {
    clearStoredTheme();
    clearThemeVars();
    refreshStatus();
    closeOverlay();
  });

  applyBtn.addEventListener('click', () => {
    if (!pendingParsed) return; // guard: never apply a malformed theme
    storeTheme(pendingParsed);
    refreshStatus();   // applies it for the current light/dark mode (src/settings/wire.js)
    closeOverlay();
  });

  refreshStatus();
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



// What the Booth (FX) component may use of the app. `blocked()` is the reason the engine is owned by a radio or mixtape session
// (null when free); the component shows a plain message and stays disabled while it is set.
function boothDeps() {
  return {
    engine: state.engine,
    storage: (() => { try { return window.localStorage; } catch { return null; } })(),
    host: {
      getTrack: () => state.track,
      nominalRate: () => rateFromOmega(omegaNominal(state.rpm), REFERENCE_RPM),
      omegaNominal: () => omegaNominal(state.rpm),
      sampleRate: () => state.engine.sampleRate,
      blocked: () => engineOwner(),
    },
    blocked: () => engineOwner(),
  };
}

// Which radio / mixtape session owns the engine right now, or null.
function engineOwner() {
  if (radio && radio.station) return 'radio';
  const p = state.mixtapes && state.mixtapes.play;
  if (p && !p.ended) return 'mixtape';
  return null;
}

// The now-playing mini bar: whatever plays from any source, on every section but its own.
function refreshNowPlaying() {
  if (!shell) return;
  const src = {};
  if (radio && radio.station) {
    const ph = radio.session?.state?.phase;
    src.radio = { title: radio.station.name, sub: ph === 'playing' ? 'Radio · on air' : ph === 'error' ? 'Radio · error' : 'Radio · connecting' };
  }
  const p = state.mixtapes && state.mixtapes.play;
  if (p && !p.ended && !p.paused) src.mixtape = { title: p.mix.name || 'Mixtape', sub: `Mixtape · track ${Math.max(1, p.idx + 1)} of ${p.files.length}` };
  const q = state.queue;
  if (q && !state.radioOn && (state.view === 'cd' ? state.cdPlaying : (stage.player.playing && state.vinylOwned))) {
    src.album = { title: q.items[q.index].title || (state.track && state.track.name) || 'Album', sub: `${q.kind === 'cd' ? 'CD' : 'Vinyl'} · track ${q.index + 1} of ${q.items.length}` };
  }
  shell.setNowPlaying(src, { stop: () => radio && radio.stop() });
  if (deviceMode) { const n = src.radio || src.mixtape || src.album; deviceMode.setNowPlaying({ title: n ? n.title : '', playing: !!n }); }
}

// ── You Radio host port (src/radio/offline/station-session.js) ────────────────
// The offline AI station plays the user's library through THIS engine (gapless prepareNext/joinNext, same as
// mixtapes) and ducks the music bus under live speech. All logic lives in src/radio/offline; this is glue only.
function makeAiHost(library) {
  const eng = () => state.engine;
  return {
    getTracks: () => library.tracks,
    busParam: () => eng().musicBus.gain,
    audioNow: () => eng().ctx.currentTime,
    owner: () => engineGate.token(),
    cancelPending: () => { engineGate.bump(); }, // halt(): a decode still in flight must not install its song afterwards
    async load(libTrack) {
      const tok = engineGate.token();
      await eng().resume();
      const track = await loadFile(libTrack.file, eng().ctx);
      engineGate.check(tok);
      await loadTrack(track, null, true);
      return { durationSec: state.T, envelope: state.envelope, bytes: track.frames * 8 };
    },
    async decodeNext(libTrack) {
      const tok = engineGate.token();
      const track = await loadFile(libTrack.file, eng().ctx, { copy: false });
      engineGate.check(tok);
      const [L, R] = track.channels;
      const envelope = computeEnvelope((i) => (L[i] + R[i]) * 0.5, track.frames, 1024);
      return { track, tok, envelope, name: track.name, frames: track.frames, durationSec: track.frames / eng().sampleRate, bytes: track.frames * 8 };
    },
    async prepareNext(h) { engineGate.check(h.tok); await eng().prepareNext(h.track.channels, h.track.frames); h.track.channels = null; }, // the engine copied the PCM
    joinNext: (fadeSec) => eng().joinNext({ fadeSec }),
    dropNext: () => eng().dropNext(),
    adopt(h) { // the engine already switched decks; mirror loadTrack()'s non-engine state
      state.track = { frames: h.frames, name: h.name, channels: null };
      state.frames = h.frames;
      state.T = h.frames / eng().sampleRate;
      state.envelope = h.envelope;
      state.reachedEnd = false;
      state.vinylOwned = false;
      refreshRecord();
    },
    position: () => ({ t: eng().position / eng().sampleRate, T: state.T }),
    async halt() { // stop = the needle rests in the runout groove; the vinyl bus stays alive for the next record
      eng().dropNext();
      eng().seek(Math.max(0, state.frames - 2));
    },
  };
}

boot().catch((err) => {
  document.getElementById('latency').textContent = 'boot error: ' + err.message;
  console.error(err);
});
