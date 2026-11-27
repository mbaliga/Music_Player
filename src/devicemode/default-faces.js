// default-faces.js — the shipped lock faces for the shell sections (docs/DEVICE_MODE.md "What is frozen per section"). Selectors target the
// DOM as of this commit; controls added later should carry `data-lock-ok` instead of editing this list. Section authors may also call
// registerLockFace() themselves from their own mount code: a later registration replaces the default.
import { registerLockFace } from './faces.js';

export const DEFAULT_FACES = Object.freeze({
  albums: {
    // Live: Play/Stop, 33/45/78 + -/+ speed, the stage's Previous / Next keys, prev/next (Tracks and options / CD view keys) and the lock key.
    // Frozen (`data-lock-surface`, and every stage / library entry point asks allowsGesture): the disc scratch and the palm-brake hold on the label,
    // the tonearm dimple drag / seek / flick and the seek bar, pinch and Ctrl+wheel zoom, the coverflow swipe, cover and track-row taps, the library chips, the header
    // chips (search, Tracks and options), the dot-display toggle, the drawer / hamburger, Space (brake) and Esc (zoom in).
    buttons: ['#tt-playBtn', '#tt-b78', '#tt-b33', '#tt-b45', '#tt-bm', '#tt-bp', '#tt-prev', '#tt-next', '#btnPrevTrk', '#btnNextTrk', '#cdPrev', '#cdPlay', '#cdNext', '#rpmSlider'],
    aodText: ['#cdTitle'],
    notes: 'Play, Stop and speed keys work.',
  },
  mixtapes: {
    // Cassette player: transport keys (SVG role=button), wind keys (hold), the labelled Flip and Auto-flip buttons (.tp-flip, .tp-auto), eject stay live. Frozen: the shelf / stack, the editor and
    // importer, the Look / Click sounds / Vibration chips, Back and Songs, and the tap-the-tape song-list reveal (a reveal, not a key: decided frozen).
    buttons: ['.tp [role=button]', '.tp [data-key]', '.tp .tp-flip', '.tp .tp-auto'],
    aodText: ['.tp-title', '.tp .cass-title'],
    notes: 'Open a tape before locking to use its keys.',
  },
  radio: {
    // Stop / skip / mini-bar controls. The dial and the lists are not usable while locked.
    buttons: ['.radio-pill-stop', '.radio-now .theme-btn', '.radio-skip', '[data-radio-key]'],
    aodText: ['.radio-now .alb-name', '.radio-pill-name'],
    notes: 'Stop and Skip work. The dial is locked.',
  },
  booth: {
    // The rack buttons, switches, knobs and the fader stay live (they carry data-lock-ok too); the touch plate and the performance pads (gesture surfaces) are frozen unless the setting allows it.
    buttons: ['#boothHost .fx-row', '#boothHost .fx-tog', '#boothHost .fx-btn', '#boothHost .fx-knob', '#boothHost .fx-fader'],
    aodText: ['#boothHost .fx-title'],
    notes: 'Rack, switches and knobs work. Plate and pads are locked.',
  },
  settings: {
    // Settings is not a playing surface: nothing on it stays live while locked (a control that should be live carries `data-lock-ok`).
    buttons: ['#settingsHost [data-lock-ok]'],
    aodText: [],
    notes: 'Settings are locked.',
  },
});

export function registerDefaultFaces() { for (const [id, f] of Object.entries(DEFAULT_FACES)) registerLockFace(id, f); }
