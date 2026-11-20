// index.js — Device mode controller (DOM). Wires the pure state machine (state.js) to the page: the lock key, the frozen face, keep-awake,
// the always-on display. ONE mechanism for the frozen face: `body[data-devicemode~="locked"]` + the generated allowlist CSS (faces.js) + a
// capture-phase guard here that uses the SAME allowlist for the events CSS cannot stop (keyboard, TalkBack click, wheel, context menu).
//
//   const dm = initDeviceMode({ storage, nav, doc, win });   // early in boot: registers the guards before the shell's own listeners
//   dm.mountKeys();                                          // after createShell(): puts the lock key in every section header
//   dm.setNowPlaying({ title, playing });                    // from refreshNowPlaying(): feeds the "never time out while playing" rule + AOD title
// Docs: docs/DEVICE_MODE.md. Every error path drops to UNLOCKED.
import { createMachine } from './state.js';
import { createSettings, DEFAULTS } from './settings.js';
import { createKeepAwake } from './keepawake.js';
import { getDisplayPlugin, createDisplayControl } from './native.js';
import { frameGate } from './framegate.js';
import { pixelShift, minuteOf } from './pixelshift.js';
import { liveSelectors, faceCss, getLockFace, ALWAYS_FROZEN, registerLockFace } from './faces.js';
import { registerDefaultFaces } from './default-faces.js';
import { _setGuard, allowsGesture } from './guard.js';
import { setAodOutlineMode, onAodOutlineMode } from './aodhooks.js';
import { createLockKey } from './lockkey.js';
import { openSheet } from './sheet.js';

const LOCK_KEY = 'runout.devicemode.locked';
const OVERLAY_Q = '.tp:not(.hidden)';
const FADE_MS = 160;
const AOD_LONG_MS = 600, AOD_DOUBLE_MS = 350, AOD_DOUBLE_PX = 48;
const BLOCK_EVENTS = ['click', 'dblclick', 'auxclick', 'contextmenu', 'selectstart', 'dragstart', 'wheel', 'gesturestart', 'gesturechange'];

