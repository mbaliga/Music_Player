// nav.js — the navigation shell (DOM + gestures). The current section is a big rounded card that is pulled aside to the right
// from the left edge; the section menu sits revealed behind it. Pure parts: drawer.js (physics/decisions), arbitration.js,
// sections.js. This file only wires them to the DOM. Contract and tunables: docs/SHELL.md.
//
// Expected markup (index.html): #shell > #drawer (nav) > #drawerMenu, #card > #cardInner > #shellPages > section[data-section],
// .minibar, .card-handle, #cardCover, #edgeStrip, .shell-peek. Section headers (hamburger + title) are created here.
import {
  DRAWER, openOffset, progress, cardScale, rubberBand, velocityFromSamples, settleTarget, classifyMove, springStep, isSettled,
} from './drawer.js';
import { drawerMayStart } from './arbitration.js';
import { SECTIONS, loadSection, saveSection, resolveSection, stepMenu } from './sections.js';
import { pickNowPlaying, miniBarVisible } from './nowplaying.js';
import { allowsGesture } from '../devicemode/guard.js';

const PAGE_MS = 300;   // the new page's slide/fade-in; the card's spring runs alongside (≈ 250-320 ms end to end)
const OVERLAYS = '.wt-overlay:not(.hidden), .theme-overlay:not(.hidden), .tp:not(.hidden), .mt-dialog, .ed-ov, .bk-ov, .ed, .search-ov:not(.hidden)';
const GEAR = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M18.02 10.53 L20.69 10.63 L20.69 13.37 L18.02 13.47 L17.30 15.22 L19.11 17.18 L17.18 19.11 L15.22 17.30 L13.47 18.02 L13.37 20.69 L10.63 20.69 L10.53 18.02 L8.78 17.30 L6.82 19.11 L4.89 17.18 L6.70 15.22 L5.98 13.47 L3.31 13.37 L3.31 10.63 L5.98 10.53 L6.70 8.78 L4.89 6.82 L6.82 4.89 L8.78 6.70 L10.53 5.98 L10.63 3.31 L13.37 3.31 L13.47 5.98 L15.22 6.70 L17.18 4.89 L19.11 6.82 L17.30 8.78Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
const SEARCH = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M15 15l5 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
const HAMBURGER = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

const reduced = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const storage = () => { try { return window.localStorage; } catch { return null; } };

/**
 * opts = {
 *   hooks: { [sectionId]: { mount?(host) -> controller|Promise, onShow?(), onHide? () } }   controller may also return {onShow,onHide,unmount}
 *   isPageGestureLive?: () => boolean     platter scrub / tonearm seek / pinch in progress (blocks the drawer)
 *   onSection?: (id) => void
 *   onSearch?: () => void                 adds a search button to every page header (Search overlay, src/search/)
 * }
 */
