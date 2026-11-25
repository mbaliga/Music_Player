import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackRegistry, installBackButton, domLayers, nativeApp } from '../src/backbutton.js';

// A tiny DOM: elements with classes, hidden, children by selector, click() and an Escape sink.
function fakeDom() {
  const els = [];
  const mk = (cls, { id = '', hidden = false, onEscape = null, kids = {} } = {}) => {
    const e = {
      id, hidden, isConnected: true, classes: new Set(cls.split(' ').filter(Boolean)), esc: 0, clicks: 0,
      classList: { contains: (c) => e.classes.has(c), add: (c) => e.classes.add(c), remove: (c) => e.classes.delete(c) },
      dispatchEvent(ev) { if (ev.key === 'Escape') { e.esc++; onEscape && onEscape(e); } return true; },
      querySelector: (sel) => kids[sel] || null, click() { e.clicks++; if (e.onClick) e.onClick(); },
    };
    els.push(e); return e;
  };
  const match = (e, sel) => sel.split(',').map((x) => x.trim()).some((one) => {
    const m = /^\.([\w-]+)(?::not\(\.hidden\))?$/.exec(one); return m && e.classes.has(m[1]);
  });
  const doc = {
    body: { dispatchEvent() { return true; } }, defaultView: { KeyboardEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o); } } },
    querySelectorAll: (sel) => els.filter((e) => e.isConnected && match(e, sel)),
    getElementById: (id) => els.find((e) => e.id === id) || null,
  };
  return { doc, mk };
}

test('registry: highest order first, one layer per press, nothing open -> null', () => {
  const r = createBackRegistry(); const open = { a: true, b: true }; const closed = [];
  r.register('a', { order: 10, isOpen: () => open.a, close: () => { open.a = false; closed.push('a'); } });
  r.register('b', { order: 20, isOpen: () => open.b, close: () => { open.b = false; closed.push('b'); } });
  assert.deepEqual(r.layers(), ['b', 'a']);
  assert.equal(r.closeTopmost(), 'b'); assert.equal(r.closeTopmost(), 'a'); assert.equal(r.closeTopmost(), null);
  assert.deepEqual(closed, ['b', 'a']);
});

test('registry: a throwing isOpen is skipped, a throwing close still counts as handled, re-register replaces, unregister removes', () => {
  const r = createBackRegistry(); const log = console.error; console.error = () => {};
  try {
    r.register('bad', { order: 90, isOpen: () => { throw new Error('x'); }, close: () => {} });
    r.register('stuck', { order: 80, isOpen: () => true, close: () => { throw new Error('y'); } });
    r.register('low', { order: 1, isOpen: () => true, close: () => { throw new Error('never'); } });
    assert.equal(r.closeTopmost(), 'stuck', 'Back never falls through to leaving the app while a layer is up');
    const off = r.register('stuck', { order: 80, isOpen: () => false, close: () => {} });
    assert.equal(r.closeTopmost(), 'low'); off(); assert.ok(!r.layers().includes('stuck'));
  } finally { console.error = log; }
});

test('DOM layers: each overlay is closed the way its own Escape / close button does, topmost first', () => {
  const { doc, mk } = fakeDom();
  const dlg = mk('mt-dialog', { onEscape: (e) => { e.isConnected = false; } });
  const sheet = mk('dm-sheet', { onEscape: (e) => { e.isConnected = false; } });
  const wt = mk('wt-overlay'); const wtx = mk(''); wt.querySelector = (s) => (s === '.wt-x' ? wtx : null); wtx.onClick = () => wt.classes.add('hidden');
  const deck = mk('', { id: 'deckSheet' }); const deckX = mk(''); deck.querySelector = (s) => (s === '.tt-sheet-close' ? deckX : null); deckX.onClick = () => { deck.hidden = true; };
  const tp = mk('tp'); const tpb = mk(''); tp.querySelector = (s) => (s === '.tp-back' ? tpb : null); tpb.onClick = () => tp.classes.add('hidden');
  const r = createBackRegistry();
  for (const l of domLayers(doc)) r.register(l.id, l);
  assert.equal(r.closeTopmost(), 'device-sheet'); assert.equal(sheet.esc, 1); assert.equal(dlg.esc, 0);
  assert.equal(r.closeTopmost(), 'mixtape-dialog'); assert.equal(dlg.esc, 1);
  assert.equal(r.closeTopmost(), 'walkthrough'); assert.equal(wtx.clicks, 1);
  assert.equal(r.closeTopmost(), 'deck-sheet'); assert.equal(deckX.clicks, 1);
  assert.equal(r.closeTopmost(), 'mixtape-player'); assert.equal(tpb.clicks, 1);
  assert.equal(r.closeTopmost(), null);
});

