// ─────────────────────────────────────────────────────────────────────────────
// library.js — the turntable's zoom-out LIBRARY: a coverflow of album covers, the
// album title / meta, the track list below, and a slim toolbar (scan, filter,
// sort). Ported from the prototype's #lib / #flow / .cv / #slot / #meta / #tracks.
// Contract and numbers: docs/TURNTABLE_LIBRARY.md.
//
//   const lib = mountTurntableLibrary(container, deps)
//   lib.setAlbums(albums) · setNowPlaying({albumId, trackIndex}) · focus(i, {animate})
//   lib.getFocus() · setOpacity(o) · show() · hide() · getSlotRect() · layout({width,height,portrait})
//   lib.on('focus' | 'selectTrack' | 'tapCover' | 'scan' | 'filter' | 'sort', fn) -> off()
//   lib.destroy()
//
// Library text (titles, artists) is untrusted: everything reaches the DOM through
// textContent / setAttribute, never innerHTML.
// ─────────────────────────────────────────────────────────────────────────────
import {
  libraryLayout, coverPose, visibleRange, POOL_SIZE, LIB_KNOBS, dragFocus, flingTarget, easeStep, wheelStep, keyStep,
  formatDuration, totalDuration, clipText, pad2, builtinTestPressing, isBuiltinAlbum, clampIndex,
} from './library-layout.js';
import { allowsGesture as guardAllows } from '../devicemode/guard.js';   // device mode: frozen gestures while locked (docs/DEVICE_MODE.md)
import { createCoverCache, coverPixelSize, revokeCoverUrl, isTrackedCoverUrl } from './covers.js';

export {
  albumsToCoverflow, builtinTestPressing, libraryLayout, isBuiltinAlbum, TEST_PRESSING_ID, LIB_KNOBS,
} from './library-layout.js';
export { coverBlobUrl, revokeCoverUrl, revokeAllCoverUrls, downscaleCoverUrl, hashSeed } from './covers.js';

export const FILTERS = Object.freeze(['all', 'vinyl', 'cd']);
export const SORTS = Object.freeze(['artist', 'album', 'genre', 'colour']);
const FILTER_LABEL = { all: 'All', vinyl: 'Vinyl', cd: 'CD' };
const SORT_LABEL = { artist: 'Artist', album: 'Album', genre: 'Genre', colour: 'Colour' };
const EVENTS = ['focus', 'selectTrack', 'tapCover', 'scan', 'filter', 'sort'];

let uid = 0;