export function createShell(opts = {}) {
  const $ = (id) => document.getElementById(id);
  const shell = $('shell'), drawer = $('drawer'), card = $('card'), inner = $('cardInner'), cover = $('cardCover');
  const strip = $('edgeStrip'), menu = $('drawerMenu'), peek = shell.querySelector('.shell-peek');
  const handle = card.querySelector('.card-handle'), mini = shell.querySelector('.minibar');
  const hooks = opts.hooks || {};

  // ── sections / pages ────────────────────────────────────────────────────────────────────────────────────────────────
  const pages = {}, mounted = {}, ctrls = {};
  const hamburgers = [];
  for (const s of SECTIONS) {
    const page = shell.querySelector(`section[data-section="${s.id}"]`);
    if (!page) continue;
    page.classList.add('page'); page.id = page.id || `page-${s.id}`; page.setAttribute('aria-label', s.label); page.hidden = true;
    const head = document.createElement('header');
    head.className = 'page-head';
    head.innerHTML = `<button class="hamburger" type="button" aria-label="Menu" aria-expanded="false" aria-controls="drawer">${HAMBURGER}</button><h1 class="page-title"></h1><div class="page-actions"></div>`;
    head.querySelector('.page-title').textContent = s.label;
    if (opts.onSearch) {
      const sb = document.createElement('button');
      sb.type = 'button'; sb.className = 'hamburger page-search'; sb.setAttribute('aria-label', 'Search'); sb.innerHTML = SEARCH;
      sb.addEventListener('click', () => opts.onSearch());
      head.querySelector('.page-actions').append(sb);
    }
    page.prepend(head);
    hamburgers.push(head.querySelector('.hamburger'));
    pages[s.id] = page;
  }
  const list = SECTIONS.filter((s) => pages[s.id]);

  // ── menu ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const items = list.map((s) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'drawer-item'; b.dataset.section = s.id; b.textContent = s.label;
    if (s.icon === 'gear') { const g = document.createElement('span'); g.className = 'drawer-glyph'; g.setAttribute('aria-hidden', 'true'); g.innerHTML = GEAR; b.append(g); }
    b.addEventListener('click', () => go(s.id));
    li.append(b); menu.append(li);
    return b;
  });

  let cur = loadSection(storage(), list);
  let shellH = 0, isOpen = false, x = 0, v = 0, target = 0, raf = 0, lastT = 0, off = 0, lastFocus = null;

  // ── rendering: transforms (and the cheap opacities) only ───────────────────────────────────────────────────────────
  function render() {
    const p = progress(x, off);
    card.style.transform = `translate3d(${x.toFixed(2)}px,0,0) scale(${cardScale(x, off).toFixed(4)})`;
    cover.style.opacity = String(Math.min(1, p * 1.2));
    handle.style.opacity = String(1 - Math.min(1, p * 3));
    drawer.style.opacity = String(0.35 + 0.65 * p);
    drawer.style.transform = `translate3d(${((p - 1) * 28).toFixed(2)}px,0,0)`;
    peek.style.transform = `translate3d(${x.toFixed(2)}px,0,0) scale(${cardScale(x, off).toFixed(4)}) translateY(${(p * (shellH + 14)).toFixed(1)}px)`;
    peek.style.opacity = String(Math.min(1, p * 2));
  }
  function measure() {
    off = openOffset(shell.clientWidth);
    shellH = shell.clientHeight;
    shell.style.setProperty('--shell-h', shellH + 'px');
    shell.style.setProperty('--open-w', off + 'px');
    if (isOpen && !raf && !drag) { x = off; target = off; }
    render();
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - lastT) / 1000 || 0.016);
    lastT = now;
    const s = springStep({ x, v }, target, dt);
    x = s.x; v = s.v;
    if (isSettled(s, target)) { x = target; v = 0; raf = 0; render(); settled(); return; }
    render();
    raf = requestAnimationFrame(frame);
  }
  function animateTo(t, v0 = 0) {
    target = t; v = v0;
    if (reduced()) { cancelAnimationFrame(raf); raf = 0; x = t; v = 0; render(); settled(); return; }
    if (!raf) { lastT = performance.now(); raf = requestAnimationFrame(frame); }
  }
  function settled() {
    if (!isOpen) { drawer.style.visibility = 'hidden'; drawer.inert = true; }   // closed: not painted, not tabbable, not read out
    if (isOpen) { const a = menu.querySelector('.active') || items[0]; if (a && !drag) a.focus({ preventScroll: true }); }
  }

  // ── open / close ────────────────────────────────────────────────────────────────────────────────────────────────────
  function setOpenState(b) {
    if (b === isOpen) return;
    isOpen = b;
    if (b) { drawer.style.visibility = ''; drawer.inert = false; }
    shell.dataset.open = String(b);
    inner.inert = b;
    cover.setAttribute('aria-hidden', String(!b));
    for (const h of hamburgers) { h.setAttribute('aria-expanded', String(b)); }
    if (b) { lastFocus = document.activeElement; }
    else if (lastFocus && (drawer.contains(document.activeElement) || document.activeElement === document.body)) {
      const hb = pages[cur] && pages[cur].querySelector('.hamburger');
      (hb || lastFocus).focus?.({ preventScroll: true }); lastFocus = null;
    }
  }
  function open(v0 = 0) { setOpenState(true); animateTo(off, v0); }
  function close(v0 = 0) { setOpenState(false); animateTo(0, v0); }
  function toggle() { isOpen ? close() : open(); }

  // ── gestures ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const live = new Set();
  window.addEventListener('pointerdown', (e) => live.add(e.pointerId), true);
  for (const t of ['pointerup', 'pointercancel']) window.addEventListener(t, (e) => live.delete(e.pointerId), true);
  const overlayOpen = () => !!document.querySelector(OVERLAYS);
  let drag = null;

  function attach(el, where) {
    el.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      if (!allowsGesture('drawer-drag')) return;   // Device mode: a locked device has a fixed face
      const others = [...live].filter((id) => id !== e.pointerId).length;
      const ok = drawerMayStart({ open: isOpen, where, pageGestureLive: !!(opts.isPageGestureLive && opts.isPageGestureLive()), otherPointers: others, overlayOpen: overlayOpen() });
      if (!ok) return;
      cancelAnimationFrame(raf); raf = 0;
      drag = { id: e.pointerId, el, where, x0: e.clientX, y0: e.clientY, pos0: x, go: false, samples: [{ x, t: e.timeStamp }], t0: e.timeStamp };
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
      if (!drag.go) {
        const c = classifyMove(dx, dy);
        if (c === 'wait') return;
        if (c === 'reject') { release(e, false); animateTo(isOpen ? off : 0); return; }
        drag.go = true; shell.classList.add('dragging');
      }
      x = rubberBand(drag.pos0 + dx, off);
      drag.samples.push({ x, t: e.timeStamp }); if (drag.samples.length > 12) drag.samples.shift();
      render();
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag, cancelled = e.type === 'pointercancel';
      release(e, true);
      if (d.go) {
        const vel = velocityFromSamples(d.samples);
        const t = settleTarget(x, cancelled ? 0 : vel, off);
        t === off ? open(vel) : close(vel);
      } else if (!cancelled) {
        isOpen ? close() : open();     // a tap: on the strip/handle opens, on the covered card closes
      } else animateTo(isOpen ? off : 0);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
  function release(e, _final) {
    try { drag.el.releasePointerCapture(drag.id); } catch { /* already released */ }
    shell.classList.remove('dragging'); drag = null;
  }
  attach(strip, 'strip');
  attach(cover, 'cover');

  // ── keyboard: Esc closes, arrows + Enter in the menu, Tab trapped in the drawer while open ────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (!isOpen) return;
    if (e.key === 'Escape') { if (overlayOpen()) return; e.preventDefault(); close(); return; }
    const fs = [...drawer.querySelectorAll('button:not([disabled])')];
    if (e.key === 'Tab' && fs.length) {
      const i = fs.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); fs[fs.length - 1].focus(); }
      else if (!e.shiftKey && (i === -1 || i === fs.length - 1)) { e.preventDefault(); fs[0].focus(); }
      return;
    }
    const mi = items.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const n = stepMenu(mi < 0 ? items.findIndex((b) => b.classList.contains('active')) : mi, e.key, items.length);
      items[n].focus();
    }
  });
  document.addEventListener('focusin', (e) => {
    if (isOpen && !drawer.contains(e.target) && !overlayOpen()) { (menu.querySelector('.active') || items[0]).focus({ preventScroll: true }); }
  });
  for (const h of hamburgers) h.addEventListener('click', toggle);

  // ── section switching ───────────────────────────────────────────────────────────────────────────────────────────────
  function paintMenu() {
    for (const b of items) {
      const on = b.dataset.section === cur;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
  }
  async function ensureMounted(id) {
    if (mounted[id]) return mounted[id];
    const host = pages[id];
    const h = hooks[id] || {};
    mounted[id] = (async () => {
      let note = null;
      if (h.mount) {
        host.classList.add('loading');
        try { ctrls[id] = (await h.mount(host)) || {}; }
        catch (err) {
          console.error('section mount failed', id, err);
          note = document.createElement('p'); note.className = 'page-error';
          note.textContent = 'This section could not load. '; const r = document.createElement('button');
          r.type = 'button'; r.className = 'sort-chip'; r.textContent = 'Retry';
          r.addEventListener('click', () => { note.remove(); mounted[id] = null; if (cur === id) show(id); });
          note.append(r); host.append(note); ctrls[id] = {}; mounted[id] = null;
        }
        host.classList.remove('loading');
      } else ctrls[id] = {};
    })();
    return mounted[id];
  }
  async function show(id) {
    await ensureMounted(id);
    if (cur !== id) return;
    (ctrls[id].onShow || hooks[id]?.onShow)?.call(ctrls[id]);
  }
  function go(id, o = {}) {
    id = resolveSection(id, list);
    if (id !== cur) {
      const prev = cur; cur = id;
      saveSection(storage(), cur);
      pages[prev].hidden = true; (ctrls[prev]?.onHide || hooks[prev]?.onHide)?.call(ctrls[prev]);
      const pg = pages[cur]; pg.hidden = false;
      if (!reduced()) { pg.classList.remove('enter'); void pg.offsetWidth; pg.classList.add('enter'); setTimeout(() => pg.classList.remove('enter'), PAGE_MS + 40); }
      paintMenu(); show(cur);
      opts.onSection && opts.onSection(cur);
      updateMini();
    }
    if (o.close !== false && isOpen) close();
  }

  // ── now-playing mini bar (every section but the source's own) ──────────────────────────────────────────────────────
  let np = null, npActions = {};
  const miniMain = mini.querySelector('.minibar-main'), miniTitle = mini.querySelector('.minibar-title'), miniSub = mini.querySelector('.minibar-sub'), miniStop = mini.querySelector('.minibar-stop');
  const miniToggle = mini.querySelector('.minibar-toggle'), miniNext = mini.querySelector('.minibar-next');
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M8 6v12M16 6v12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';
  const ICON_PLAY = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  miniMain.addEventListener('click', () => { if (np) go(np.home); });
  miniStop.addEventListener('click', () => npActions.stop && npActions.stop());
  miniToggle.addEventListener('click', () => { if (np && npActions.toggle) npActions.toggle(np.source); });
  miniNext.addEventListener('click', () => { if (np && npActions.next) npActions.next(np.source); });
  /** sources = { radio, mixtape, album } each null | {title, sub, playing?, canNext?}; actions = { stop?(), toggle?(source), next?(source) }. */
  function setNowPlaying(sources, actions = {}) { np = pickNowPlaying(sources); npActions = actions; updateMini(); }
  function updateMini() {
    const vis = miniBarVisible(np, cur);
    mini.hidden = !vis;
    card.dataset.mini = String(vis);
    if (vis) {
      miniTitle.textContent = np.title; miniSub.textContent = np.sub;
      mini.dataset.source = np.source; mini.dataset.playing = String(np.playing);
      miniMain.setAttribute('aria-label', `Now playing ${np.title}. Open ${np.home}`);
      miniStop.hidden = !(np.source === 'radio' && npActions.stop);
      const canToggle = np.source !== 'radio' && !!npActions.toggle;
      miniToggle.hidden = !canToggle;
      if (canToggle) { miniToggle.innerHTML = np.playing ? ICON_PAUSE : ICON_PLAY; miniToggle.setAttribute('aria-label', np.playing ? 'Pause' : 'Play'); }
      miniNext.hidden = !(np.canNext && npActions.next);
    }
  }

  // ── start ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  pages[cur].hidden = false;
  paintMenu();
  cover.setAttribute('aria-hidden', 'true');
  drawer.style.visibility = 'hidden'; drawer.inert = true;
  window.addEventListener('resize', measure);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measure).observe(shell);
  measure();
  show(cur);

  return {
    go, open, close, toggle, setNowPlaying,
    /** Resolves when the section's page is mounted (lazy sections: Radio, Booth). Used by search to start a station. */
    ensure: (id) => ensureMounted(resolveSection(id, list)).then(() => ctrls[id] || {}),
    get current() { return cur; }, get isOpen() { return isOpen; },
    page: (id) => pages[id], el: shell,
  };
}
