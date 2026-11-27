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
import { synthesizeTrack, loadFile, DECODE_LIMITS, decodedBytes } from './track.js';
import { createQueue, reduce as queueReduce } from './queue.js';
import { queueMatchesRow } from './rowqueue.js';
import { unsupportedReason, UNSUPPORTED_TEXT } from './formats.js';
import {
  createPlatter, stepPlatter, rateFromOmega, omegaNominal,
  computeEnvelope, makeTempoFeed, angleDelta, clamp, DEFAULT_PARAMS,
} from './model.js';
import { Walkthrough } from './walkthrough.js';
import { createSeekBar } from './ui/seekbar.js';
import {
  TONEARM_KNOBS, estimateDurations, buildArmLayout, locateS, seekTargetS, sFor,
  previousTarget, gapCentreS,
} from './tonearm.js';
import { NeedleFX } from './needle-fx.js';
import { CdView } from './cd-view.js';
import { CD_KNOBS, formatTime } from './cd.js';
import { MixtapeUI } from './mixtape-ui.js';
import { createShell } from './shell/nav.js';
import { initDeviceMode } from './devicemode/index.js';
import { allowsGesture } from './devicemode/guard.js';
import { trapFocus } from './ui/focus-trap.js';
import { onAodOutlineMode } from './devicemode/aodhooks.js';   // Device mode: lock key, frozen face, keep-awake, always-on display (docs/DEVICE_MODE.md)
let deviceMode = null;
import { mountBooth } from './shell/booth.js';
import { createEngineGate } from './engine-gate.js';
import { startBackground, createSleepDriver } from './background.js';
import { createArtwork } from './artwork.js';                // album art as base64 for the notification / lock screen
import { createRationale, showRationaleCard } from './notify-rationale.js';   // the one-line reason shown before the OS notification dialog        // background playback: timer-driven loop while hidden, native media service, media buttons (docs/DEVICE_LIBRARY.md)
import { installBackButton } from './backbutton.js';      // hardware Back: close the topmost layer, else minimise
import { LibraryManager } from './library.js';
import { orderForPlayAll } from './albums.js';
import { isAccessError, shortTitle, friendlyReason, LOST_ACCESS } from './errtext.js';
import { deviceLibrary, installDeviceLibrary, describeStatus } from './device/index.js';   // the phone's own audio library (Android app only; docs/DEVICE_LIBRARY.md)
import { createStage } from './turntable/stage.js';
import { FINISHED } from './turntable/state.js';
import { mountTurntableLibrary } from './turntable/library.js';
import { albumsToCoverflow, builtinTestPressing, cleanTrackTitle, TEST_PRESSING_ID } from './turntable/library-layout.js';
import {
  parseTheme, clearThemeVars,
  storeTheme, loadStoredTheme, clearStoredTheme, builtinThemeTemplate, exportThemeText,
} from './theme.js';
import { initSettings } from './settings/wire.js';
import { createSearchLauncher } from './search/wire.js';
import { bindSearchActions } from './search/actions.js';
import { libraryPrefs, clearLibraryCache } from './library-prefs.js';
import { load as loadResume, save as saveResume, resolve as resolveResume, isMeaningful, createSaver } from './resume.js';   // resume the last record, paused
import { mountResumeChip } from './resume-ui.js';
import { makeOrder, validOrder, stepSlot } from './playorder.js';   // shuffle / repeat: the order slots are visited in
import { mountPlayMode } from './playmode-ui.js';
import { createSleep } from './sleep.js';                 // sleep timer: model (src/sleep.js), clock (background.js), volume (sleep-audio.js), controls (sleep-ui.js)
import { createSleepFader, installMediaRegistry } from './sleep-audio.js';
import { mountSleep, mountSleepChip } from './sleep-ui.js';

// The track is mastered for one fixed reference speed. The needle plays it
// correctly at this RPM (rate = 1). Moving the speed dial above/below it shifts
// pitch AND tempo together — the authentic 33→45 transform (spec §5).
const REFERENCE_RPM = 33 + 1 / 3;
const SPEEDS = { '33': REFERENCE_RPM, '45': 45, '78': 78 };
const TRIM = { min: 0.7, max: 1.3, step: 0.02 };   // the stage's −/+ buttons: ×.98 / ×1.02 of the chosen speed
const LS = { speed: 'runout.tt.speed', last: 'runout.tt.last', picked: 'runout.tt.picked' };
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
  albumMeta: null,           // the coverflow album object ({id, title, artist, coverUrl...}) for albumId; null for a loose track
  view: 'vinyl',             // 'vinyl' platter | 'cd' player
  vinylOwned: true,          // false while a mixtape / radio track is what the engine holds: the loop then keeps it at nominal speed as before
  stationLeftover: false,    // true while the deck holds an engine-backed station's song (running, or parked after it stopped): not a user record
  cdPlaying: true,
  cdMute: false,             // brief CD "re-read" silence after a skip
  jumping: false,            // a track change is decoding (arm stays lifted)
  jumpS: 0,                  // where the arm shows while jumping
  jumpTarget: null,          // { index, time } of the jump in flight (last tap wins)
  pre: null,                 // the album's decoded-ahead next track, parked in the engine's next deck: { index, frames, envelope, name, tempoFeed, nch }
  aq: null,                  // queue.js model for the vinyl album queue (gapless preload + join)
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
const settings = initSettings({ onWriteError: () => toast('Could not save that setting: this phone\u2019s storage is full or blocked. It works until you close the app, then it resets.') });
settings.onFirstLight(() => toast('Light changes menus only; players stay dark', 6500));   // the players are dark objects in every theme (src/shell/chrome.css)
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
  state.albumId = TEST_PRESSING_ID; state.albumMeta = null;
  installControls();
  installAlbumNav();
  installLibrary();     // albums (the zoom-out library), mixtapes, the lazy radio / booth hooks and the shell itself
  installDetails();     // needs the page headers the shell creates
  installToolbar();     // the drawer footer: walkthrough, mode, theme
  installCustomTheme();
  installSettingsAndSearch();
  createSleepDriver(sleep);   // the sleep timer's own clock: ticks while the page is hidden too
  bg = startBackground({ step: loop, engine: state.engine, actions: miniActions, getMeta: mediaMeta, getPosition: mediaPosition, artwork: createArtwork(), notice: (t) => toast(t), rationale: createRationale({ storage: lsOk(), show: () => showRationaleCard({ host: el('shell') || document.body }) }) });   // starts the frame loop (rAF visible / timer hidden)
  installBackButton({ deviceMode, getSearch: () => search, getShell: () => shell, library: { isOpen: () => !!stage && stage.zoom > 0.5, close: closeLibrary } });
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
    btnMode.querySelector('.ic').textContent = on ? '♦' : '◦'; btnMode.classList.toggle('active', on); btnMode.setAttribute('aria-pressed', String(on));
  };
  applyMode();
  btnMode.addEventListener('click', () => S.set('playback.audiophile', !S.get('playback.audiophile')));
  S.subscribe((all, path) => {
    if (path === 'haptics' || path === '*') applyHaptics();
    if (path === 'playback.audiophile' || path === '*') applyMode();
    if (path === 'playback.defaultRpm') setSpeed(RPM_ID(all.playback.defaultRpm));
    if (path === 'radio.aiStations' && radio && radio._aiOn() !== all.radio.aiStations) radio._setAi(all.radio.aiStations);
    if (path === 'playback.shuffle' || path === 'playback.repeat' || path === '*') onPlayModeChange();
  });
  el('btnTheme').addEventListener('click', () => settings.cycleTheme());

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
    sleep,
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
    markPicked();
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
      adoptFocusSoon(i);   // tlib.focus() does not emit 'focus': the album goes onto the platter the way a swipe would
      return true;
    },
    // artist "Play all": the artist's songs as one queue
    async playTracks(ids) {
      // an artist's songs play album by album, in disc / track order inside each album
      const list = orderForPlayAll(ids.map(trackObj).filter(Boolean));
      const first = list.findIndex((t) => t.file);
      if (first < 0) { flash('RE-LINK FILES'); return false; }
      markPicked();
      const my = newIntent();
      await gotoSection('albums');
      await state.engine.resume();
      if (my !== intent) return false;
      stage.dispatch({ type: 'zoomTo', z: 0 }); stage.dispatch({ type: 'stop', s: 0 });
      const q = queueFor({ kind: 'vinyl', id: null, tracks: list }, first);
      let at = first, track = null;
      for (; at < list.length; at++) {   // the first track that decodes starts it (the others are skipped, marked, and said so)
        if (!list[at].file) continue;
        try { track = await loadFile(list[at].file, state.engine.ctx, { copy: false, durationSec: list[at].durationSec }); break; }
        catch (err) { if (my !== intent) return false; console.error('play all failed', err); q.items[at].bad = true; failToast(list[at].title, err, list[at]); }
      }
      if (!track) return false;
      if (my !== intent) return false;
      q.index = at;
      try { await loadTrack(track, q, false, false, { id: null, meta: null }); } catch (err) { failToast(list[at].title, err, list[at]); return false; }
      stage.setDisplay({ lit: true });
      playTarget({ index: at, time: 0 }, { needle: false });
      syncDisplay(); syncAlbumUI();
      return true;
    },
    // artist drill-down lives in the search overlay; Albums has no artist filter yet (SEAM: sort 'artist' + focus the first album)
    async openArtist(name) {
      const lk = (library.albums('artist') || []).findIndex((a) => String(a.artist).toLowerCase() === String(name).toLowerCase());
      if (lk < 0) return false;
      await gotoSection('albums'); tlib.focus(lk, { animate: false }); stage.dispatch({ type: 'zoomTo', z: 1 }); adoptFocusSoon(lk);
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
// `album` = { id, meta } committed together with the track (undefined: leave the platter's album as it is; a loose file passes { id: null, meta: null }).
// Nothing of the app state is touched until the engine really holds the new audio: a failure leaves the old record, its album and its queue exactly as they were.
async function loadTrack(track, q = null, fromRadio = false, foreign = false, album = undefined) {
  if (!fromRadio) engineGate.bump();
  const [L, R] = track.channels;
  const mono = (i) => (R ? (L[i] + R[i]) * 0.5 : L[i]);
  const envelope = computeEnvelope(mono, track.frames, 1024);   // windowed RMS (mixtape level meter, You Radio); the spiral's min/max peaks are a separate pass in refreshRecord()
  const nch = track.channels.length;
  const feed = makeTempoFeed(track.channels, track.frames, state.engine.sampleRate);   // the Booth's tempo needs a 60 s excerpt, not the whole PCM
  await state.engine.load(track.channels, track.frames);   // may throw: nothing is committed yet
  // committed: the engine holds this audio now
  if (!fromRadio) { try { foreignPlaybackHook && foreignPlaybackHook(); } catch { /* */ } }
  if (!foreign) { try { state.mixtapes && state.mixtapes.releaseEngine(); } catch { /* */ } }   // an album track / a station replaces a tape that was still playing
  if (!foreign) state.braking = false;                                                        // a released paused tape must not leave the platter braked
  state.vinylOwned = !(fromRadio || foreign);
  state.stationLeftover = !!fromRadio;   // the deck holds an engine-backed station's song, not a record the user chose (see platterIsDemo / host.halt)
  state.track = track;
  track.nch = nch; track.tempoFeed = feed;
  state.frames = track.frames;
  state.T = track.frames / state.engine.sampleRate;
  state.queue = q;
  if (album !== undefined) { state.albumId = album ? album.id : null; state.albumMeta = album ? album.meta : null; }
  if (q) q.items[q.index].dur = state.T;
  setView(q?.kind === 'cd' ? 'cd' : 'vinyl');
  state.envelope = envelope;
  state.engine.setPlaying(!state.radioOn); // load() re-arms the bus; keep it muted under a live station
  state.engine.setRate(0);
  state.reachedEnd = false;
  preTok++; state.pre = null; state.aq = q && q.kind === 'vinyl' && q.items.length > 1 ? createQueue({ playable: q.items.map((it) => !!it.file && !it.bad), durations: q.items.map((it) => it.dur), opts: { maxResidentBytes: DECODE_LIMITS.preloadBytes * 2, bytesPerSec: state.engine.sampleRate * 8 } }) : null;   // current + next deck within the memory budget, else the boundary is a cold load
  if (state.aq) state.aq = queueReduce(state.aq, { type: 'start', index: q.index }).state;
  syncQueueMode();   // shuffle order / repeat onto the new queue
  refreshRecord();
  track.channels = null;     // the engine packed its own copy and the peaks / envelope / tempo feed are made: do not keep the decoded PCM alive (a 100 MB FLAC is ~500 MB)
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
  stage.setDisplay({ msg: false, name: trackTitle(), trackCount: q ? q.items.length : 1, trackIndex: q ? q.index : 0, ...(extra || null) });
}
let flashT = 0;
function flash(text) {   // a short message on the dot display ("RADIO ON", "RE-LINK FILES")
  stage.setDisplay({ msg: true, name: text, lit: true, trackCount: 1 });
  clearTimeout(flashT); flashT = setTimeout(() => syncDisplay(), 2400);
}

// A LOUD message: a visible pill (role=status) over every section, for failures the user must see (a track that cannot be read must never
// silently leave the built-in test pressing on the platter). `flash` above only writes to the dot display, which is hidden while the
// coverflow is up and gone after 2.4 s.
let toastEl = null, toastT = 0;
function toast(text, ms = 6000) {
  try {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'rtToast'; toastEl.setAttribute('role', 'status'); toastEl.setAttribute('aria-live', 'assertive');
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 72px);transform:translateX(-50%);max-width:min(92vw,420px);z-index:2147483000;'
        + 'padding:10px 16px;border-radius:12px;background:#1b1b1f;color:#fff;font:600 13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45);'
        + 'pointer-events:none;text-align:center;border:1px solid rgba(255,255,255,.18)';
      document.body.appendChild(toastEl);
    }
    { const t = String(text); toastEl.textContent = t.length > 110 ? t.slice(0, 109) + '…' : t; }
    toastEl.style.display = 'block';
    clearTimeout(toastT); toastT = setTimeout(() => { if (toastEl) toastEl.style.display = 'none'; }, ms);
  } catch { /* no DOM */ }
}
// A track that will not play: plain words only (no file names / byte offsets); a lost storage permission also raises the Allow card.
function failToast(title, err, it) {
  if (isAccessError(err)) toast(LOST_ACCESS);
  else toast(`Cannot play "${shortTitle(title) || 'this track'}": ${friendlyReason({ message: failText(err, it) })}`);
  try { if (isAccessError(err) && deviceLibrary.isAvailable()) deviceLibrary.status.set({ phase: 'denied', permission: 'denied' }); } catch { /* card is best effort */ }
}