export function mountTurntableLibrary(container, deps = {}) {
  const doc = deps.document || container.ownerDocument || document;
  const win = deps.window || doc.defaultView || globalThis;
  const raf = deps.raf || ((f) => win.requestAnimationFrame(f));
  const caf = deps.caf || ((h) => win.cancelAnimationFrame(h));
  const now = deps.now || (() => (win.performance ? win.performance.now() : Date.now()));
  const id = ++uid;
  const K = LIB_KNOBS;

  if (deps.injectCss !== false) ensureStylesheet(doc, deps.cssUrl);

  // ── DOM ────────────────────────────────────────────────────────────────────
  const el = (tag, cls, parent) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e; };
  const root = el('div', 'tl-lib');
  root.setAttribute('role', 'region'); root.setAttribute('aria-label', 'Album library');
  root.style.opacity = '0'; root.style.pointerEvents = 'none';

  const scroll = el('div', 'tl-scroll', root);
  const bar = el('div', 'tl-bar', scroll);
  bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Library controls');
  const row1 = el('div', 'tl-row tl-row1', bar), row2 = el('div', 'tl-row tl-row2', bar);
  const scanBtn = chip(row1, 'tl-scan', null);
  const scanLong = el('span', 'tl-long', scanBtn.pill); scanLong.textContent = (deps.scanLabel && deps.scanLabel.long) || 'Scan music folder';
  const scanShort = el('span', 'tl-short', scanBtn.pill); scanShort.textContent = (deps.scanLabel && deps.scanLabel.short) || 'Scan';
  const filterGrp = el('div', 'tl-grp', row1); filterGrp.setAttribute('role', 'group'); filterGrp.setAttribute('aria-label', 'Show');
  const sortGrp = el('div', 'tl-grp', row2); sortGrp.setAttribute('role', 'group'); sortGrp.setAttribute('aria-label', 'Sort by');
  const sortLbl = el('span', 'tl-lbl', sortGrp); sortLbl.textContent = 'Sort'; sortLbl.setAttribute('aria-hidden', 'true');
  const filterBtns = {}, sortBtns = {};
  for (const f of FILTERS) { const b = chip(filterGrp, 'tl-f', FILTER_LABEL[f]); b.btn.__tl = { kind: 'filter', v: f }; filterBtns[f] = b; }
  for (const s of SORTS) { const b = chip(sortGrp, 'tl-s', SORT_LABEL[s]); b.btn.__tl = { kind: 'sort', v: s }; sortBtns[s] = b; }
  scanBtn.btn.__tl = { kind: 'scan' };

  const flow = el('div', 'tl-flow', scroll);
  flow.setAttribute('data-lock-surface', '');
  flow.setAttribute('role', 'listbox'); flow.setAttribute('aria-label', 'Albums'); flow.setAttribute('tabindex', '0');
  const slot = el('div', 'tl-slot', flow); slot.setAttribute('aria-hidden', 'true');
  const hint = el('button', 'tl-hint', scroll); hint.setAttribute('type', 'button');
  hint.textContent = (deps.scanLabel && deps.scanLabel.hint) || 'Scan your music folder to play your own music'; hint.__tl = { kind: 'scan' };
  const meta = el('div', 'tl-meta', scroll);
  const titleEl = el('div', 'tl-title', meta), subEl = el('div', 'tl-sub', meta);
  const list = el('ol', 'tl-tracks', scroll);
  list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Tracks'); list.setAttribute('data-lock-surface', '');
  const foot = el('div', 'tl-foot', scroll);                         // "50 songs · last scan 3 min ago" (setScanInfo)
  const pick = el('div', 'tl-pick', root); pick.setAttribute('role', 'status'); pick.hidden = true;   // first-run nudge (setPickHint)

  // covers: a fixed pool of nodes, node for album k = pool[k % POOL_SIZE]
  const pool = [];
  for (let p = 0; p < POOL_SIZE; p++) {
    const n = el('div', 'tl-cv', flow);
    n.setAttribute('role', 'option'); n.setAttribute('id', `tl-cv-${id}-${p}`);
    n.style.visibility = 'hidden';
    const sp = el('i', 'tl-sp', n), gl = el('i', 'tl-gl', n), bd = el('span', 'tl-bd', n), sh = el('i', 'tl-sh', n);
    sp.setAttribute('aria-hidden', 'true'); gl.setAttribute('aria-hidden', 'true'); bd.setAttribute('aria-hidden', 'true'); sh.setAttribute('aria-hidden', 'true');
    const nd = { el: n, bd, sh, canvas: null, idx: -1, lt: '', lz: -1, ls: -1, lv: false, lcd: null, cur: undefined, p };
    n.__tl = { kind: 'cv', nd };
    pool.push(nd);
  }
  container.appendChild(root);

  // ── state ──────────────────────────────────────────────────────────────────
  let albums = [], n = 0;
  let focusPos = 0, target = 0, settledIdx = 0, shownIdx = -1;
  let L = libraryLayout({ width: 360, height: 640 }), laidOut = false, cs = L.cs, pxSize = 256;
  let opacity = 0, shown = true, live = false, destroyed = false;
  let nowPlaying = null, filterState = 'all', sortState = 'artist';
  let rafH = 0, lastT = 0, drag = null, wheelTimer = 0, ro = null, mql = null;
  const pose = { x: 0, rot: 0, scale: 1, z: 0, shade: 0, opacity: 1 };
  const handlers = Object.create(null);
  for (const e of EVENTS) handlers[e] = [];
  const rows = [];

  const cache = createCoverCache({
    makeCanvas: () => doc.createElement('canvas'),
    loadImage: deps.loadImage,
    onChange: () => {},
  });

  function emit(ev, ...args) {
    const hs = handlers[ev]; if (!hs || !hs.length) return;
    for (const h of hs.slice()) { try { h(...args); } catch (err) { (win.console || console).error(err); } }
  }
  const reduced = () => !!(mql && mql.matches);
  try { mql = (deps.matchMedia || win.matchMedia || null) && (deps.matchMedia || win.matchMedia.bind(win))('(prefers-reduced-motion: reduce)'); } catch { mql = null; }

  // ── toolbar ────────────────────────────────────────────────────────────────
  function chip(parent, cls, label) {
    const btn = el('button', 'tl-chip ' + cls, parent); btn.setAttribute('type', 'button');
    const pill = el('span', 'tl-pill', btn);
    if (label) pill.textContent = label;
    return { btn, pill };
  }
  function paintChips() {
    for (const f of FILTERS) filterBtns[f].btn.setAttribute('aria-pressed', String(f === filterState));
    for (const s of SORTS) sortBtns[s].btn.setAttribute('aria-pressed', String(s === sortState));
  }
  paintChips();
  function onBarClick(e) {
    if (!may('library-chip')) return;
    const o = ownerOf(e.target, root);
    if (!o || !o.__tl) return;
    const t = o.__tl;
    if (t.kind === 'scan') emit('scan');
    else if (t.kind === 'filter') { filterState = t.v; paintChips(); emit('filter', t.v); }
    else if (t.kind === 'sort') { sortState = t.v; paintChips(); emit('sort', t.v); }
  }
  bar.addEventListener('click', onBarClick);
  hint.addEventListener('click', () => { if (may('library-chip')) emit('scan'); });

  // ── album display (title / meta / tracks) ──────────────────────────────────
  function rowAt(i) {
    let r = rows[i];
    if (r) return r;
    const li = el('li', 'tl-trk'); li.setAttribute('role', 'option'); li.setAttribute('tabindex', '-1');
    const num = el('span', 'n', li), t = el('span', 't', li), d = el('span', 'd', li);
    num.setAttribute('aria-hidden', 'true');
    li.__tl = { kind: 'row', i };
    r = { li, num, t, d, on: false };
    rows[i] = r; return r;
  }
  function renderAlbum(k) {
    shownIdx = k;
    const a = albums[k];
    if (!a) { titleEl.textContent = ''; subEl.textContent = ''; setRowCount(0); return; }
    titleEl.textContent = clipText(a.title);
    const tot = totalDuration(a.tracks), nt = a.tracks.length;
    const parts = [clipText(a.artist)];
    if (a.meta) parts.push(clipText(a.meta));
    parts.push(nt + (nt === 1 ? ' track' : ' tracks'));
    if (tot != null) parts.push(formatDuration(tot));
    subEl.textContent = parts.join(' · ');
    const count = Math.min(nt, K.maxTrackRows);
    for (let i = 0; i < count; i++) {
      const r = rowAt(i), t = a.tracks[i];
      r.num.textContent = pad2(i + 1);
      r.t.textContent = clipText(t.title);
      r.d.textContent = formatDuration(t.durationSec);
      r.li.setAttribute('aria-label', `${i + 1}. ${clipText(t.title, 80)}${t.unsupported ? ' (unsupported format)' : ''}`);
      r.unsup = !!t.unsupported; if (r.unsup) r.d.textContent = 'unsupported'; r.li.className = (r.on ? 'tl-trk on' : 'tl-trk') + (r.unsup ? ' unsup' : '');
    }
    setRowCount(count);
    markPlaying(true);
  }
  function setRowCount(count) {
    while (list.children.length > count) list.removeChild(list.lastChild);
    for (let i = list.children.length; i < count; i++) list.appendChild(rows[i].li);
    for (let i = 0; i < count; i++) rows[i].li.setAttribute('tabindex', i === 0 ? '0' : '-1');
  }
  function markPlaying(force) {
    const a = albums[shownIdx];
    const idx = a && nowPlaying && nowPlaying.albumId === a.id && Number.isInteger(nowPlaying.trackIndex) ? nowPlaying.trackIndex : -1;
    for (let i = 0; i < list.children.length; i++) {
      const r = rows[i], on = i === idx;
      if (force || r.on !== on) { r.on = on; r.li.className = (on ? 'tl-trk on' : 'tl-trk') + (r.unsup ? ' unsup' : ''); r.li.setAttribute('aria-selected', String(on)); }
    }
  }
  function syncDisplay() { const k = clampIndex(Math.round(focusPos), n); if (k !== shownIdx) renderAlbum(k); }

  // ── coverflow ──────────────────────────────────────────────────────────────
  function bind(nd, k) {
    const a = albums[k];
    nd.idx = k; nd.lt = ''; nd.lz = -1; nd.ls = -1; nd.cur = undefined;
    const cv = cache.get(a, pxSize);
    if (cv && nd.canvas !== cv) {
      if (nd.canvas && nd.canvas.parentNode === nd.el) nd.el.removeChild(nd.canvas);
      nd.el.insertBefore(cv, nd.el.firstChild); nd.canvas = cv;
    }
    if (nd.lcd !== (a.kind === 'cd')) { nd.lcd = a.kind === 'cd'; nd.el.className = nd.lcd ? 'tl-cv cd' : 'tl-cv lp'; }
    nd.bd.textContent = a.kind === 'cd' ? 'CD' : 'LP';
    nd.el.setAttribute('aria-label', `${clipText(a.title, 80)} — ${clipText(a.artist, 60)}, ${a.kind === 'cd' ? 'CD' : 'vinyl'}`);
    nd.el.setAttribute('aria-posinset', String(k + 1)); nd.el.setAttribute('aria-setsize', String(n));
  }
  function updateFlow() {
    const r = visibleRange(focusPos, n, K.coverWindow), cur = clampIndex(Math.round(focusPos), n);
    for (let p = 0; p < POOL_SIZE; p++) {
      const nd = pool[p];
      const k = r.lo + ((p - (r.lo % POOL_SIZE) + POOL_SIZE) % POOL_SIZE);
      if (k > r.hi || k < 0 || k >= n) { if (nd.lv) { nd.el.style.visibility = 'hidden'; nd.lv = false; nd.idx = -1; } continue; }
      if (nd.idx !== k) bind(nd, k);
      coverPose(k - focusPos, cs, pose);
      if (!pose.opacity) { if (nd.lv) { nd.el.style.visibility = 'hidden'; nd.lv = false; } continue; }
      if (!nd.lv) { nd.el.style.visibility = 'visible'; nd.lv = true; }
      const tr = 'translateX(' + pose.x.toFixed(1) + 'px) perspective(' + K.perspectivePx + 'px) rotateY(' + pose.rot.toFixed(1) + 'deg) scale(' + pose.scale.toFixed(3) + ')';
      if (tr !== nd.lt) { nd.lt = tr; nd.el.style.transform = tr; }
      if (pose.z !== nd.lz) { nd.lz = pose.z; nd.el.style.zIndex = String(pose.z); }
      const sh = pose.shade.toFixed(2);
      if (sh !== nd.ls) { nd.ls = sh; nd.sh.style.opacity = sh; }
      const isCur = k === cur;
      if (nd.cur !== isCur) { nd.cur = isCur; nd.el.setAttribute('aria-selected', String(isCur)); if (isCur) flow.setAttribute('aria-activedescendant', nd.el.id); }
    }
  }

  // ── motion loop (runs only while something moves) ──────────────────────────
  function kick() { if (!rafH && shown && !destroyed) { lastT = now(); rafH = raf(tick); } }
  function tick(t) {
    rafH = 0;
    if (destroyed || !shown) return;
    const dt = Math.min(0.05, Math.max(0, ((typeof t === 'number' ? t : now()) - lastT) / 1000)); lastT = typeof t === 'number' ? t : now();
    if (drag) {
      if (drag.moved && drag.pending != null) { focusPos = drag.pending; target = focusPos; drag.pending = null; updateFlow(); syncDisplay(); }
      kickIfNeeded(); return;
    }
    if (focusPos !== target) {
      focusPos = reduced() ? target : easeStep(focusPos, target, dt);
      updateFlow(); syncDisplay();
    }
    if (focusPos === target) { settle(); return; }
    kick();
  }
  function kickIfNeeded() { if (drag || focusPos !== target) kick(); }
  function settle() {
    if (target !== Math.round(target)) return;           // a wheel gesture still in flight
    const k = clampIndex(target, n);
    if (k !== settledIdx) { settledIdx = k; emit('focus', k, albums[k] ? albums[k].id : undefined); }
  }

  // ── pointer: swipe / tap ───────────────────────────────────────────────────
  const live_ = () => live && shown && !destroyed;
  const may = (kind) => (deps.allowsGesture || guardAllows)(kind);   // false while the device is locked
  function onDown(e) {
    if (!live_() || n === 0 || !may('coverflow-swipe')) return;
    if (e.pointerType === 'mouse' && e.button > 0) return;
    if (drag) { cancelDrag(); return; }                  // a second finger: not ours (T1's pinch)
    const o = ownerOf(e.target, flow);
    const ts = e.timeStamp || now();
    drag = { id: e.pointerId, x: e.clientX, lx: e.clientX, lt: ts, f: focusPos, moved: false, v: 0, node: o && o.__tl && o.__tl.kind === 'cv' ? o.__tl.nd : null, nodeIdx: -1, pending: null };
    if (drag.node) drag.nodeIdx = drag.node.idx;
    if (wheelTimer) { win.clearTimeout(wheelTimer); wheelTimer = 0; target = Math.round(target); }
    try { flow.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) > K.dragSlopPx) drag.moved = true;
    if (!drag.moved) return;
    const ts = e.timeStamp || now(), dtm = ts - drag.lt;
    if (dtm > 0) { const inst = -(e.clientX - drag.lx) / (cs * K.stepRatio) / (dtm / 1000); drag.v = drag.v * 0.6 + inst * 0.4; }
    drag.lx = e.clientX; drag.lt = ts;
    drag.pending = dragFocus(drag.f, dx, cs, n);
    kick();
  }
  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    try { flow.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (d.moved) {
      const stale = (e.timeStamp || now()) - d.lt > 90;
      if (d.pending != null) { focusPos = d.pending; updateFlow(); syncDisplay(); }
      target = flingTarget(focusPos, stale ? 0 : d.v, n);
      if (reduced()) { focusPos = target; updateFlow(); syncDisplay(); }
      kick(); return;
    }
    if (d.node && d.node.idx === d.nodeIdx && d.nodeIdx >= 0 && d.nodeIdx < n) {
      if (d.nodeIdx === clampIndex(Math.round(focusPos), n)) emit('tapCover', albums[d.nodeIdx].id);
      else { target = d.nodeIdx; kick(); }
    }
  }
  function cancelDrag() {
    if (!drag) return;
    const d = drag; drag = null;
    try { flow.releasePointerCapture(d.id); } catch { /* ignore */ }
    if (d.moved) { if (d.pending != null) { focusPos = d.pending; } target = Math.round(focusPos); }
    kick();
  }
  flow.addEventListener('pointerdown', onDown);
  flow.addEventListener('pointermove', onMove);
  flow.addEventListener('pointerup', onUp);
  flow.addEventListener('pointercancel', cancelDrag);
  flow.addEventListener('lostpointercapture', (e) => { if (drag && e.pointerId === drag.id && !drag.moved) cancelDrag(); });

  function onWheel(e) {
    if (!live_() || e.ctrlKey || n === 0 || !may('coverflow-swipe')) return;
    const unit = e.deltaMode === 1 ? 16 : 1;
    let d = (e.deltaX || 0) * unit;
    if (!d && e.shiftKey) d = (e.deltaY || 0) * unit;
    if (!d || (Math.abs(e.deltaX || 0) < Math.abs(e.deltaY || 0) && !e.shiftKey)) return;   // vertical wheel scrolls the list
    if (e.preventDefault) e.preventDefault();
    target = Math.max(0, Math.min(n - 1, target + wheelStep(d, cs)));
    if (wheelTimer) win.clearTimeout(wheelTimer);
    wheelTimer = win.setTimeout(() => { wheelTimer = 0; target = clampIndex(Math.round(target), n); kick(); }, K.wheelIdleMs);
    kick();
  }
  scroll.addEventListener('wheel', onWheel, { passive: false });

  // ── keyboard ───────────────────────────────────────────────────────────────
  flow.addEventListener('keydown', (e) => {
    if (!live_() || n === 0 || !may('coverflow-swipe')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); const k = clampIndex(Math.round(focusPos), n);
      emit('tapCover', albums[k].id); return;
    }
    const t = keyStep(wheelTimer ? Math.round(target) : target, e.key, n);
    if (t == null) return;
    e.preventDefault();
    if (wheelTimer) { win.clearTimeout(wheelTimer); wheelTimer = 0; }
    target = t; kick();
  });
  function onRowActivate(i) {
    const a = albums[shownIdx];
    if (a && i >= 0 && i < a.tracks.length) emit('selectTrack', a.id, i);
  }
  list.addEventListener('click', (e) => {
    if (!live_() || !may('track-row')) return;
    const o = ownerOf(e.target, list);
    if (o && o.__tl && o.__tl.kind === 'row') onRowActivate(o.__tl.i);
  });
  list.addEventListener('keydown', (e) => {
    if (!may('track-row')) return;
    const o = ownerOf(e.target, list);
    if (!o || !o.__tl || o.__tl.kind !== 'row') return;
    const i = o.__tl.i;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowActivate(i); return; }
    const j = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? list.children.length - 1 : -1;
    if (j < 0 || j >= list.children.length) return;
    e.preventDefault();
    rows[i].li.setAttribute('tabindex', '-1'); rows[j].li.setAttribute('tabindex', '0');
    if (rows[j].li.focus) rows[j].li.focus();
    if (rows[j].li.scrollIntoView) rows[j].li.scrollIntoView({ block: 'nearest' });
  });

  const isEmptyState = () => albums.length > 0 && albums.every(isBuiltinAlbum);

  // ── layout ─────────────────────────────────────────────────────────────────
  function applyLayout(next) {
    L = next; cs = L.cs;
    const s = root.style;
    s.setProperty('--cs', L.cs + 'px'); s.setProperty('--ct', L.ct + 'px'); s.setProperty('--fh', L.fh + 'px');
    s.setProperty('--mh', L.mh + 'px'); s.setProperty('--f1', L.f1 + 'px'); s.setProperty('--f2', L.f2 + 'px');
    s.setProperty('--pad', L.pad + 'px'); s.setProperty('--rh', L.rh + 'px'); s.setProperty('--tbh', L.tbH + 'px');
    root.className = 'tl-lib' + (L.tbRows === 2 ? ' tl-two' : '') + (L.portrait ? ' tl-portrait' : ' tl-landscape') + (L.tight ? ' tl-tight' : '') + (isEmptyState() ? ' tl-empty' : '');
    const dpr = deps.dpr || win.devicePixelRatio || 1;
    const px = coverPixelSize(cs, dpr);
    if (px !== pxSize) { pxSize = px; }
    for (const nd of pool) nd.idx = -1;                  // rebind (repaint at the new pixel size when it changed)
    updateFlow();
  }
  function measure() {
    const r = container.getBoundingClientRect ? container.getBoundingClientRect() : null;
    const w = (r && r.width) || container.clientWidth || 360, h = (r && r.height) || container.clientHeight || 640;
    return { width: w, height: h };
  }
  applyLayout(libraryLayout(measure()));
  if (typeof win.ResizeObserver === 'function' || typeof ResizeObserver === 'function') {
    try { ro = new (win.ResizeObserver || ResizeObserver)(() => { if (!laidOut && !destroyed) applyLayout(libraryLayout(measure())); }); ro.observe(container); } catch { ro = null; }
  }

  // ── inert / opacity / visibility ───────────────────────────────────────────
  function updateLive() {
    const want = shown && opacity >= 0.5;
    root.style.visibility = shown && opacity > 0.001 ? 'visible' : 'hidden';
    if (want === live) return;
    live = want;
    root.style.pointerEvents = live ? 'auto' : 'none';
    if (live) { root.removeAttribute('inert'); root.removeAttribute('aria-hidden'); }
    else { root.setAttribute('inert', ''); root.setAttribute('aria-hidden', 'true'); if (drag) cancelDrag(); }
  }

  // ── public API ─────────────────────────────────────────────────────────────
  function setAlbums(next) {
    if (destroyed) return;
    const prevId = albums[clampIndex(Math.round(focusPos), n)] && albums[clampIndex(Math.round(focusPos), n)].id;
    let list2 = Array.isArray(next)
      ? next.filter((a) => a && typeof a === 'object' && a.id != null).map((a) => ({ ...a, title: String(a.title ?? 'Untitled'), artist: String(a.artist ?? ''), kind: a.kind === 'cd' ? 'cd' : 'vinyl', tracks: Array.isArray(a.tracks) ? a.tracks : [] }))
      : [];
    if (!list2.length) list2 = [(deps.testPressing ? deps.testPressing() : builtinTestPressing())];
    // artwork object URLs this module minted and nobody uses any more
    const keep = new Set(); for (const a of list2) if (a.coverUrl) keep.add(a.coverUrl);
    for (const a of albums) if (a.coverUrl && !keep.has(a.coverUrl) && isTrackedCoverUrl(a.coverUrl)) revokeCoverUrl(a.coverUrl);
    albums = list2; n = albums.length;
    cache.clear();
    let k = prevId != null ? albums.findIndex((a) => a.id === prevId) : -1;
    if (k < 0) k = clampIndex(Math.round(focusPos), n);
    focusPos = target = settledIdx = k;
    root.className = root.className.replace(' tl-empty', '') + (isEmptyState() ? ' tl-empty' : '');
    for (const nd of pool) nd.idx = -1;
    shownIdx = -1; updateFlow(); syncDisplay();
    if (drag) { drag = null; }
  }
  function setNowPlaying(np) {
    nowPlaying = np && np.albumId != null ? { albumId: np.albumId, trackIndex: np.trackIndex } : null;
    markPlaying(false);
  }
  function focusApi(index, opts) {
    if (destroyed) return;
    const k = clampIndex(Math.round(+index || 0), n);
    if (drag) cancelDrag();
    if (wheelTimer) { win.clearTimeout(wheelTimer); wheelTimer = 0; }
    settledIdx = k;                                       // programmatic: no 'focus' event
    if (opts && opts.animate === false || reduced()) { focusPos = target = k; updateFlow(); syncDisplay(); }
    else { target = k; kick(); }
  }
  function setOpacity(o) {
    const v = Math.max(0, Math.min(1, +o || 0));
    if (v === opacity) return;
    if (opacity <= 0.001 && v > 0.001) scroll.scrollTop = 0;       // coming back in: the cover is where the disc expects it
    opacity = v;
    root.style.opacity = String(Math.round(v * 1000) / 1000);
    updateLive();
  }
  function show() { if (destroyed) return; shown = true; scroll.scrollTop = 0; updateLive(); updateFlow(); kickIfNeeded(); }
  function hide() { if (destroyed) return; shown = false; if (drag) cancelDrag(); updateLive(); if (rafH) { caf(rafH); rafH = 0; } }
  function layoutApi(size) { if (destroyed) return; laidOut = true; applyLayout(libraryLayout(size)); syncDisplay(); }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (rafH) { caf(rafH); rafH = 0; }
    if (wheelTimer) { win.clearTimeout(wheelTimer); wheelTimer = 0; }
    if (ro) { try { ro.disconnect(); } catch { /* ignore */ } ro = null; }
    for (const a of albums) if (a.coverUrl && isTrackedCoverUrl(a.coverUrl)) revokeCoverUrl(a.coverUrl);
    cache.destroy();
    if (root.parentNode) root.parentNode.removeChild(root);
    for (const e of EVENTS) handlers[e].length = 0;
    albums = []; n = 0; drag = null;
  }

  setAlbums([]);                                          // starts on the built-in test pressing
  updateLive();

  return {
    setAlbums, setNowPlaying, focus: focusApi, setOpacity, show, hide, layout: layoutApi, destroy,
    getFocus: () => clampIndex(Math.round(focusPos), n),
    getSlotRect: () => slot.getBoundingClientRect(),
    on(event, fn) {
      if (!handlers[event] || typeof fn !== 'function') return () => {};
      handlers[event].push(fn);
      return () => { const i = handlers[event].indexOf(fn); if (i >= 0) handlers[event].splice(i, 1); };
    },
    // additive (not in the T1 contract): keep the toolbar chips in step with the app's own filter / sort state; the root element
    /** platform wording of the Scan chip (native Android: 'Scan phone'); the web keeps the folder picker wording */
    setScanLabel(o = {}) { if (o.long) scanLong.textContent = o.long; if (o.short) scanShort.textContent = o.short; if (o.hint) hint.textContent = o.hint; if (o.aria) scanBtn.btn.setAttribute('aria-label', o.aria); },
    /** one line under the track list ('50 songs · last scan 3 min ago'); also the Scan chip's tooltip. '' clears it. */
    setScanInfo(text) { foot.textContent = text || ''; foot.hidden = !text; if (text) scanBtn.btn.title = text; else scanBtn.btn.removeAttribute('title'); },
    /** a short nudge pinned to the bottom of the library ('Pick an album'); null / '' hides it */
    setPickHint(text) { pick.textContent = text || ''; pick.hidden = !text; },
    setFilter(f) { if (FILTERS.includes(f)) { filterState = f; paintChips(); } },
    setSort(s) { if (SORTS.includes(s)) { sortState = s; paintChips(); } },
    get el() { return root; },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
/** The nearest ancestor-or-self of `e` that carries a `__tl` tag, stopping at `stop`. */
function ownerOf(e, stop) {
  while (e && e !== stop) { if (e.__tl) return e; e = e.parentNode; }
  return null;
}

let cssDone = false;
function ensureStylesheet(doc, cssUrl) {
  if (cssDone || !doc.head || !doc.createElement) return;
  cssDone = true;
  try {
    const href = cssUrl || new URL('./library.css', import.meta.url).href;
    if (doc.querySelector && doc.querySelector('link[data-turntable-library]')) return;
    const l = doc.createElement('link'); l.rel = 'stylesheet'; l.href = href; l.setAttribute('data-turntable-library', '');
    doc.head.appendChild(l);
  } catch { /* the host page links library.css itself */ }
}