export function initDeviceMode(opts = {}) {
  const win = opts.win || window, doc = opts.doc || document, body = doc.body;
  const storage = opts.storage !== undefined ? opts.storage : (() => { try { return win.localStorage; } catch { return null; } })();
  const settings = opts.settings || createSettings(storage);
  const S = () => settings.get();
  registerDefaultFaces();

  const machine = createMachine({ settings: S, onChange: onState });
  const keep = createKeepAwake({ native: getDisplayPlugin(win), nav: win.navigator, doc });
  const display = createDisplayControl(getDisplayPlugin(win));
  const keys = [];                 // every lock key instance (one per header + the floating one)
  const reduced = () => { try { return win.matchMedia('(prefers-reduced-motion: reduce)').matches || readBlob(storage, 'appearance')?.reduceMotion === 'reduce'; } catch { return false; } };
  let section = 'albums', timer = 0, hintT = 0, shiftT = 0, fadeT = 0, aodApplied = false, np = { title: '', playing: false };
  let ui = null, hintEl = null, noticeEl = null, npEl = null, faceStyle = null, popTrapped = false, ignorePop = 0;

  // ── allowlist ────────────────────────────────────────────────────────────────────────────────────────────────────────
  const liveSel = () => liveSelectors(section, S()).join(', ');
  const frozenSel = ALWAYS_FROZEN.join(', ');
  function isAllowed(t) {
    try {
      const el = t && t.nodeType === 1 ? t : t && t.parentElement;
      if (!el || !el.closest) return false;
      if (el.closest('.dm-key, .dm-ui, .dm-sheet')) return true;
      if (el.closest(frozenSel)) return false;
      return !!el.closest(liveSel());
    } catch (e) { fail('allowlist ' + (e && e.message)); return true; }
  }
  function fail(why) { try { console.error('device mode: dropped to unlocked:', why); } catch { /* */ } machine.fail(); }

  // ── state -> page ────────────────────────────────────────────────────────────────────────────────────────────────────
  function currentSection() {
    const p = doc.querySelector('#shellPages .page:not([hidden])');
    return (p && p.dataset.section) || 'albums';
  }
  function syncSection() {
    const s = currentSection();
    if (s !== section || !faceStyle || !faceStyle.textContent) { section = s; paintFace(); }
    body.dataset.dmSection = section;
    if (!getLockFace(section)) { try { console.warn('device mode: no lock face for section', section, '- using the generic button allowlist'); } catch { /* */ } }
  }
  function paintFace() {
    if (!faceStyle) { faceStyle = doc.createElement('style'); faceStyle.id = 'dm-face-css'; doc.head.append(faceStyle); }
    faceStyle.textContent = faceCss(section, S());
  }
  function paintVars() {
    const s = S();
    body.style.setProperty('--dm-glow-pct', s.glowPct + '%');
    body.dataset.dmDim = s.dimFrozen ? '1' : '0';
  }
  function haptic(ms) { try { if (readBlob(storage, 'haptics') !== false && win.navigator.vibrate) win.navigator.vibrate(ms); } catch { /* */ } }

  function onState(st, prev) {
    try {
      syncSection(); paintVars();
      writeAttr();   // 'aod' is only ever added/removed by setAod (after its fade)
      _setGuard({ locked: st.locked, aod: aodApplied, fxPadWhileLocked: S().fxPadWhileLocked });
      for (const k of keys) k.setLocked();
      if (st.locked !== prev.locked) { haptic(st.locked ? 14 : [10, 40, 10]); if (st.locked) trapBack(); else untrapBack(); persist(); if (!st.locked) { clearHint(); noticeEl && (noticeEl.hidden = true); blurFrozen(false); } else blurFrozen(true); }
      if (st.wake !== prev.wake || st.locked !== prev.locked) keep.set(st.wake && st.locked).then((r) => { if (st.wake && r && !r.held) showHint('The screen may still turn off on its own (keep-awake unavailable).', 4000); });
      if (st.aod !== prev.aod) setAod(st.aod);
      if (st.notice === 'timeout' && prev.notice !== 'timeout') showNotice();
      if (!st.locked && prev.locked) { setAod(false); }
      schedule();
    } catch (e) { fail(e && e.message); }
  }
  function writeAttr() {
    const toks = []; if (machine.state.locked) toks.push('locked'); if (aodApplied) toks.push('aod');
    if (toks.length) body.dataset.devicemode = toks.join(' '); else delete body.dataset.devicemode;
  }
  function blurFrozen(on) { try { if (on && doc.activeElement && doc.activeElement !== body && !isAllowed(doc.activeElement)) doc.activeElement.blur(); } catch { /* */ } }
  function persist() { try { if (S().persistLock && storage) storage.setItem(LOCK_KEY, JSON.stringify(machine.snapshot())); else storage && storage.removeItem(LOCK_KEY); } catch { /* */ } }

  // ── AOD ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  function setAod(on) {
    on = !!on && machine.state.locked;
    if (on === aodApplied) return;
    clearTimeout(fadeT);
    const shell = doc.getElementById('shell');
    const apply = () => {
      aodApplied = on; writeAttr();
      _setGuard({ locked: machine.state.locked, aod: on, fxPadWhileLocked: S().fxPadWhileLocked });
      frameGate.setMode(on ? 'aod' : 'normal');
      setAodOutlineMode(on);
      applyNative(on); applyShift(on);
      if (shell && !reduced()) { shell.style.transition = `opacity ${FADE_MS}ms ease`; shell.style.opacity = '1'; fadeT = setTimeout(() => { shell.style.transition = ''; shell.style.opacity = ''; }, FADE_MS + 20); }
    };
    if (shell && !reduced()) { shell.style.transition = `opacity ${FADE_MS}ms ease`; shell.style.opacity = '0'; fadeT = setTimeout(apply, FADE_MS); }
    else apply();
  }
  function applyNative(on) {
    const s = S();
    if (on) { display.setBrightness(s.aodBrightnessPct / 100); display.setRefreshRate(s.aodLowRefresh ? 1 : null); }
    else { display.setBrightness(null); display.setRefreshRate(null); }
  }
  function applyShift(on) {
    clearInterval(shiftT);
    const set = () => { const s = S(); const o = on && s.pixelShift ? pixelShift(minuteOf(Date.now())) : { x: 0, y: 0 }; body.style.setProperty('--dm-sx', o.x + 'px'); body.style.setProperty('--dm-sy', o.y + 'px'); };
    set(); if (on) shiftT = setInterval(set, 60000);
  }
  function showNpTitle() { if (npEl) npEl.textContent = np.title || ''; }

  // ── scheduling ───────────────────────────────────────────────────────────────────────────────────────────────────────
  function schedule() {
    clearTimeout(timer); timer = 0;
    const d = machine.nextDueMs(Date.now());
    if (d != null) timer = setTimeout(() => { machine.tick(Date.now()); schedule(); }, d);
  }

  // ── hint / notice UI ─────────────────────────────────────────────────────────────────────────────────────────────────
  function buildUi() {
    ui = doc.createElement('div'); ui.className = 'dm-ui';
    hintEl = doc.createElement('div'); hintEl.className = 'dm-hint'; hintEl.setAttribute('role', 'status'); hintEl.setAttribute('aria-live', 'polite'); hintEl.hidden = true;
    noticeEl = doc.createElement('div'); noticeEl.className = 'dm-notice'; noticeEl.setAttribute('role', 'status'); noticeEl.hidden = true;
    npEl = doc.createElement('div'); npEl.className = 'dm-np'; npEl.setAttribute('aria-hidden', 'true');
    ui.append(hintEl, noticeEl, npEl); body.append(ui);
  }
  function showHint(msg, ms = 2200) { if (!hintEl) return; hintEl.textContent = msg; hintEl.hidden = false; clearTimeout(hintT); hintT = setTimeout(clearHint, ms); }
  function clearHint() { clearTimeout(hintT); if (hintEl) hintEl.hidden = true; }
  function showNotice() {
    if (!noticeEl) return;
    const m = S().keepAwakeMin;
    noticeEl.textContent = `Screen hold released after ${m} min without use. It is on again now.`;
    noticeEl.hidden = false; setTimeout(() => { machine.dismissNotice(); noticeEl.hidden = true; }, 6000);
  }
  const unlockHint = () => { const m = S().unlockMethod; return m === 'hold' ? 'Hold the lock key to unlock' : m === 'double' ? 'Double-tap the lock key to unlock' : 'Slide the lock key to unlock'; };
  const faceHint = () => { const f = getLockFace(section); return (f && f.notes) || ''; };

  // ── Android back: never unlock silently ──────────────────────────────────────────────────────────────────────────────
  function trapBack() { try { if (!popTrapped) { win.history.pushState({ dm: 1 }, ''); popTrapped = true; } } catch { /* */ } }
  function untrapBack() { try { if (popTrapped) { popTrapped = false; if (win.history.state && win.history.state.dm) { ignorePop++; win.history.back(); } } } catch { /* */ } }
  win.addEventListener('popstate', () => {
    if (ignorePop > 0) { ignorePop--; return; }
    if (machine.state.locked) { try { win.history.pushState({ dm: 1 }, ''); } catch { /* */ } showHint(unlockHint(), 3000); }
  });

  // ── input: activity, AOD wake gestures, the frozen-face guard ───────────────────────────────────────────────────────
  let lastDown = { t: NaN, x: 0, y: 0 }, longT = 0, longStart = null;
  function onPointerDown(e) {
    const st = machine.state;
    if (!st.locked) return;
    const allowed = isAllowed(e.target);
    if (st.aod && !allowed) {
      const t = e.timeStamp;
      if (S().aodWake === 'double' && Number.isFinite(lastDown.t) && t - lastDown.t > 0 && t - lastDown.t <= AOD_DOUBLE_MS && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) <= AOD_DOUBLE_PX) { lastDown.t = NaN; machine.wakeGesture('double'); return; }
      lastDown = { t, x: e.clientX, y: e.clientY };
      if (S().aodWake === 'long') { clearTimeout(longT); longStart = { x: e.clientX, y: e.clientY }; longT = setTimeout(() => { longT = 0; machine.wakeGesture('long'); }, AOD_LONG_MS); }
    }
    if (st.aod && allowed && e.target.closest && e.target.closest('.dm-key') && S().aodWake === 'lockkey') { /* wake on release (tap), below */ }
    machine.activity(allowed ? 'button' : 'touch'); schedule();
    if (allowed && e.target.closest && e.target.closest('[data-lock-surface]')) {       // a live button inside a gesture surface must not reach the surface
      const stop = (ev) => ev.stopPropagation(); e.target.addEventListener('pointerdown', stop, { once: true });
    }
  }
  function endLong(e) { if (longT) { clearTimeout(longT); longT = 0; } }
  function onPointerMove(e) { if (longT && longStart && Math.hypot(e.clientX - longStart.x, e.clientY - longStart.y) > 12) endLong(); }
  function onPointerUp(e) {
    endLong();
    const st = machine.state;
    if (st.locked && st.aod && S().aodWake === 'lockkey' && e.target.closest && e.target.closest('.dm-key')) machine.wakeGesture('lockkey');
  }
  function onKey(e) {
    const st = machine.state; if (!st.locked) return;
    const ok = isAllowed(e.target);
    machine.activity(ok ? 'key' : 'key'); schedule();
    if (ok) return;
    if (e.key === 'Tab' || e.key === 'Shift' || e.key === 'Escape') return;           // keyboard / TalkBack focus movement stays possible
    e.preventDefault(); e.stopImmediatePropagation();
  }
  function onBlockable(e) {
    if (!machine.state.locked) return;
    if (isAllowed(e.target)) return;
    if (e.cancelable) e.preventDefault();
    e.stopImmediatePropagation();
  }
  function onTouch(e) {
    if (!machine.state.locked) return;
    if (isAllowed(e.target)) return;
    if (e.cancelable) e.preventDefault();
  }
  win.addEventListener('pointerdown', onPointerDown, true);
  win.addEventListener('pointermove', onPointerMove, true);
  win.addEventListener('pointerup', onPointerUp, true);
  win.addEventListener('pointercancel', endLong, true);
  win.addEventListener('keydown', onKey, true);
  for (const t of BLOCK_EVENTS) win.addEventListener(t, onBlockable, { capture: true, passive: false });
  for (const t of ['touchstart', 'touchmove']) win.addEventListener(t, onTouch, { capture: true, passive: false });
  doc.addEventListener('visibilitychange', () => {
    const v = doc.visibilityState !== 'hidden';
    machine.visibility(v); schedule();
    if (!v) { display.setBrightness(null); display.setRefreshRate(null); }
    else if (aodApplied) applyNative(true);
  });

  // ── lock key mounting ────────────────────────────────────────────────────────────────────────────────────────────────
  function keyDeps(host, floating) {
    return {
      host, floating,
      getLocked: () => machine.state.locked, getMethod: () => S().unlockMethod,
      onLock: () => { machine.lock(); schedule(); showHint(faceHint(), 3200); },
      onUnlock: () => { machine.unlock(); },
      onHint: (m) => showHint(m, 1800),
      onTick: () => schedule(),
    };
  }
  function mountKeys() {
    if (!ui) buildUi();
    for (const actions of doc.querySelectorAll('.page-head .page-actions')) {
      if (actions.querySelector('.dm-key')) continue;
      const gear = doc.createElement('button'); gear.type = 'button'; gear.className = 'dm-gear'; gear.setAttribute('aria-label', 'Device mode settings'); gear.title = 'Device mode settings'; gear.textContent = '⚙';
      gear.addEventListener('click', () => openSheet({ settings, doc }));
      actions.append(gear);
      keys.push(createLockKey(keyDeps(actions, false)));
    }
    if (!doc.querySelector('.dm-key-float')) keys.push(createLockKey(keyDeps(body, true)));
    syncSection(); paintVars();
    const pages = doc.getElementById('shellPages');
    if (pages && typeof MutationObserver === 'function') new MutationObserver(() => { syncSection(); }).observe(pages, { attributes: true, attributeFilter: ['hidden'], subtree: true });
    if (typeof MutationObserver === 'function') {
      let q = false;
      new MutationObserver(() => { if (q) return; q = true; Promise.resolve().then(() => { q = false; body.dataset.dmOverlay = doc.querySelector(OVERLAY_Q) ? '1' : '0'; }); })
        .observe(body, { attributes: true, attributeFilter: ['class', 'hidden'], subtree: true, childList: true });
    }
    for (const k of keys) k.setLocked();
  }

  settings.subscribe(() => { _setGuard({ locked: machine.state.locked, aod: aodApplied, fxPadWhileLocked: S().fxPadWhileLocked }); paintFace(); paintVars(); machine.refresh(); if (aodApplied) { applyNative(true); applyShift(true); } keep.set(machine.state.wake && machine.state.locked); schedule(); });

  // initial state: a fresh launch is UNLOCKED unless the user asked for persistence
  try { let saved = null; try { saved = JSON.parse((storage && storage.getItem(LOCK_KEY)) || 'null'); } catch { /* */ } machine.restore(saved); } catch { /* */ }
  if (!ui) buildUi();

  return {
    machine, settings, keepAwake: keep, display, frameGate, allowsGesture, registerLockFace, onAodOutlineMode,
    mountKeys, isAllowed,
    lock: () => machine.lock(), unlock: () => machine.unlock(), toggle: () => machine.toggle(),
    get state() { return machine.state; },
    setNowPlaying(v) { np = { title: (v && v.title) || '', playing: !!(v && v.playing) }; machine.playing(np.playing); showNpTitle(); schedule(); },
    showHint,
  };
}

function readBlob(storage, key) {
  try {
    const b = JSON.parse(storage && storage.getItem('runout.settings.v1'));
    if (!b) return undefined;
    return key === 'haptics' ? b.haptics : key === 'appearance' ? b.appearance : undefined;
  } catch { return undefined; }
}
export { DEFAULTS, allowsGesture, registerLockFace, onAodOutlineMode, setAodOutlineMode, frameGate };