test('theme card: the preview step goes back to editing first, the edit step closes it', () => {
  const { doc, mk } = fakeDom();
  const ov = mk('theme-overlay', { id: 'themeOverlay' }); const prev = mk('', { id: 'themeStepPreview' });
  const x1 = mk('', { id: 'themeX1' }), x2 = mk('', { id: 'themeX2' });
  x2.onClick = () => { prev.hidden = true; }; x1.onClick = () => { ov.hidden = true; };
  const r = createBackRegistry(); for (const l of domLayers(doc)) r.register(l.id, l);
  assert.equal(r.closeTopmost(), 'theme-card'); assert.equal(x2.clicks, 1); assert.equal(x1.clicks, 0);
  assert.equal(r.closeTopmost(), 'theme-card'); assert.equal(x1.clicks, 1);
  assert.equal(r.closeTopmost(), null);
});

test('installBackButton: lock swallows Back with a hint and never unlocks; then search, drawer, library, section, else minimise', () => {
  const { doc, mk } = fakeDom();
  const hints = []; let unlocked = 0;
  const dm = { state: { locked: true }, showHint: (m) => hints.push(m), unlock: () => { unlocked++; } };
  let searchOpen = true, drawerOpen = true, libOpen = true, section = 'radio';
  const search = { isOpen: () => searchOpen, close: () => { searchOpen = false; } };
  const shell = { get isOpen() { return drawerOpen; }, get current() { return section; }, close: () => { drawerOpen = false; }, go: (id) => { section = id; } };
  const win = {};
  const b = installBackButton({ doc, win, deviceMode: dm, getSearch: () => search, getShell: () => shell, library: { isOpen: () => libOpen, close: () => { libOpen = false; } }, minimize: () => { win.minimized = (win.minimized || 0) + 1; } });
  assert.equal(win.__runoutBack, b.back, 'the Java fallback entry point is installed');
  assert.equal(b.back(), true); assert.equal(hints.length, 1); assert.equal(unlocked, 0); assert.equal(searchOpen, true, 'locked: nothing underneath closes');
  dm.state.locked = false;
  const order = [];
  while (b.back()) order.push(searchOpen + '/' + drawerOpen + '/' + libOpen + '/' + section);
  assert.deepEqual(order, ['false/true/true/radio', 'false/false/true/radio', 'false/false/false/radio', 'false/false/false/albums']);
  assert.equal(b.back(), false, 'nothing left: the caller minimises');
  assert.equal(unlocked, 0);
});

test('installBackButton: the @capacitor/app listener closes a layer, else minimises the app', async () => {
  const { doc } = fakeDom();
  let cb = null, minimized = 0;
  const App = { addListener: (n, f) => { assert.equal(n, 'backButton'); cb = f; return Promise.resolve({ remove() {} }); }, minimizeApp: async () => { minimized++; } };
  const win = { Capacitor: { isNativePlatform: () => true, isPluginAvailable: (n) => n === 'App', registerPlugin: (n) => { assert.equal(n, 'App'); return App; } } };
  let open = true;
  installBackButton({ doc, win, deviceMode: { state: { locked: false } }, getShell: () => ({ get isOpen() { return open; }, current: 'albums', close: () => { open = false; } }) });
  assert.ok(cb, 'listener registered');
  cb(); assert.equal(minimized, 0); assert.equal(open, false);   // the drawer closed
  cb(); await new Promise((r) => setTimeout(r, 0)); assert.equal(minimized, 1, 'nothing left: minimise');
});

test('nativeApp: null on the web', () => {
  assert.equal(nativeApp({}), null);
  assert.equal(nativeApp({ Capacitor: { isNativePlatform: () => false } }), null);
});
