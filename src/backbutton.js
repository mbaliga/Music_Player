// backbutton.js — the Android hardware Back button (and the browser's), as ONE ordered "close the topmost thing" registry.
//
//   const back = createBackRegistry();
//   back.register('search', { order: 60, isOpen: () => search.isOpen(), close: () => search.close() });
//   back.closeTopmost()      -> true if a layer closed (or the lock hint was shown), false when nothing is left: the caller minimises
//
// Layers are tried from the highest `order` down; the first one that reports open is closed and the call returns. A layer whose close()
// does not actually close it still counts as handled (Back never falls through to "leave the app" while something is on screen).
//
//   order  layer
//    100   Device mode lock: Back never unlocks. It shows the unlock hint and is swallowed.
//     90   Device mode settings sheet           (.dm-sheet)
//     85   tape menu / mixtape dialogs          (.mt-dialog, includes .mt-menu-ov)
//     80   back-of-the-case card                (.bk-ov)
//     75   cassette editor                      (.ed-ov; its own unsaved-changes prompt answers Escape first)
//     70   custom-theme card                    (#themeOverlay)
//     65   walkthrough                          (.wt-overlay)
//     60   search overlay                       (explicit: search.close)
//     55   turntable settings sheet             (#deckSheet)
//     50   drawer                               (explicit: shell.close)
//     45   mixtape / cassette player            (.tp)
//     40   album library zoom-out               (explicit: closeLibrary)
//     30   any section but Albums               (explicit: shell.go('albums'))
//   else the app minimises (a music player keeps playing; it never exits on Back).
//
// The DOM layers are found by selector, so a new overlay of an existing kind is covered without touching this file, and a page that builds
// its own can add itself with register(). Closing a DOM layer means asking it the way the keyboard does (an Escape keydown on it, which
// every one of these already honours) or pressing its own close button: nothing here removes nodes behind an overlay's back.

const visible = (el) => !!el && el.isConnected !== false && !el.hidden && !(el.classList && el.classList.contains('hidden'));

