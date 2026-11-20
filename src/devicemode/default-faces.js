// default-faces.js — the shipped lock faces for the shell sections (docs/DEVICE_MODE.md "What is frozen per section"). Selectors target the
// DOM as of this commit; controls added later should carry `data-lock-ok` instead of editing this list. Section authors may also call
// registerLockFace() themselves from their own mount code: a later registration replaces the default.
import { registerLockFace } from './faces.js';

export const DEFAULT_FACES = Object.freeze({
  albums: {
    // Live: Play/Stop, 33/45/78 + -/+ speed, prev/next (Deck details / CD view keys) and the lock key.
    // Frozen (`data-lock-surface`, and every stage / library entry point asks allowsGesture): the disc scratch and the palm-brake hold on the label,
    // the tonearm dimple drag / seek / flick, pinch and Ctrl+wheel zoom, the coverflow swipe, cover and track-row taps, the library chips, the header
    // chips (search, Deck details), the dot-display toggle, the drawer / hamburger, Space (brake) and Esc (zoom in).
    buttons: ['#tt-playBtn', '#tt-b78', '#tt-b33', '#tt-b45', '#tt-bm', '#tt-bp', '#btnPrevTrk', '#btnNextTrk', '#cdPrev', '#cdPlay', '#cdNext', '#rpmSlider'],
    aodText: ['#cdTitle'],
    notes: 'Albums: Play / Stop and the speed keys are live. The record, arm and library are locked.',
  },
  mixtapes: {
    // Cassette player: transport keys (SVG role=button), wind keys (hold), AUTO, FLIP, eject stay live. Frozen: the shelf / stack, the editor and
    // importer, the skin / haptics chips and the close button, and the tap-the-tape song-list reveal (a reveal, not a key: decided frozen).
    buttons: ['.tp [role=button]', '.tp [data-key]'],
    aodText: ['.tp-title', '.tp .cass-title'],
    notes: 'Mixtapes: open the cassette player before locking to use its keys. The shelf and editor are locked.',
  },
  radio: {
    // Stop / skip / mini-bar controls. The dial and the lists are not usable while locked.
    buttons: ['.radio-pill-stop', '.radio-now .theme-btn', '.radio-skip', '[data-radio-key]'],
    aodText: ['.radio-now .alb-name', '.radio-pill-name'],
    notes: 'Radio: Stop and Skip are live. The dial is not usable while locked.',
  },
  booth: {
    // The mode buttons / chips stay live; the FX pad (a gesture surface) is frozen unless the setting allows it.
    buttons: ['#boothHost .fx-row', '#boothHost .fx-chip', '#boothHost .fx-btn', '#boothHost .fx-switch input'],
    aodText: ['#boothHost .fx-title'],
    notes: 'Booth: the mode buttons are live. The FX pad is locked (Settings can allow it).',
  },
  settings: {
    // Settings is not a playing surface: nothing on it stays live while locked (a control that should be live carries `data-lock-ok`).
    buttons: ['#settingsHost [data-lock-ok]'],
    aodText: [],
    notes: 'Settings: locked. Unlock to change an option.',
  },
});

export function registerDefaultFaces() { for (const [id, f] of Object.entries(DEFAULT_FACES)) registerLockFace(id, f); }
