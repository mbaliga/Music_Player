// default-faces.js — the shipped lock faces for the four sections (docs/DEVICE_MODE.md "What is frozen per section"). Selectors target the
// DOM as of this commit; controls added later should carry `data-lock-ok` instead of editing this list. Section authors may also call
// registerLockFace() themselves from their own mount code: a later registration replaces the default.
import { registerLockFace } from './faces.js';

export const DEFAULT_FACES = Object.freeze({
  albums: {
    // Play/Stop, 33/45/78 + -/+ speed and prev/next track stay live; platter, tonearm, zoom, library, display toggle and drawer are frozen.
    buttons: ['#tt-playBtn', '#tt-b78', '#tt-b33', '#tt-b45', '#tt-bm', '#tt-bp', '#btnPrevTrk', '#btnNextTrk', '#cdPrev', '#cdPlay', '#cdNext', '#rpmSlider'],
    aodText: ['#cdTitle'],
    notes: 'Albums: play, stop, speed and track keys are live. The record, arm and shelf are locked.',
  },
  mixtapes: {
    // Cassette player transport keys (SVG role=button), wind keys, AUTO, FLIP, eject. Shelf, editor, stack gestures and skin chips frozen.
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
});

export function registerDefaultFaces() { for (const [id, f] of Object.entries(DEFAULT_FACES)) registerLockFace(id, f); }