// The next track of a playing album cannot be decoded: it is skipped (playback goes on to the next playable one, or the record ends), and the user is told which one.
function skipToast(title, err, it) {
  if (isAccessError(err)) { toast(LOST_ACCESS); return; }
  toast(`Skipped "${shortTitle(title) || 'a track'}": ${friendlyReason({ message: failText(err, it) })}`);
}

// The platter still holds the built-in synthesized test pressing although the library has real albums. The demo is only for an empty
// library (or when the user picks it); with real albums on the shelf it must be replaced by the focused album before anything plays.
// One playback-intent token: every user-initiated play action (a library pick, Play all, a track jump, a loose file, a tape song, a station) bumps it, and every
// async path re-checks it after each await BEFORE it commits a decoded track. A stale decode then simply drops its result instead of overwriting a newer choice.
let intent = 0;
let preTok = 0;                          // bumped whenever the engine's deck changes: a decode-ahead that began earlier must not park its track
const newIntent = () => { state.jumping = false; return ++intent; };
const unfiltered = () => (library ? library.albums('artist') : []);   // the whole library (the shelf is only the filtered view of it)
const libHasAlbums = () => unfiltered().length > 0;
let libLoaded = false;                   // the persisted library finished restoring (before that an empty shelf does not mean an empty library)
let libReady = Promise.resolve();
const whenLibraryReady = () => Promise.race([libReady, new Promise((r) => setTimeout(r, 1500))]);
// a station / a tape owns the engine right now (not merely left a loose track in it)
const foreignPlaying = () => !!(engineOwner() || state.radioOn);
const platterIsDemo = () => (state.albumId === TEST_PRESSING_ID || !!state.stationLeftover) && libHasAlbums();   // a stopped station's last song parked on the platter is not a user record either
let adoptTimer = 0;
function scheduleAdopt() {   // after the library settles (a device scan rebuilds the shelf every 400 ms): put the focused album on the platter, silently
  clearTimeout(adoptTimer);
  adoptTimer = setTimeout(async () => {
    if (!platterIsDemo() || !stage || stage.player.playing || stage.player.starting || state.jumping) return;
    if (engineOwner() || state.radioOn || !state.vinylOwned) return;     // a station / tape owns the engine: do not stomp it
    const i = tlib.getFocus();
    const a = albums[i];
    if (!a || a.builtin) return;
    const my = intent;                                                    // not a user action: any later intent wins over this silent load
    if (await resumeFirst(my)) return;                                    // the record from the last run goes back first, paused at its position
    if (await loadAlbum(i, 0, my) && a.kind === 'cd') {
      state.cdPlaying = false;
      if (stage.zoom > 0.5) el('pageAlbums').dataset.lib = '1';   // adopted while the library is open: the library must stay visible (.tt-wrap is hidden for a CD without data-lib)
    }   // a CD adopts too, paused (the demo must not stay on the platter behind it)
  }, 700);
}
// Play with the demo on the platter and real albums on the shelf: load the focused album's first track (loud on failure) and report whether it is there.
async function adoptFocusedAlbum(my = intent) {
  if (await resumeFirst(my)) return true;
  let i = tlib.getFocus();
  if (!albums[i] || albums[i].builtin) i = albums.findIndex((a) => !a.builtin);
  if (i < 0) { flash('PICK AN ALBUM'); return false; }   // a filter hides every album: never fall back to the demo
  return loadAlbum(i, 0, my);
}

// ── resume the last record (src/resume.js) ─────────────────────────────────────────────────────────────────────────────────────
// What was on the platter (album id, stable track id, position, view) is written while it plays, on pause and when the app is hidden. On the next launch it goes
// back on the platter PAUSED (never started) with a small Resume chip; if the album, the track or its file is gone nothing happens and the normal first-run
// adoption of the focused album carries on. While the stored record is still waiting, nothing silent (the focused album's track 1) may overwrite it.
const resumeStore = lsOk();
let resumePending = loadResume(resumeStore);   // the previous run's record until it is applied, or the user plays something else
let resumeIntent0 = intent;                     // `intent` at launch: while it is unchanged nothing silent may overwrite the waiting record
let resumeStart = null;                         // { index, time } of a record just restored (a Play pressed before the adopt finished starts here)
let resumeChip = null;
const takeResumeStart = () => { const r = resumeStart; resumeStart = null; return r; };
function resumeSnapshot() {
  const q = state.queue;
  if (!q || !state.albumId || state.albumId === TEST_PRESSING_ID || !state.vinylOwned || state.radioOn || engineOwner() || state.jumping) return null;
  if (resumePending && intent === resumeIntent0) return null;     // a silent adopt must not overwrite the record that is waiting to be restored
  const it = q.items[q.index];
  if (!it || !it.id) return null;
  const playing = state.view === 'cd' ? state.cdPlaying : stage.player.playing;
  const t = state.engine.position / state.engine.sampleRate;
  if (!playing && t < 1 && q.index === 0) return null;            // an untouched first track is the normal state, not something to resume
  return { albumId: state.albumId, trackId: it.id, index: q.index, t, view: state.view };
}
const resumeSaver = createSaver({ snapshot: resumeSnapshot, write: (r) => saveResume(resumeStore, r) });
let resumeWasPlaying = false;
function resumeTick() {   // from the frame loop (also while hidden): throttled write, and a forced one the moment playback stops
  const playing = state.view === 'cd' ? !!state.cdPlaying : !!(stage && stage.player.playing);
  if (resumeWasPlaying && !playing) resumeSaver.flush(); else if (playing) resumeSaver.tick();
  resumeWasPlaying = playing;
  if (resumeChip && resumeChip.shown && (playing || intent !== resumeChipIntent)) resumeChip.hide();
}
let resumeChipIntent = 0;
async function resumeFirst(my = intent) {
  if (!resumePending || my !== intent || !platterIsDemo() || foreignPlaying() || state.jumping || !stage) return false;
  const tg = resolveResume(resumePending, shelf, (t) => !!t.file && !unsupportedReason(t));
  if (!tg) return false;                                              // gone (or its file is): quietly the normal first-run state
  const rec = resumePending; resumePending = null;
  const a = albums[tg.shelfIndex];
  stage.dispatch({ type: 'stop', s: 0 });
  if (!(await loadAlbum(tg.shelfIndex, tg.trackIndex, my)) || my !== intent) return false;   // (a failure is loud inside loadAlbum, as for any pick)
  const sr = state.engine.sampleRate;
  if (tg.t > 0) state.engine.seek(tg.t * sr);
  if (state.view === 'cd') { state.cdPlaying = false; if (stage.zoom > 0.5) el('pageAlbums').dataset.lib = '1'; }
  else { stage.dispatch({ type: 'play', s: sFor(state.layout, tg.trackIndex, tg.t) }); stage.dispatch({ type: 'stop' }); }   // 'play' then 'stop': the arm rests (frozen) at the saved spot, silent
  tlib.focus(tg.shelfIndex, { animate: false });
  resumeStart = { index: tg.trackIndex, time: tg.t };
  void rec; void a;
  if (isMeaningful(tg)) {
    if (!resumeChip) resumeChip = mountResumeChip(el('pageAlbums'), { onTap: () => { resumeChip.hide(); miniActions.toggle('album'); } });
    resumeChipIntent = intent;
    const it = state.queue.items[state.queue.index];
    resumeChip.show({ title: it && it.title, time: tg.t >= 2 ? formatTime(tg.t) : '' });
  }
  return true;
}
document.addEventListener('visibilitychange', () => { if (document.hidden) resumeSaver.flush(); });
window.addEventListener('pagehide', () => resumeSaver.flush());