function escapeOn(doc, el) {
  const view = doc.defaultView || globalThis;
  const Ev = view.KeyboardEvent || globalThis.KeyboardEvent;
  const e = new Ev('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true });
  (el || doc.body || doc).dispatchEvent(e);
}

/** The built-in selector layers for `doc`. */
export function domLayers(doc) {
  const last = (sel, notHidden = false) => {
    const all = [...doc.querySelectorAll(sel)].filter((e) => !notHidden || visible(e));
    return all.length ? all[all.length - 1] : null;
  };
  const byEscape = (id, order, sel, extraClose) => ({
    id, order, isOpen: () => !!last(sel, true),
    close: () => { const el = last(sel, true); if (!el) return; escapeOn(doc, el); if (extraClose && last(sel, true)) extraClose(last(sel, true)); },
  });
  const click = (el, sel) => { const b = el && el.querySelector(sel); if (b && b.click) { b.click(); return true; } return false; };
  return [
    byEscape('device-sheet', 90, '.dm-sheet', (el) => click(el, '.dm-done')),
    byEscape('mixtape-dialog', 85, '.mt-dialog'),
    byEscape('case-back', 80, '.bk-ov', (el) => click(el, '.chip.ghost')),
    byEscape('cassette-editor', 75, '.ed-ov'),
    {
      id: 'theme-card', order: 70, isOpen: () => visible(doc.getElementById('themeOverlay')),
      close: () => {
        const ov = doc.getElementById('themeOverlay');
        if (!ov) return;
        const preview = doc.getElementById('themeStepPreview');
        const x = doc.getElementById(preview && visible(preview) ? 'themeX2' : 'themeX1');   // preview step: back to editing; edit step: close
        if (x && x.click) x.click(); else ov.classList.add('hidden');
      },
    },
    {
      id: 'walkthrough', order: 65, isOpen: () => !!last('.wt-overlay', true),
      close: () => { const el = last('.wt-overlay', true); if (!el) return; if (!click(el, '.wt-x')) el.classList.add('hidden'); },
    },
    {
      id: 'deck-sheet', order: 55, isOpen: () => visible(doc.getElementById('deckSheet')),
      close: () => { const el = doc.getElementById('deckSheet'); if (!click(el, '.tt-sheet-close')) { if (el) el.hidden = true; } },
    },
    {
      id: 'mixtape-player', order: 45, isOpen: () => !!last('.tp', true),
      close: () => { const el = last('.tp', true); click(el, '.tp-back'); },
    },
  ];
}

export function createBackRegistry() {
  const layers = [];
  return {
    register(id, layer) {
      const l = { id, order: 50, ...layer };
      const i = layers.findIndex((x) => x.id === id);
      if (i >= 0) layers.splice(i, 1);
      layers.push(l);
      return () => { const j = layers.indexOf(l); if (j >= 0) layers.splice(j, 1); };
    },
    layers: () => layers.slice().sort((a, b) => b.order - a.order).map((l) => l.id),
    /** Close the topmost open layer. Returns the id of the layer handled, or null when there was nothing to close. */
    closeTopmost() {
      const sorted = layers.slice().sort((a, b) => b.order - a.order);
      for (const l of sorted) {
        let open = false;
        try { open = !!l.isOpen(); } catch { open = false; }
        if (!open) continue;
        try { l.close(); } catch (e) { try { console.error('back: closing', l.id, 'failed', e); } catch { /* */ } }
        return l.id;
      }
      return null;
    },
  };
}

/**
 * Wire the registry to the page and to the platform.
 *   deps = { deviceMode, getSearch, getShell, library: { isOpen, close }, doc, win, registry, minimize }
 * Everything is a getter / optional: the shell and search are created after this module's caller starts booting.
 * Returns { registry, back() }  (back() = handle one Back press; true when the app handled it, false when it should minimise).
 */
export function installBackButton(deps = {}) {
  const doc = deps.doc || document, win = deps.win || window;
  const registry = deps.registry || createBackRegistry();
  const dm = () => deps.deviceMode || win.runoutDeviceMode;
  const search = () => (deps.getSearch ? deps.getSearch() : null);
  const shell = () => (deps.getShell ? deps.getShell() : null);

  registry.register('lock', {
    order: 100,
    isOpen: () => { const d = dm(); return !!(d && d.state && d.state.locked); },
    close: () => { const d = dm(); try { d.showHint && d.showHint('The screen is locked. Use the lock key to unlock.', 3000); } catch { /* */ } },   // never unlocks
  });
  for (const l of domLayers(doc)) registry.register(l.id, l);
  registry.register('search', { order: 60, isOpen: () => !!(search() && search().isOpen()), close: () => search().close() });
  registry.register('drawer', { order: 50, isOpen: () => !!(shell() && shell().isOpen), close: () => shell().close() });
  if (deps.library) registry.register('library', { order: 40, isOpen: () => !!deps.library.isOpen(), close: () => deps.library.close() });
  registry.register('section', {
    order: 30,
    isOpen: () => { const s = shell(); return !!(s && s.current && s.current !== 'albums'); },
    close: () => shell().go('albums', { close: true }),
  });

  const back = () => registry.closeTopmost() !== null;
  const minimize = deps.minimize || (() => {
    const app = nativeApp(win);
    if (app && typeof app.minimizeApp === 'function') return app.minimizeApp();
    return undefined;
  });
  // One entry point for both routes: the @capacitor/app listener below and MainActivity's OnBackPressedCallback fallback
  // (RunoutHost.java calls window.__runoutBack() and minimises the task itself when this returns false).
  win.__runoutBack = back;

  const app = nativeApp(win);
  if (app && typeof app.addListener === 'function') {
    try {
      const p = app.addListener('backButton', () => { if (!back()) Promise.resolve(minimize()).catch(() => {}); });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* the Java fallback still routes Back */ }
  }
  return { registry, back, minimize };
}

/** The @capacitor/app plugin proxy when running in the native shell, else null. */
export function nativeApp(win = typeof window !== 'undefined' ? window : null) {
  try {
    const cap = win && win.Capacitor;
    if (!cap) return null;
    if (typeof cap.isNativePlatform === 'function' && !cap.isNativePlatform()) return null;
    if (typeof cap.isPluginAvailable === 'function' && !cap.isPluginAvailable('App')) return null;
    if (typeof cap.registerPlugin === 'function') {
      if (!nativeApp._p) nativeApp._p = new WeakMap();
      if (!nativeApp._p.has(cap)) nativeApp._p.set(cap, cap.registerPlugin('App'));
      return nativeApp._p.get(cap);
    }
    return (cap.Plugins && cap.Plugins.App) || null;
  } catch { return null; }
}
