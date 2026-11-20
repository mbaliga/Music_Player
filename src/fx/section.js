// section.js — the stable entry point for the shell: `import('../fx/section.js').then((m) => m.mountFxSection(container, deps))`.
// Returns { unmount, onShow, onHide, onTrack, platter, controller }. See docs/FX.md "Component contract".
export { mountFxSection } from './ui.js';