// arm position s (0..1 along the album chord) for the audio time t
function currentS(t) {
  if (state.jumping) return state.jumpS;
  const q = state.queue;
  return q && state.layout ? sFor(state.layout, q.index, Math.min(t, state.T)) : clamp(state.T > 0 ? t / state.T : 0, 0, 1);
}

// ── the frame loop ─────────────────────────────────────────────────────────
// Physics + the engine's rate run every frame as before (mixtapes, radio and the Booth ride the same loop); DRAWING is demand-driven
// inside stage.update (it redraws only while something moves or changed).
let bg = null;             // src/background.js: { sync, poke, driver }
function loop(now, hidden = false) {   // hidden: the page is not visible, so no drawing (rate, position, end of track and the queue ticks still run)
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
  syncOwner();
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

  // 4. Read audio time back from the worklet to position the arm. The album queue may join the decoded-ahead next track first.
  albumQueueTick(state.engine.position / state.engine.sampleRate, rate);
  const t = state.engine.position / state.engine.sampleRate;

  // wear: bump play count once when the needle first reaches the runout
  if (!state.reachedEnd && t >= state.T - 0.05 && !state.seeking && !state.jumping) {
    state.reachedEnd = true;
    state.playCount += 1;
    localStorage.setItem('runout.playCount', String(state.playCount));
    // A CD runs on to the next track by itself; so does a record side with more tracks on it (the needle crosses the gap).
    if (state.view === 'cd' && state.queue && nextGood(state.queue, state.queue.index, 1, true) >= 0) {
      goTo({ index: nextGood(state.queue, state.queue.index, 1, true), time: 0 }, false, { natural: true });
    } else if (state.view === 'cd') state.cdPlaying = false;   // the disc ran out: paused at the end, so the mini bar / media session stop claiming it plays and Play can restart it
    else if (state.view === 'vinyl' && state.vinylOwned && pl.playing) onVinylTrackEnd();
  }
  if (t < state.T - 0.2) state.reachedEnd = false;

  // 5. Draw (vinyl) / CD view
  if (state.view === 'cd' && !hidden) {
    state.cd.draw({ t, T: state.T, playing: state.cdPlaying, dt, loading: state.jumping });
  }
  const e = state.envelope;
  stage.update(dt, {
    posS: currentS(t),
    dust: clamp(state.playCount / 20, 0, 1),
    level: e && e.length ? e[Math.max(0, Math.min(e.length - 1, Math.floor((t / Math.max(1e-3, state.T)) * e.length)))] : 0,
  });

  state.mixtapes?.tick(t, state.T, rate, dt);
  resumeTick();
  if (!hidden) updateHud(rate, t);
}

// The next / previous track of the album that can actually play (has its file, did not fail to decode), or -1.
// Follows the shuffle order and Repeat (src/playorder.js); `natural` = the track ran out by itself (Repeat one replays it, a pressed Next still advances).
function nextGood(q, from, dir, natural = false) {
  return stepSlot({ n: q.items.length, order: q.order, from, dir, repeat: playMode().repeat, natural, playable: (j) => { const it = q.items[j]; return !!(it && it.file && !it.bad); } });
}
// The record ran out: the next playable track of the side (the needle crosses the gap and goes on), or the end of the album (frozen at the runout).
function onVinylTrackEnd() {
  const q = state.queue;
  const nx = q ? nextGood(q, q.index, 1, true) : -1;
  if (nx >= 0) playTarget({ index: nx, time: 0 }, { needle: false, natural: true });
  else stage.dispatch({ type: 'finished' });
}

// ── sleep timer (src/sleep.js): what is playing, how long the track has left, the fade, and the owner-aware stop ─────────────────────────────────
installMediaRegistry();   // streamed radio's detached <audio> elements must be findable for the fade
let sleepFader = null;
function sleepIsPlaying() {
  if (radio && radio.station) return true;
  const p = state.mixtapes && state.mixtapes.play;
  if (p && !p.ended) return !p.paused;
  if (!state.vinylOwned || state.radioOn) return false;
  return state.view === 'cd' ? !!state.cdPlaying : !!(stage.player.playing || stage.player.starting) || state.jumping;
}
function sleepTrackRemaining() {   // seconds to the end of the track that is playing (album or tape: both ride the one engine); radio has none
  if (radio && radio.station) return null;
  if (!sleepIsPlaying() || !(state.T > 0)) return null;
  return Math.max(0, state.T - state.engine.position / state.engine.sampleRate);
}
async function sleepStop() {   // the same owner-aware stop as the Stop key: a station ends, a tape pauses, an album pauses (all stay resumable from the mini bar)
  try {
    const own = engineOwner();
    if (own === 'radio') { radio.stop(); }
    else if (own === 'mixtape') { if (!state.mixtapes.play.paused) await miniActions.toggle('mixtape'); }
    else if (radio && radio.station) radio.stop();
    else if (sleepIsPlaying()) await miniActions.toggle('album');
  } catch (err) { console.warn('sleep stop failed', err); }
  refreshNowPlaying(); syncOwner();
  setTimeout(() => { try { sleepFader && sleepFader.set(1); } catch { /* */ } }, 400);   // volume back for the next time (the stop above is already silent)
  toast('Sleep timer: stopped playback');
}
const sleep = createSleep({
  getTrackRemaining: sleepTrackRemaining,
  isPlaying: sleepIsPlaying,
  applyGain: (g) => { if (g >= 1 && !sleepFader) return; sleepFader = sleepFader || createSleepFader(state.engine); sleepFader.set(g); },
  onExpire: () => { sleepStop(); },
});
window.__sleep = sleep;   // test hook (scripts/verify-basics.py)

// ── shuffle / repeat for albums and the Play-all queue (src/playorder.js; Settings > Playback and the stage sheet) ──────────────────────────────
// The track SLOTS stay put (titles, files, ids, the record's bands); only the order they are visited in changes, so a track id always maps to its own audio.
const playMode = () => ({ shuffle: !!settings.store.get('playback.shuffle'), repeat: settings.store.get('playback.repeat') || 'off' });
function prevInOrder(q) {   // "Previous" in shuffle: far into the track restarts it, else the track before it in the shuffle order
  const t = state.engine.position / state.engine.sampleRate;
  if (t > TONEARM_KNOBS.prevRestartSec) return { index: q.index, time: 0 };
  const j = nextGood(q, q.index, -1);
  return { index: j >= 0 ? j : q.index, time: 0 };
}
function syncQueueMode() {
  const q = state.queue; if (!q) return;
  const { shuffle, repeat } = playMode(), n = q.items.length;
  if (!shuffle) { q.order = null; q.shuf = false; }
  else if (!q.shuf || !validOrder(q.order, n)) { q.order = makeOrder(n, q.index, true); q.shuf = true; }   // the track on the platter leads, the rest are shuffled
  if (state.aq) state.aq = { ...state.aq, order: q.order, repeat };
}
// a toggle while playing: what was decoded ahead followed the OLD order, so drop it; the next tick decodes the right successor
function onPlayModeChange() {
  syncQueueMode();
  const aq = state.aq;
  if (aq && (aq.phase === 'preloading' || aq.phase === 'ready' || aq.phase === 'skipped')) {
    preTok++; state.pre = null; try { state.engine.dropNext(); } catch { /* */ }
    state.aq = { ...aq, order: state.queue.order, repeat: playMode().repeat, next: -1, nextBytes: 0, phase: 'idle', cold: false };
  }
  syncAlbumUI(); refreshNowPlaying();
}

// ── album gapless (queue.js model, AudioEngine.prepareNext / joinNext) ──────────────────────────────────────────────────────
// While a vinyl album track plays, the next playable one is decoded ahead into the engine's parked second deck; at the end the engine joins it (equal-power,
// ~50 ms) at the current platter rate, so scratch / brake / speed keep acting on whatever deck is active. Over the memory budget (or a failed decode ahead) the
// boundary is the old cold load. The spiral of a joined track is drawn from the RMS envelope (the engine owns the PCM; see refreshRecord).
function albumQueueTick(t, rate) {
  const q = state.queue;
  if (!state.aq || !q || q.kind !== 'vinyl' || !state.vinylOwned || state.jumping || state.view !== 'vinyl' || !stage.player.playing || state.radioOn) return;
  const r = queueReduce(state.aq, { type: 'tick', t, T: state.T, rate });
  state.aq = r.state;
  for (const a of r.actions) {
    if (a.type === 'preload') preloadAlbumNext(a.index);
    else if (a.type === 'join') joinAlbumNext(a.index, a.fadeSec);
  }
}
async function preloadAlbumNext(index) {
  const q = state.queue, it = q && q.items[index], aq = state.aq;
  if (!it || !it.file) return;
  const tok = ++preTok;
  const stale = () => tok !== preTok || state.queue !== q || state.aq == null;
  try {
    const track = await loadFile(it.file, state.engine.ctx, { copy: false, durationSec: it.dur });
    if (stale()) return;
    const [L, R] = track.channels;
    const envelope = computeEnvelope((i) => (R ? (L[i] + R[i]) * 0.5 : L[i]), track.frames, 1024);
    const tempoFeed = makeTempoFeed(track.channels, track.frames, state.engine.sampleRate);
    const nch = track.channels.length, bytes = track.frames * nch * 4;
    await state.engine.prepareNext(track.channels, track.frames);
    track.channels = null;
    if (stale()) { state.engine.dropNext(); return; }
    state.pre = { index, frames: track.frames, envelope, name: track.name, tempoFeed, nch };
    state.aq = queueReduce(state.aq, { type: 'preloaded', index, bytes }).state;
  } catch (err) {
    if (stale()) return;
    if (err && err.tooLong) state.aq = { ...state.aq, phase: 'skipped', next: index };       // too big to hold two: the boundary is a cold load (which says so)
    else { it.bad = true; state.aq = queueReduce(state.aq, { type: 'preloadFailed', index }).state; skipToast(it.title, err, it); }   // undecodable: skipped from now on, and said so (tapping it directly says so too)
  }
}
function joinAlbumNext(index, fadeSec) {
  const q = state.queue, pre = state.pre;
  if (!q || !pre || pre.index !== index || !state.engine.hasNext || state.engine.nextFrames !== pre.frames || !state.engine.joinNext({ fadeSec })) {
    state.pre = null; state.engine.dropNext();
    if (state.aq) state.aq = { ...state.aq, phase: 'skipped', next: index, cold: false };   // the loop's natural-end handling cold-loads it
    return;
  }
  preTok++; state.pre = null;
  q.index = index;
  state.track = { frames: pre.frames, name: pre.name, channels: null, nch: pre.nch, tempoFeed: pre.tempoFeed };
  state.frames = pre.frames;
  state.T = pre.frames / state.engine.sampleRate;
  state.envelope = pre.envelope;
  q.items[index].dur = state.T;
  state.reachedEnd = false;
  state.aq = queueReduce(state.aq, { type: 'joined' }).state;
  state.aq = queueReduce(state.aq, { type: 'start', index }).state;
  refreshRecord();
  stage.dispatch({ type: 'play', s: sFor(state.layout, index, 0) });
  syncAlbumUI();
  lsSet(LS.last, { id: q.albumId, index });
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
    // the visible transport (UX review): Previous / Next keys and a seek bar on the stage, beside the tonearm gesture
    prev: async () => { await state.engine.resume(); stepTrack(-1); },
    next: async () => { await state.engine.resume(); stepTrack(1); },
    seekFrac: (f) => seekBar(f),
    effect: onStageEffect,
    beginAudio: onBeginAudio,
    analyser: () => getAnalyser(),
    libraryOpen: (open) => onLibraryOpen(open),
    liveChange: () => syncEmpty(),
    emptyAction: () => { userScan = true; scanLibrary(); },
  });
  onAodOutlineMode((on) => stage.setOutline(on));   // always-on display: hairline circles only, static (docs/DEVICE_MODE.md)
  stage.setLibrary(tlib = mountTurntableLibrary(stage.libHost, { ...libraryDeps(), scanLabel: deviceLibrary.isAvailable() ? { long: 'Scan phone', short: 'Scan', hint: 'Scan your phone to play your own music' } : undefined }));
  wireLibrary();
  stage.setSpeedUI(state.speedBase);
  // rt test hooks (the prototype's window.__rt, plus the app handle for scripts/verify-turntable.py)
  window.__rt = Object.assign(stage.rt, {
    app: () => ({ shell: () => shell, settingsStore: settings.store, state, stage, tlib, albums, shelf, limits: DECODE_LIMITS, aiHost: () => makeAiHost(library), actions: () => searchActionsImpl(), library, intent: () => intent, radio: () => radio }),
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
  const own = engineOwner();
  if (own) {   // a tape / station owns the engine: the key acts on IT (never a stale platter state)
    if (own === 'radio') { try { radio.stop(); } catch { /* */ } } else await miniActions.toggle('mixtape');   // same hold as the mini bar: it stays so the paused tape can resume
    refreshNowPlaying(); syncOwner();
    return;
  }
  await state.engine.resume();
  if (state.albumId !== TEST_PRESSING_ID) markPicked();
  const pl = stage.player;
  if (pl.playing || pl.starting) {
    stage.dispatch({ type: 'toggle', s: currentS(state.engine.position / state.engine.sampleRate) });   // Stop: freeze + the arm slides back and folds away
    return;
  }
  const owner = engineOwner();
  if (owner) { flash(owner === 'radio' ? 'RADIO ON' : 'TAPE ON'); return; }   // the engine is a station's / a tape's right now
  const my = newIntent();
  if (!libLoaded) { await whenLibraryReady(); if (my !== intent) return; }    // the persisted library may still be restoring: an empty shelf is not an empty library
  if (platterIsDemo()) {   // real albums in the library but the demo on the platter: never play the demo, load the focused album (loud on failure)
    const a0 = albums[tlib.getFocus()];
    stage.setDisplay({ lit: true });
    if (!(await adoptFocusedAlbum(my)) || my !== intent) return;
    if ((a0 && a0.kind === 'cd') || state.view === 'cd') { state.cdPlaying = true; return; }
    playTarget(takeResumeStart() || { index: 0, time: 0 }, { needle: false });
    return;
  }
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
async function playTarget(target, { needle = false, natural = false } = {}) {
  await state.engine.resume();
  state.vinylOwned = true;
  state.engine.setPlaying(false);
  stage.setDisplay({ lit: true });
  const s = sFor(state.layout, target.index, target.time);
  stage.dispatch({ type: 'play', s });
  state.jumpS = s;
  await goTo(target, needle, { natural });
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
      ? (nextGood(q, q.index, 1) >= 0 ? { index: nextGood(q, q.index, 1), time: 0 } : null)
      : (playMode().shuffle ? prevInOrder(q) : previousTarget(q.index, state.engine.position / state.engine.sampleRate, q.items.length));
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
// the stage's seek bar: a position inside the track that is on the platter (the tonearm dimple seeks along the whole record; this is the plain 0:00..T bar).
// Like dropping the needle there: the arm goes to that point and the record plays on from it.
function seekBar(f) {
  if (state.jumping || !(state.T > 0) || engineOwner() || !state.vinylOwned || state.view !== 'vinyl') return;
  const q = state.queue, idx = q ? q.index : 0;
  const t = clamp(f * state.T, 0, Math.max(0, state.T - 0.5));
  state.engine.resume().then(() => {
    const s = q && state.layout ? sFor(state.layout, idx, t) : clamp(t / state.T, 0, 1);
    stage.dispatch({ type: 'play', s });
    state.jumpS = s; stage.setDrop(s);
    goTo({ index: idx, time: t }, false);
  });
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
// sound/animation (CD skips are silent). `natural` = the record ran out by itself (a failure then ends the record instead of resuming the old track).
function goTo(target, needle, opts = {}) {
  const q = state.queue;
  const sr = state.engine.sampleRate;
  if (!q || target.index === q.index) {
    if (state.jumping) { newIntent(); syncDisplay({ loading: false }); }   // a seek on the track that is still loaded cancels the jump that was decoding
    state.engine.seek(target.time * sr);
    state.reachedEnd = false;
    if (state.view === 'cd') cdSkipMute(); else finishDrop(needle);
    return Promise.resolve();
  }
  return jumpTo(target, needle, opts);
}

// Last tap wins: a jump supersedes the one still decoding (that one drops its result after its await). A track that cannot be decoded is marked, and the
// jump moves on to the next playable one in the direction of travel; nothing playable left = a natural end finishes the record, a manual jump stays where it was.
async function jumpTo(target, needle, { natural = false } = {}) {
  const q = state.queue;
  if (!q) return;
  const my = ++intent;
  const from = q.index, dir = target.index >= from ? 1 : -1;
  const pending = state.jumping;
  state.jumping = true; state.jumpTarget = target;
  if (state.view === 'vinyl') { state.jumpS = sFor(state.layout, target.index, target.time); syncDisplay({ loading: true }); }
  state.engine.setPlaying(false);
  let landed = -1, tooLong = false;
  try {
    await state.engine.resume();
    if (my !== intent) return;
    for (let idx = target.index; idx >= 0 && idx < q.items.length; idx = playMode().shuffle ? nextGood(q, idx, dir) : idx + dir) {   // after a failed track: the next one in the shuffle order, else the neighbour
      const it = q.items[idx];
      if (!it || !it.file) continue;
      if (it.bad) { if (idx === target.index && it.unsupported) toast(`Cannot play "${shortTitle(it.title) || 'that track'}": ${UNSUPPORTED_TEXT}`); continue; }   // known undecodable: skipped without a decode attempt
      try {
        const track = await loadFile(it.file, state.engine.ctx, { copy: false, durationSec: it.dur });
        if (my !== intent) return;
        q.index = idx;
        await loadTrack(track, q);
        landed = idx;
        break;
      } catch (err) {
        if (my !== intent) return;
        q.index = from;
        it.bad = true; tooLong = tooLong || !!(err && err.tooLong);
        console.error('track jump failed', err);
        failToast(it.title, err, it);
        if (state.aq) state.aq = { ...state.aq, failed: [...state.aq.failed, idx] };
      }
    }
  } finally {
    if (my === intent) { state.jumping = false; state.jumpTarget = null; syncDisplay({ loading: false }); }
  }
  if (my !== intent) return;
  if (landed >= 0) {
    if (landed === target.index && target.time > 0) state.engine.seek(target.time * state.engine.sampleRate);
    if (landed !== target.index && state.view === 'vinyl') stage.dispatch({ type: 'play', s: sFor(state.layout, landed, 0) });   // the arm settles on the track that did load
    if (state.view === 'cd') cdSkipMute(); else finishDrop(needle);
    return;
  }
  void pending;
  // nothing playable in that direction
  if (natural) { stage.dispatch({ type: 'finished' }); return; }
  stage.dispatch({ type: 'play', s: currentS(state.engine.position / state.engine.sampleRate) });   // stay on (and keep playing) the track that is still loaded
  if (state.view === 'cd') cdSkipMute(); else finishDrop(false);
}
const errMsg = (e) => String((e && e.message) || e || 'unknown error').slice(0, 120);
const failText = (err, it) => (err && err.tooLong ? 'too long to load' : unsupportedReason(it) || (/\.(m4a|m4b|mp4)$/i.test((it && ((it.file && it.file.name) || it.path || it.name)) || '') && err && err.name === 'EncodingError') ? UNSUPPORTED_TEXT : errMsg(err));

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
    items: item.tracks.map((t) => { const un = !!unsupportedReason(t); return { id: t.id, file: t.file, title: cleanTrackTitle(t.title), artist: t.artist || '', dur: Number.isFinite(t.durationSec) && t.durationSec > 0 ? t.durationSec : null, ...(un ? { bad: true, unsupported: true } : null) }; }),
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
  syncPickHint();   // an album got selected (adopted on the platter): 'Pick an album' would read as an instruction, not state
  const q = state.queue;
  const n = q ? q.items.length : 0;
  el('trkNav').classList.toggle('hidden', !(n > 1 && state.view === 'vinyl'));
  if (q) el('trkIdx').textContent = `${q.index + 1} / ${n}`;
  if (q && state.view === 'cd') {
    state.cd.setTracks(q.items.map((it) => it.title), estimateDurations(q.items.map((it) => it.dur)), q.index);
    state.cd.setInfo(albumLine());
  }
  tlib && tlib.setNowPlaying && tlib.setNowPlaying({ albumId: state.albumId, trackIndex: q ? q.index : 0 });
  syncLabel(); syncNow(); syncSheetAlbum();
}

// ── what is playing, in words: the stage's now-playing line, the record label, the CD header and the settings sheet ───────────────────────
const stripExt = (n) => String(n || '').replace(/\.[a-z0-9]{2,5}$/i, '');
function albumLine() {   // "Artist · Album" for the album on the platter / in the CD player
  const q = state.queue, it = q ? q.items[q.index] : null, m = state.albumMeta;
  const parts = [(it && it.artist) || (m && m.artist) || '', m ? m.title : ''].filter(Boolean);
  return parts.filter((v, i) => parts.indexOf(v) === i).join(' · ');
}
// A tape / station owns the engine: the stage says so by name, the platter stands still and Play/Stop acts on the owner.
let ownerKey = '';
function ownerInfo() {
  const own = engineOwner();
  if (!own) return null;
  if (own === 'radio') return { own, title: radio.station.name || 'Radio', sub: 'Radio playing · tap Stop to end it', playing: true };
  const p = state.mixtapes.play;
  return { own, title: (p.mix && p.mix.name) || 'Mixtape', sub: p.paused ? 'Tape paused · tap Play to resume it' : 'Tape playing · tap Stop to pause it', playing: !p.paused };
}
function syncOwner() {
  if (!stage) return;
  const o = ownerInfo();
  const key = o ? `${o.own}|${o.title}|${o.playing}` : '';
  if (key === ownerKey) return;
  ownerKey = key;
  stage.setPlayOverride(o ? o.playing : null);
  if (o && (stage.player.playing || stage.player.starting)) stage.dispatch({ type: 'stop' });   // the old record must not keep spinning under a tape
  syncNow();
}
function nowInfo() {
  const oi = ownerInfo();
  if (oi) return { mode: 'owner', title: oi.title, sub: oi.sub, time: false };
  if (platterIsDemo()) return { mode: 'pick', title: 'Pick an album', sub: 'Tap Library to choose your music', time: false };
  if (!state.vinylOwned) return null;                                   // a tape / station owns the engine: the Albums page says nothing
  if (state.albumId === TEST_PRESSING_ID) return { mode: 'demo', title: 'Demo record', sub: 'Built-in demo sound', time: true };
  const q = state.queue, it = q ? q.items[q.index] : null;
  const title = (it && it.title) || stripExt(state.track && state.track.name);
  if (!title) return null;
  return { mode: 'track', title, sub: albumLine() || (state.albumMeta ? '' : 'Single file'), time: true };
}
// the stage's Previous / Next keys: dim when there is nothing to step to (a station, the demo record, the last track)
function syncTransport() {
  if (!stage) return;
  const own = engineOwner();
  let prev = false, next = false;
  if (own === 'mixtape') prev = next = true;
  else if (!own && state.queue && state.view === 'vinyl') { const q = state.queue; prev = true; next = nextGood(q, q.index, 1) >= 0; }
  stage.setTransport({ prev, next });
}
let nowTimeOn = false;
function syncNow() {
  if (!stage) return;
  const n = nowInfo();
  stage.setNow(n ? { mode: n.mode, title: n.title, sub: n.sub } : { show: false });
  nowTimeOn = !!(n && n.time);
  if (!nowTimeOn) stage.setNowTime('');
  stage.setSeek({ enabled: nowTimeOn && !!state.vinylOwned && state.view === 'vinyl' });
  syncTransport();
}
let labelKey = null;
function syncLabel() {   // the record's label is the album's own art (or a generated label); the built-in swirl stays for the demo and loose files
  if (!stage) return;
  const m = state.albumMeta && !state.albumMeta.builtin ? state.albumMeta : null;
  const key = m ? m.id + '|' + (m.coverUrl || '') : '';
  if (key === labelKey) return;
  labelKey = key; stage.setLabelArt(m);
}
// the settings sheet's album card: title, artist and the track list (tap a row = play it)
let sheetKey = '';
function syncSheetAlbum() {
  const ti = el('ttAlbumTitle'), ts = el('ttAlbumSub'), tl = el('ttAlbumTracks');
  if (!ti) return;
  const q = state.queue, m = state.albumMeta;
  const n = nowInfo();
  ti.textContent = m && !m.builtin ? m.title : (n && n.mode === 'pick' ? 'Nothing picked yet' : (n ? n.title : 'Nothing loaded'));
  ts.textContent = m && !m.builtin ? [m.artist, q ? `${q.items.length} track${q.items.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') : (n && n.mode === 'pick' ? 'Tap Library to choose your music' : '');
  const key = q ? state.albumId + '|' + q.items.map((it) => it.title).join('\u0001') : '';
  if (key !== sheetKey) {
    sheetKey = key; tl.textContent = '';
    if (q && q.items.length > 1) q.items.forEach((it, i) => {
      const li = document.createElement('li'); li.tabIndex = 0; li.setAttribute('role', 'button');
      const nn = document.createElement('span'); nn.className = 'n'; nn.textContent = String(i + 1).padStart(2, '0');
      const t = document.createElement('span'); t.className = 't'; t.textContent = it.title || `Track ${i + 1}`;
      const d = document.createElement('span'); d.className = 'd'; d.textContent = it.dur > 0 ? formatTime(it.dur) : '';
      li.append(nn, t, d); li.dataset.i = String(i); tl.appendChild(li);
    });
  }
  [...tl.children].forEach((li, i) => { const on = !!q && i === q.index; li.classList.toggle('cur', on); if (on) li.setAttribute('aria-current', 'true'); else li.removeAttribute('aria-current'); });
}
function pickSheetTrack(i) {
  const q = state.queue;
  if (!q || (i === q.index && !state.jumping && state.view === 'vinyl' && stage.player.playing)) return;
  markPicked();
  state.engine.resume().then(() => { if (state.view === 'vinyl') { state.fx?.lift(); playTarget({ index: i, time: 0 }, { needle: true }); } else goTo({ index: i, time: 0 }, false); });
}

function stepTrack(dir) {
  const own = engineOwner();
  if (own === 'mixtape' && state.mixtapes) { if (dir > 0) state.mixtapes.nextSong(); else state.mixtapes.prevSong(); return; }   // a tape owns the engine: Next / Prev act on the tape, not on a queue that is not playing
  if (own === 'radio') { flash('RADIO ON'); return; }
  const q = state.queue;
  if (!q) return;
  const base = state.jumping && state.jumpTarget ? state.jumpTarget.index : q.index;   // taps in a row step from where the last one is going
  const t = state.engine.position / state.engine.sampleRate;
  let target;
  if (dir > 0) { const j = nextGood(q, base, 1); target = j >= 0 ? { index: j, time: 0 } : null; }
  else if (base === q.index && !state.jumping && t > TONEARM_KNOBS.prevRestartSec) target = { index: base, time: 0 };
  else { const j = nextGood(q, base, -1); target = j >= 0 ? { index: j, time: 0 } : { index: q.index, time: 0 }; }
  if (!target) return;
  if (state.view === 'vinyl') { state.fx?.lift(); playTarget(target, { needle: true }); }
  else goTo(target, false);
}

function installAlbumNav() {
  // the CD view's seek bar: the same component as the vinyl stage's (the ring on the disc still seeks too)
  const cdSeek = createSeekBar({ label: 'Seek in this track', onSeek: (f) => { if (allowsGesture('tonearm-drag') && !state.jumping) goTo({ index: state.queue?.index ?? 0, time: f * state.T }, false); } });
  cdSeek.el.classList.add('cd-seek'); cdSeek.el.setAttribute('data-lock-surface', '');
  el('cdNum').parentNode.after(cdSeek.el);
  el('btnPrevTrk').addEventListener('click', async () => { await state.engine.resume(); stepTrack(-1); });
  el('btnNextTrk').addEventListener('click', async () => { await state.engine.resume(); stepTrack(1); });
  state.cd = new CdView({
    root: el('cdView'), canvas: el('cdCanvas'), list: el('cdList'),
    prev: el('cdPrev'), next: el('cdNext'), play: el('cdPlay'),
    num: el('cdNum'), time: el('cdTime'), title: el('cdTitle'), sub: el('cdSub'), seek: cdSeek,
  }, {
    onTrack: (i) => { if (state.queue) goTo({ index: i, time: 0 }, false); },
    onSeekFrac: (f) => { if (!state.jumping) goTo({ index: state.queue?.index ?? 0, time: f * state.T }, false); },
    onPrev: () => stepTrack(-1),
    onNext: () => stepTrack(1),
    onToggle: async () => { await state.engine.resume(); cdToggle(); },
  });
  // from the CD view the library is one tap away (the stage is hidden behind the CD player; zoom is a vinyl-side gesture)
  el('cdLibBtn').addEventListener('click', () => { el('pageAlbums').dataset.lib = '1'; stage.dispatch({ type: 'setZ', z: 1 }); onLibraryOpen(true); });
  setView(state.view);
}

// ── controls / HUD ───────────────────────────────────────────────────────────────────────────────────────────────────────
function installControls() {
  // Fine speed (the continuous dial, spec §5): the 33 / 45 / 78 buttons and −/+ live on the stage; this slider is in Turntable settings.
  const rpmSlider = el('rpmSlider');
  rpmSlider.addEventListener('input', () => setRpm(Number(rpmSlider.value)));

  // Live feel knobs — dialing these by hand is most of v0's job (spec §4).
  bindKnob('knobJ', 'J');
  bindKnob('knobK', 'k');
  bindKnob('knobC', 'c');
  bindKnob('knobBrake', 'brakeDamp');

  // Load a local file (drag-drop or picker).
  const loadLoose = async (f) => {
    const my = newIntent();
    await state.engine.resume();
    let track;
    try { track = await loadFile(f, state.engine.ctx, { copy: false }); }
    catch (err) { if (my === intent) failToast(stripExt(f.name), err, { name: f.name }); return; }
    if (my !== intent) return;
    try { await loadTrack(track, null, false, false, { id: null, meta: null }); } catch (err) { failToast(stripExt(f.name), err, { name: f.name }); return; }
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
  window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !inControl() && allowsGesture('platter-brake')) { e.preventDefault(); state.braking = true; } });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space' && state.braking && !inControl()) { e.preventDefault(); state.braking = false; } });
  // Esc zooms back in from the library
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && allowsGesture('pinch-zoom') && stage.zoom > 0.5 && !document.querySelector('.wt-overlay:not(.hidden)')) { stage.dispatch({ type: 'zoomTo', z: 0 }); } });

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
  if (nowTimeOn && stage) { stage.setNowTime(`${formatTime(t)} / ${formatTime(state.T)}`); stage.setSeek({ t, T: state.T }); }
}

// ── Tracks and options (was Deck details): the old side panel, now a sheet opened from the small control on the Albums page ──────────────────────
function installDetails() {
  const page = el('pageAlbums'), sheet = el('deckSheet');
  { const ph = el('ttPlayModeHost'); if (ph) mountPlayMode(ph, settings.store); }   // shuffle / repeat in the sheet
  { const sh = el('ttSleepHost'); if (sh) mountSleep(sh, sleep); mountSleepChip(el('pageAlbums'), sleep, { onTap: () => { const b = el('btnDeck'); if (b && el('deckSheet').hidden) b.click(); } }); }   // sleep timer: sheet + countdown chip
  const actions = page.querySelector('.page-actions');
  const ICON = (d) => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">${d}</svg>`;
  // the Library button: always visible on the Albums header (the pinch stays as the gesture); labelled, >= 44 px
  const lb = document.createElement('button');
  lb.type = 'button'; lb.className = 'tt-lib-btn'; lb.id = 'btnLibrary'; lb.style.order = '-1'; lb.dataset.open = 'false';   // one pattern: the accessible name IS the visible label (Library / Player), no aria-pressed
  lb.innerHTML = ICON('<rect x="3.5" y="4" width="7" height="7" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="13.5" y="4" width="7" height="7" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="3.5" y="14" width="7" height="7" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="13.5" y="14" width="7" height="7" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.7"/>');
  const lbl = document.createElement('span'); lbl.className = 'tt-lib-lbl'; lbl.textContent = 'Library'; lb.appendChild(lbl);
  actions.prepend(lb);
  lb.addEventListener('click', () => { if (!allowsGesture('library-chip')) return; toggleLibrary(); });
  libBtnSync = (open) => { lb.dataset.open = String(open); lbl.textContent = open ? 'Player' : 'Library'; };
  // Tracks and options (was Deck details): the sheet behind the sliders icon
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'tt-details-btn'; btn.id = 'btnDeck'; btn.setAttribute('aria-label', 'Tracks and options'); btn.title = 'Tracks and options'; btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = ICON('<path d="M4 8h9M17 8h3M4 16h3M11 16h9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="15" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="9" cy="16" r="2" fill="none" stroke="currentColor" stroke-width="1.7"/>');
  { const dk = actions.querySelector('.dm-key'); if (dk) actions.insertBefore(btn, dk); else actions.append(btn); }   // DOM order = visual order: Library, Search, Turntable settings, then the lock key
  let releaseSheet = null;
  const set = (open) => {
    sheet.hidden = !open; btn.setAttribute('aria-expanded', String(open));
    if (open) { syncSheetAlbum(); if (!releaseSheet) releaseSheet = trapFocus(sheet, { initial: sheet.querySelector('.tt-sheet-close'), onEscape: () => set(false) }); }
    else if (releaseSheet) { const r = releaseSheet; releaseSheet = null; r(); }
    else btn.focus({ preventScroll: true });
  };
  btn.addEventListener('click', () => set(sheet.hidden));
  sheet.querySelector('.tt-sheet-close').addEventListener('click', () => set(false));
  const rows = el('ttAlbumTracks');
  rows.addEventListener('click', (e) => { const li = e.target.closest && e.target.closest('li'); if (li) pickSheetTrack(Number(li.dataset.i)); });
  rows.addEventListener('keydown', (e) => { if (e.key !== 'Enter' && e.key !== ' ') return; const li = e.target.closest && e.target.closest('li'); if (li) { e.preventDefault(); pickSheetTrack(Number(li.dataset.i)); } });
  const fb = sheet.querySelector('.tt-filebtn');   // the real <input type=file> is hidden from AT and Tab: this label is the keyboard / screen-reader control
  if (fb) fb.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el('fileInput').click(); } });
  syncSheetAlbum();
}

// ── the Library button, the first-run nudge and what a finished scan tells the user ───────────────────────────────────────────────────────
const COVER_TAP_PLAYS = true;   // a tap on the centre cover loads AND plays the album (false = load only; see wireLibrary)
let libBtnSync = () => {};
let libShown = false;       // the library was opened for the user by a scan this session
let userScan = false;       // a scan the user asked for (Scan chip, empty-state button, Allow)
let pickHintOn = false;     // the first-run 'Pick an album' nudge is armed; it shows only while nothing is selected (the demo is still on the platter)
function syncPickHint() { if (tlib && tlib.setPickHint) tlib.setPickHint(pickHintOn && platterIsDemo() ? 'Pick an album' : null); }
const markPicked = () => { pickHintOn = false; try { lsSet(LS.picked, 1); } catch { /* */ } tlib && tlib.setPickHint && tlib.setPickHint(null); };
function openLibrary() {
  if (state.view === 'cd') el('pageAlbums').dataset.lib = '1';
  stage.dispatch({ type: 'zoomTo', z: 1 });
}
function closeLibrary() {
  if (state.view === 'cd') delete el('pageAlbums').dataset.lib;
  stage.dispatch({ type: 'zoomTo', z: 0 });
}
function toggleLibrary() { if (stage.zoom > 0.5) closeLibrary(); else openLibrary(); }
function onLibraryOpen(open) {
  libBtnSync(open);
  if (open) syncScanChip();     // 'last scan 3 min ago' is as old as now
  if (!open) { pickHintOn = false; tlib && tlib.setPickHint && tlib.setPickHint(null); }
}
const plural = (n, one, many) => `${Number(n).toLocaleString('en-US')} ${n === 1 ? one : many}`;
function agoText(ms) {
  if (!ms) return '';
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return new Date(ms).toLocaleDateString();
}
// After a scan: say what was found, and (until the user has picked something) open the shelf so the music is the first thing they see.
function announceLibrary(explicit) {
  const n = library.tracks.length;
  if (!n) return;
  if (explicit) toast(`Found ${plural(n, "song", "songs")}`, 3500);
  const open = !libShown && !lsGet(LS.picked) && shell && shell.current === 'albums' && stage.zoom < 0.5 && !engineOwner()
    && !stage.player.playing && !document.querySelector('.wt-overlay:not(.hidden)');
  if (open) {
    libShown = true;
    tlib.focus(0, { animate: false });
    stage.dispatch({ type: 'zoomTo', z: 1 });
    pickHintOn = true; syncPickHint();
  }
}
// the Scan chip: "Scan phone" until the phone has been read, then "Rescan" with when it was last read
function syncScanChip() {
  if (!tlib || !library) return;
  const n = library.tracks.length;
  if (deviceLibrary.isAvailable()) {
    const st = deviceLibrary.status.get();
    const needsAccess = st.phase === 'needs-permission' || st.phase === 'denied' || st.phase === 'blocked';
    const busy = st.phase === 'scanning' || st.phase === 'tagging';
    const ago = agoText(st.lastScanAt);
    const sh = library.shortHidden | 0;
    const info = [n ? `${plural(n, 'song', 'songs')}${ago ? ` · last scan ${ago}` : ''}` : '', sh ? `${plural(sh, 'short song', 'short songs')} hidden · change in Settings` : ''].filter(Boolean).join(' · ');
    if (needsAccess || (!n && !busy)) tlib.setScanLabel({ long: 'Scan phone', short: 'Scan', aria: 'Scan phone for music' });
    else if (busy) tlib.setScanLabel({ long: 'Scanning…', short: 'Scanning', aria: 'Scanning your phone for music' });
    else tlib.setScanLabel({ long: 'Rescan phone', short: 'Rescan', aria: `Rescan phone for music${info ? '. ' + info : ''}` });
    tlib.setScanInfo(info);
  } else {
    const relink = library.linkSummary && library.linkSummary.needsRelink;
    if (n && relink) tlib.setScanLabel({ long: 'Re-link music', short: 'Re-link', aria: 'Re-link your music files' });
    else if (n) tlib.setScanLabel({ long: 'Rescan folder', short: 'Rescan', aria: 'Rescan your music folder' });
    tlib.setScanInfo(n ? plural(n, 'song', 'songs') : '');
  }
}
// first run / nothing scanned yet: the demo record, and a card that says how to get your own music (the native permission card speaks for itself)
function syncEmpty() {
  if (!stage || !library) return;
  const native = deviceLibrary.isAvailable();
  let show = libLoaded && !libHasAlbums() && state.albumId === TEST_PRESSING_ID && !(stage.player.playing || stage.player.starting);   // only for a truly empty library (a filter hiding every album, or a restore still running, is not empty); out of the way while the demo plays
  if (show && native && describeStatus(deviceLibrary.status.get()).show) show = false;
  stage.setEmpty({
    show, title: 'Demo record',
    body: native ? (library.shortHidden ? `${plural(library.shortHidden, 'short song', 'short songs')} hidden (under 30 s). Change that in Settings, or scan your phone again.` : 'Scan your phone to play your own music.') : 'Scan a music folder to play your own music.',
    button: native ? 'Scan phone' : 'Choose music folder',
  });
}
let scanBusy = false, scanWasEmpty = false;
function onDeviceStatus(st) {
  const busy = st.phase === 'scanning' || st.phase === 'tagging';
  if (busy && !scanBusy) { scanBusy = true; scanWasEmpty = !shelf.length; }
  else if (!busy && scanBusy) {
    scanBusy = false;
    if (st.phase === 'idle' && st.trackCount > 0) { rebuildAlbums(); announceLibrary(scanWasEmpty || userScan); }
    userScan = false;
  }
  syncScanChip(); syncEmpty();
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
    albums = [builtinTestPressing({ durationSec: 24, title: 'Demo record', artist: 'Runout' })];
  }
  tlib.setAlbums(albums);
  const at = albums.findIndex((a) => a.id === state.albumId);
  if (at >= 0) tlib.focus(at, { animate: false });
  syncAlbumUI();
  syncEmpty(); syncScanChip();
  if (platterIsDemo()) scheduleAdopt();
}
const indexOfAlbum = (id) => albums.findIndex((a) => a.id === id);

// load album `index` of the library list (decode ONE track: the engine decodes whole files, the queue keeps a single resident track).
// `my` is the playback intent this load belongs to: a user action takes a fresh one, a silent adopt passes the current one, so any later action wins.
async function loadAlbum(index, trackIndex = 0, my = newIntent()) {
  const a = albums[index];
  if (!a) return false;
  if (a.builtin) {
    stage.setDisplay({ loading: true });
    try {
      await state.engine.resume();
      if (my !== intent) return false;
      await loadTrack(synthesizeTrack(state.engine.sampleRate, 24), null, false, false, { id: a.id, meta: a });
    } finally { if (my === intent) stage.setDisplay({ loading: false, lit: true }); }
    state.cdAlbum = false;
    syncDisplay(); syncAlbumUI();
    return true;
  }
  const item = shelf[index];
  const trackObj = item && item.tracks[trackIndex];
  if (!trackObj) return false;
  const why = unsupportedReason(trackObj);
  if (why) { flash('UNSUPPORTED FORMAT'); toast(`Cannot play "${trackObj.title || 'this track'}": ${why}`); return false; }   // wma, ALAC, ...: say so instead of a generic decode error
  if (!trackObj.file) { flash('RE-LINK FILES'); toast(`"${trackObj.title || 'This track'}" needs its file back: tap Scan to re-link your music.`); return false; }   // persisted metadata only: needs the file back (a user gesture)
  stage.setDisplay({ loading: true });
  try {
    await state.engine.resume();
    if (my !== intent) return false;
    const track = await loadFile(trackObj.file, state.engine.ctx, { copy: false, durationSec: trackObj.durationSec });   // no second copy of a 100 MB decode: the engine packs its own
    if (my !== intent) return false;      // a newer action superseded this decode
    await loadTrack(track, queueFor(item, trackIndex), false, false, { id: item.id, meta: a });   // a failure leaves the old record, album and queue untouched
  } catch (err) {
    if (my !== intent) return false;
    console.error('album load failed', err);
    flash(err && err.tooLong ? 'TOO LONG TO LOAD' : 'CANNOT READ FILE');
    failToast(trackObj.title, err, trackObj);
    return false;
  } finally {
    if (my === intent) stage.setDisplay({ loading: false });
  }
  lsSet(LS.last, { id: item.id, index: trackIndex });
  syncDisplay(); syncAlbumUI();
  return true;
}

// An album the carousel settled on (a swipe, or tlib.focus() from search's "Open album") goes onto the platter, silently. A tape / station that is playing is
// left alone; CD cases stay shelved until a track is picked.
let focusAdoptTimer = 0;
function adoptFocus(index, my = intent) {
  const a = albums[index];
  if (my !== intent || !a || a.id === state.albumId || a.kind === 'cd' || foreignPlaying()) return;   // a user action since the swipe settled wins over this silent adopt
  stage.dispatch({ type: 'stop', s: 0 });
  return loadAlbum(index, 0, my);
}
function adoptFocusSoon(index) { clearTimeout(focusAdoptTimer); const my = intent; focusAdoptTimer = setTimeout(() => adoptFocus(index, my), 420); }

function wireLibrary() {
  // tap a track in the library: zoom back in and play that track
  const playAlbumTrack = async (albumId, trackIndex) => {
    markPicked();
    const idx = indexOfAlbum(albumId);
    if (idx < 0) return;
    const a = albums[idx];
    stage.dispatch({ type: 'zoomTo', z: 0 });
    await state.engine.resume();
    if (a.kind === 'cd') {                       // CD cases open the CD view (src/cd.js) as before, not the platter
      delete el('pageAlbums').dataset.lib;
      const my = ++intent; state.jumping = false;
      if (await loadAlbum(idx, trackIndex, my) && my === intent) { state.cdPlaying = true; }
      return;
    }
    if (state.albumId === a.id && state.view === 'vinyl' && queueMatchesRow(state.queue, shelf[idx], trackIndex)) {   // already on the platter (and the queue still IS this row): just move the needle
      playTarget({ index: trackIndex, time: 0 }, { needle: true });
      return;
    }
    stage.dispatch({ type: 'stop', s: 0 });
    const my = ++intent; state.jumping = false;
    if (await loadAlbum(idx, trackIndex, my) && my === intent) {
      stage.setDisplay({ lit: true });
      if (a.builtin) stage.dispatch({ type: 'play', s: 0 });
      else playTarget({ index: trackIndex, time: 0 }, { needle: false });
    }
  };
  tlib.on('selectTrack', (albumId, trackIndex) => playAlbumTrack(albumId, trackIndex));
  // tap the centre cover: back to the player, and PLAY the album (UX review: a cover tap that only loaded read as broken, while row taps and search results play).
  // COVER_TAP_PLAYS is the one switch: false restores "a cover tap only loads the album".
  tlib.on('tapCover', async (albumId) => {
    const ai = indexOfAlbum(albumId);
    const a = albums[ai];
    if (COVER_TAP_PLAYS && a && !a.builtin && !foreignPlaying()) {
      const same = state.albumId === a.id && state.queue;
      if (same && (state.view === 'cd' ? state.cdPlaying : (stage.player.playing || stage.player.starting))) { markPicked(); stage.dispatch({ type: 'zoomTo', z: 0 }); if (a.kind === 'cd') delete el('pageAlbums').dataset.lib; return; }   // already playing it: just back to the player
      if (same && state.view === 'vinyl' && a.kind !== 'cd' && !state.jumping) { markPicked(); stage.dispatch({ type: 'zoomTo', z: 0 }); await onToggle(); return; }   // paused mid-album: resume where it stopped
      if (same && state.view === 'cd' && a.kind === 'cd' && !state.jumping) { markPicked(); stage.dispatch({ type: 'zoomTo', z: 0 }); delete el('pageAlbums').dataset.lib; await state.engine.resume(); cdToggle(); return; }   // a paused (or just resumed) CD: play on from where it is, not from 0:00
      return playAlbumTrack(albumId, same ? state.queue.index : 0);
    }
    markPicked();
    stage.dispatch({ type: 'zoomTo', z: 0 });
    // The cover you tapped is the record you get, unless that would cut off a tape / station that is playing: leaving the library is then just a zoom back.
    if (a && !a.builtin && a.kind !== 'cd' && state.albumId !== a.id && !state.jumping && !foreignPlaying()) { stage.dispatch({ type: 'stop', s: 0 }); await loadAlbum(ai, 0); }
    if (a && a.kind === 'cd' && state.queue && state.queue.kind === 'cd') delete el('pageAlbums').dataset.lib;
  });
  // swipe sideways: when the carousel settles on another album, load it (debounced: a fling past covers decodes nothing)
  let focusTimer = 0;
  tlib.on('focus', (index) => {
    pickHintOn = false; tlib.setPickHint(null);   // the user chose by swiping: the nudge has done its job
    clearTimeout(focusTimer);
    const my = intent;                         // captured now: a row tap inside the debounce window bumps intent and must not be overridden
    focusTimer = setTimeout(() => adoptFocus(index, my), 420);
  });
  tlib.on('filter', (kind) => { view.kind = kind; rebuildAlbums(); });
  tlib.on('sort', (sort) => { view.sort = sort; rebuildAlbums(); });
  tlib.on('scan', () => scanLibrary());
}

let scanning = false;
async function scanLibrary() {
  if (scanning) return;
  scanning = true;
  userScan = true;
  try {
    if (deviceLibrary.isAvailable()) {   // Android app: the toolbar's Scan means "scan the phone" (permission first, never a folder picker)
      const ph = deviceLibrary.status.get().phase;
      if (ph === 'blocked') await deviceLibrary.source.openSettings();
      else if (ph === 'needs-permission' || ph === 'denied') await deviceLibrary.allowAndScan();
      else await deviceLibrary.scan({ force: true });
      rebuildAlbums();
      return;      // the status subscription (onDeviceStatus) announces a finished scan
    }
    const pending = library.linkSummary?.needsRelink || 0;
    const onProgress = (done, total) => { flash(`SCANNING ${done}/${total}`); if (done % 25 === 0 || done === total) rebuildAlbums(); };
    if (pending) await library.relink(onProgress); else await library.scan(onProgress);
    rebuildAlbums();
    announceLibrary(true);
  } finally { scanning = false; userScan = false; syncDisplay(); }
}

function installLibrary() {
  library = new LibraryManager();
  // Persisted library metadata (tags only, no audio) -> albums + mixtape refs resolve before any re-scan;
  // those tracks show "needs re-link" until then.
  libReady = library.restore().then((n) => { libLoaded = true; if (n) { rebuildAlbums(); state.mixtapes?.refresh?.(); restoreLast(); announceLibrary(false); } else syncEmpty(); }).catch(() => { libLoaded = true; syncEmpty(); });
  rebuildAlbums();
  if (deviceLibrary.isAvailable()) {   // Android app only: device tracks stream into the same library; the card explains / asks / shows progress
    let t = 0;
    library.onChange(() => { clearTimeout(t); t = setTimeout(() => { rebuildAlbums(); state.mixtapes?.refresh?.(); }, 400); });
    installDeviceLibrary(library).then(() => { rebuildAlbums(); restoreLast(); }).catch(() => {});
    const host = document.createElement('div'); host.className = 'dv-host'; el('pageAlbums').appendChild(host);
    deviceLibrary.mountScanCard(host);
    deviceLibrary.status.subscribe(onDeviceStatus);
  }

  // Mixtapes: custom playlists (pure model in mixtape.js; this is wiring only).
  state.mixtapes = new MixtapeUI({
    toast: (t) => toast(t),
    getLibraryTracks: () => library.tracks,
    closeLibrary: () => { /* the player opens over the page; nothing to close */ },
    playFile: async (file) => {
      const my = newIntent();                // the tape's own song is a user action too: it supersedes an album decode still in flight, and the other way round
      await state.engine.resume();
      const track = await loadFile(file, state.engine.ctx, { copy: false });
      if (my !== intent) throw new Error('superseded');
      await loadTrack(track, null, false, true, { id: null, meta: null });
      return track;
    },
    relink: () => library.relink(),
    scanMusic: async () => { await scanLibrary(); state.mixtapes?.refresh?.(); },   // the Mixtapes empty state and the editor's Add tab: the same scan as Albums (folder picker on the web, permission + scan on Android)
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
      track.nch = track.channels.length;
      track.envelope = computeEnvelope((i) => (R ? (L[i] + R[i]) * 0.5 : L[i]), track.frames, 1024); // off the join path
      return track;
    },
    prepareNext: (track) => state.engine.prepareNext(track.channels, track.frames),
    joinNext: (fadeSec) => state.engine.joinNext({ fadeSec }),
    dropNext: () => state.engine.dropNext(),
    adoptTrack: (track) => {
      // The engine already switched decks; mirror loadTrack()'s non-engine state.
      state.vinylOwned = false;
      state.track = { frames: track.frames, name: track.name, channels: null, nch: track.nch };
      state.frames = track.frames;
      state.T = track.frames / state.engine.sampleRate;
      state.envelope = track.envelope;
      state.reachedEnd = false;
      state.stationLeftover = false;
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
            onPlay: () => { newIntent(); },   // the tap is the intent (not the show's first song load, which would also supersede a tape the user opened a moment after the tap)
            onActive: (on) => { state.radioOn = on; state.engine.setPlaying(!on); if (on) { newIntent(); parkTapeUnderStation(); } },   // a station and a tape never share the engine
            libraryEmpty: () => !!libLoaded && !libHasAlbums(),   // offline shows need songs: say so on the card instead of starting an empty session
            openAlbums: () => { try { shell.go('albums', { close: true }); } catch { /* */ } },
            aiHost: makeAiHost(library), // You Radio (src/radio/offline) plays your library through this engine
          });
          radio.mount(host.querySelector('#paneRadio'));
          foreignPlaybackHook = () => { radio.foreignPlayback(); if (state.radioOn) radio.stop(); };   // a streamed station has its own <audio> and mutes the bus: the user's own track ends it (else the record plays silently under a live station)
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

// A streamed station takes the engine from a tape that was playing: release the tape's UI AND park its engine track in the runout groove.
// Merely muting it left the song running silently, and the station's Stop (setPlaying(true)) then brought it back as ghost audio.
function parkTapeUnderStation() {
  const p = state.mixtapes && state.mixtapes.play;
  const hadTape = !!(p && !p.ended);
  try { state.mixtapes && state.mixtapes.releaseEngine(); } catch { /* */ }
  if (!hadTape) return;
  try { state.engine.dropNext(); state.engine.setRate(0); state.engine.seek(Math.max(0, state.frames - 2)); } catch { /* */ }
  state.stationLeftover = true;
}

function boothShown() {
  const pl = stage.player;
  if (pl.playing || pl.starting || !state.vinylOwned || engineOwner() || state.view !== 'vinyl') return;
  if (!libLoaded || platterIsDemo()) {   // the demo is for an empty library only: with real albums (or while they are still restoring) put the focused one on the platter first
    const my = newIntent();
    (async () => {
      if (!libLoaded) await whenLibraryReady();
      if (my !== intent) return;
      if (platterIsDemo() && !(await adoptFocusedAlbum(my))) return;
      if (my !== intent) return;
      if (pl.playing || pl.starting || !state.vinylOwned || engineOwner() || state.view !== 'vinyl') return;   // a CD took the platter, or something else started
      stage.setDisplay({ lit: true });
      stage.dispatch({ type: pl.frozenS > FINISHED ? 'play' : 'toggle', s: 0 });
    })();
    return;
  }
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
  walkthrough = new Walkthrough({
    scanLabel: deviceLibrary.isAvailable() ? 'Scan my music' : 'Choose music folder',
    hasMusic: () => libHasAlbums(),
    onScan: () => { try { shell.go('albums', { close: true }); } catch { /* */ } userScan = true; scanLibrary(); },   // inside the tap that pressed the button: the folder picker needs that gesture
  });

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
  let releaseTrap = () => {};   // the focus trap of the open overlay (Tab stays inside, Escape closes, focus returns to the opener)

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
    releaseTrap();
    releaseTrap = trapFocus(overlay.querySelector('.theme-card'), { initial: input, onEscape: closeOverlay });
  }

  function closeOverlay() {
    overlay.classList.add('hidden');
    releaseTrap(); releaseTrap = () => {};
  }

  customThemeApi.open = openOverlay;   // the Settings page's "Import JSON..." button

  el('themePreviewBtn').addEventListener('click', showPreview);
  el('themeBack').addEventListener('click', showEdit);
  el('themeCancel1').addEventListener('click', closeOverlay);   // Cancel/back discards — nothing was ever applied.
  el('themeCancel2').addEventListener('click', closeOverlay);
  el('themeX1').addEventListener('click', closeOverlay);
  el('themeX2').addEventListener('click', showEdit);
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
      envelope: () => (state.track ? state.envelope || null : null),
      hasRecord: () => !!state.track,
      // the deck strip: what is on the platter / CD player right now (null when nothing is loaded)
      nowPlaying: () => {
        if (!state.track) return null;
        const q = state.queue, cd = state.view === 'cd';
        const it = q && q.items && q.items[q.index];
        return { title: (it && it.title) || state.track.name || 'Untitled', sub: q && q.items ? `track ${q.index + 1} of ${q.items.length}` : '', kind: cd ? 'cd' : 'vinyl', rpm: cd ? 0 : state.rpm,
          playing: cd ? !!state.cdPlaying : !!(stage && stage.player.playing) };
      },
    },
    blocked: () => engineOwner(),
    goto: (id) => { if (shell) { shell.go(id, { close: true }); shell.ensure(id); } },
    haptic: (ms) => { try { if (settings.store.get('haptics')) navigator.vibrate?.(ms); } catch { /* no haptics */ } },
  };
}

// Which radio / mixtape session owns the engine right now, or null.
function engineOwner() {
  if (radio && radio.station) return 'radio';
  const p = state.mixtapes && state.mixtapes.play;
  if (p && !p.ended) return 'mixtape';
  return null;
}

// The now-playing mini bar: whatever plays from any source, on every section but its own. Radio gets Stop; albums and mixtapes get
// play / pause and next. A source paused FROM the bar stays on it (miniHold) so it can be resumed from there.
// CD Play / Pause. Play on a disc that already ran out starts it again from track 1 (like Play on a finished vinyl record).
function cdToggle() {
  if (state.cdPlaying) { state.cdPlaying = false; return; }
  if (state.reachedEnd) { state.reachedEnd = false; state.cdPlaying = true; goTo({ index: 0, time: 0 }, false); return; }
  state.cdPlaying = true;
}
let miniHold = null;
const miniActions = {
  stop: () => radio && radio.stop(),
  async toggle(source) {
    try {
      if (source === 'album') {
        await state.engine.resume();
        const playing = state.view === 'cd' ? state.cdPlaying : (stage.player.playing || stage.player.starting);
        miniHold = playing ? 'album' : null;
        if (state.view === 'cd') cdToggle();
        else stage.dispatch(playing ? { type: 'toggle', s: currentS(state.engine.position / state.engine.sampleRate) } : { type: 'toggle' });   // Pause freezes at the playhead (s), like the Stop key
      } else if (source === 'mixtape' && state.mixtapes) {
        const p = state.mixtapes.play;
        miniHold = p && !p.paused ? 'mixtape' : null;
        await Promise.resolve(state.mixtapes.togglePlayback()).catch((err) => console.warn('mini bar tape toggle failed', err));
      }
    } catch (err) { console.warn('mini bar toggle failed', err); }
    refreshNowPlaying();
  },
  async prev(source) {   // media-button / notification Previous
    try {
      if (source === 'album') { await state.engine.resume(); stepTrack(-1); }
      else if (source === 'mixtape' && state.mixtapes && state.mixtapes.play) state.mixtapes.prevSong();
    } catch (err) { console.warn('previous failed', err); }
    refreshNowPlaying();
  },
  async seek(source, sec) {   // the notification / lock-screen seek bar: an album seeks within the track that is on the platter
    try {
      if (source !== 'album' || !state.queue || !(state.T > 0)) return;
      await state.engine.resume();
      goTo({ index: state.queue.index, time: clamp(sec, 0, Math.max(0, state.T - 0.5)) }, false);
    } catch (err) { console.warn('seek failed', err); }
    refreshNowPlaying();
  },
  async next(source) {
    try {
      if (source === 'album') { await state.engine.resume(); stepTrack(1); }
      else if (source === 'mixtape' && state.mixtapes && state.mixtapes.play) state.mixtapes.nextSong();
    } catch (err) { console.warn('mini bar next failed', err); }
    refreshNowPlaying();
  },
};
// artist / album for the notification and the lock screen (the mini bar's own text stays as is)
function mediaMeta(source) {
  if (source === 'album') { const q = state.queue, it = q && q.items[q.index], m = state.albumMeta; return { artist: (it && it.artist) || (m && m.artist) || '', album: (m && m.title) || '', artworkUrl: (m && !m.builtin && m.coverUrl) || '' }; }
  if (source === 'mixtape') { const p = state.mixtapes && state.mixtapes.play; return { artist: 'Mixtape', album: (p && p.mix && p.mix.name) || '' }; }
  return { artist: 'Radio', album: '' };
}
const modeSuffix = () => { const m = playMode(); return (m.shuffle ? ' · shuffle' : '') + (m.repeat === 'all' ? ' · repeat all' : m.repeat === 'one' ? ' · repeat one' : ''); };   // surfaced on the mini bar's sub line
// playhead for the notification / lock-screen seek bar (an album can seek; a tape shows its position only; radio has none)
function mediaPosition(source) {
  if (source === 'radio' || !state.track || !(state.T > 0)) return null;
  return { positionSec: state.engine.position / state.engine.sampleRate, durationSec: state.T, seekable: source === 'album' };
}
function refreshNowPlaying() {
  if (!shell) return;
  const src = {};
  if (radio && radio.station) {
    const ph = radio.session?.state?.phase;
    src.radio = { title: radio.station.name, sub: ph === 'playing' ? 'Radio · on air' : ph === 'error' ? 'Radio · error' : 'Radio · connecting', playing: ph !== 'error' };   // an error is not "on air": the bar's dot goes grey
  }
  const p = state.mixtapes && state.mixtapes.play;
  if (p && !p.ended && !p.paused) src.mixtape = { title: p.mix.name || 'Mixtape', sub: `Mixtape · track ${Math.max(1, p.idx + 1)} of ${p.files.length}`, playing: true, canNext: p.idx + 1 < p.files.length, canPrev: true };
  const q = state.queue;
  if (q && !state.radioOn && (state.view === 'cd' ? state.cdPlaying : (stage.player.playing && state.vinylOwned))) {
    src.album = { title: q.items[q.index].title || (state.track && state.track.name) || 'Album', sub: `${q.kind === 'cd' ? 'CD' : 'Vinyl'} · track ${q.index + 1} of ${q.items.length}${modeSuffix()}`, playing: true, canNext: q.index + 1 < q.items.length || playMode().repeat !== 'off' || (playMode().shuffle && q.items.length > 1), canPrev: true };
  }
  if (p && !p.ended && p.paused && !state.mixtapes.playerOpen && !miniHold) miniHold = 'mixtape';   // a paused tape whose player was closed stays on the mini bar, resumable
  if (miniHold && (src.radio || src[miniHold])) miniHold = null;          // something is playing again: no hold needed
  if (miniHold === 'mixtape' && p && !p.ended && !src.mixtape) src.mixtape = { title: p.mix.name || 'Mixtape', sub: `Mixtape · paused · track ${Math.max(1, p.idx + 1)} of ${p.files.length}`, playing: false, canNext: false };
  else if (miniHold === 'album' && q && !src.album) src.album = { title: q.items[q.index].title || (state.track && state.track.name) || 'Album', sub: `${q.kind === 'cd' ? 'CD' : 'Vinyl'} · paused · track ${q.index + 1} of ${q.items.length}`, playing: false, canNext: false };
  else if (miniHold && !src[miniHold]) miniHold = null;
  shell.setNowPlaying(src, miniActions);
  bg && bg.sync(src);     // the notification / lock screen / mediaSession follow the same picture
  if (deviceMode) { const n = src.radio || (src.mixtape && src.mixtape.playing ? src.mixtape : null) || (src.album && src.album.playing ? src.album : null); deviceMode.setNowPlaying({ title: n ? n.title : '', playing: !!n }); }
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
      const track = await loadFile(libTrack.file, eng().ctx, { copy: false, durationSec: libTrack.durationSec });
      engineGate.check(tok);
      const bytes = track.frames * track.channels.length * 4;
      await loadTrack(track, null, true);         // releases a tape that was playing (a station and a tape never share the engine)
      return { durationSec: state.T, envelope: state.envelope, bytes };
    },
    async decodeNext(libTrack) {
      const tok = engineGate.token();
      const track = await loadFile(libTrack.file, eng().ctx, { copy: false, durationSec: libTrack.durationSec });
      engineGate.check(tok);
      const [L, R] = track.channels;
      const envelope = computeEnvelope((i) => (R ? (L[i] + R[i]) * 0.5 : L[i]), track.frames, 1024);
      return { track, tok, envelope, name: track.name, frames: track.frames, durationSec: track.frames / eng().sampleRate, bytes: track.frames * track.channels.length * 4 };
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
      state.stationLeftover = true;
      refreshRecord();
    },
    position: () => ({ t: eng().position / eng().sampleRate, T: state.T }),
    async halt() { // stop = the needle rests in the runout groove; the vinyl bus stays alive for the next record
      if (!state.stationLeftover) return;   // the deck now holds the user's record / tape (loadTrack already replaced the show's song): leave it alone
      eng().dropNext();
      eng().seek(Math.max(0, state.frames - 2));
    },
  };
}

boot().catch((err) => {
  document.getElementById('latency').textContent = 'boot error: ' + err.message;
  console.error(err);
});
