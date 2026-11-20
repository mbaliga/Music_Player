// page.js — the Settings section (DOM). Built from settings.js's store; everything dynamic is set with textContent / attributes, never innerHTML.
// Groups are <details> (collapsible, remembered per visit only). Controls: radiogroup segments, switch buttons, accent swatches.
//
//   mountSettings(host, deps) -> { onShow(), onHide(), unmount() }
//   deps = {
//     store,                                           createSettingsStore(...)
//     customTheme: { status(): string, open(), exportText(): string, reset(), subscribe?(fn) },
//     layouts: [{ id, label, desc }],                  turntable layouts that exist right now ([] hides the row)
//     library: { prefs: libraryPrefs (src/library-prefs.js), deviceAvailable?(), mountScanCard?(el), scanNow?(), clearCache?() },
//     playback: { openDeckDetails?() },
//     radio: { favouriteCount(), recentCount(), clearFavourites(), clearRecents(), resetVoices() },
//     booth: { ringOn(): boolean | null },
//     privacy: { clearSearches() },
//     about: { build: string, walkthrough?() },
//   }
import { ACCENT_PRESETS, resolveAccent, onAccent } from '../theme.js';

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};

function seg(label, options, get, set) {
  const wrap = h('div', { class: 'st-seg', role: 'radiogroup', 'aria-label': label });
  const btns = options.map((o) => h('button', { type: 'button', role: 'radio', 'data-v': String(o.value), onclick: () => { set(o.value); paint(); } }, o.label, o.sub ? h('small', {}, o.sub) : null));
  const paint = () => { const cur = String(get()); btns.forEach((b) => { const on = b.dataset.v === cur; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }); };
  wrap.addEventListener('keydown', (e) => {
    const i = btns.indexOf(document.activeElement);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step || i < 0) return;
    e.preventDefault(); const n = btns[(i + step + btns.length) % btns.length]; n.focus(); n.click();
  });
  wrap.append(...btns); paint();
  return { el: wrap, paint };
}

function sw(label, hint, get, set) {
  const btn = h('button', { type: 'button', class: 'st-switch', role: 'switch', onclick: () => { set(!get()); paint(); } },
    h('span', { class: 'st-track' }), h('span', { class: 'st-grow' }, h('span', { class: 'st-label' }, label), hint ? h('span', { class: 'st-hint' }, hint) : null));
  const paint = () => btn.setAttribute('aria-checked', String(!!get()));
  paint();
  return { el: btn, paint };
}

function confirmBtn(label, armedLabel, run, { disabled = () => false } = {}) {
  let t = 0;
  const b = h('button', { type: 'button', class: 'st-btn danger', onclick: () => {
    if (b.dataset.armed === 'true') { clearTimeout(t); b.dataset.armed = 'false'; b.textContent = label; run(); return; }
    b.dataset.armed = 'true'; b.textContent = armedLabel; t = setTimeout(() => { b.dataset.armed = 'false'; b.textContent = label; }, 4000);
  } }, label);
  b.refresh = () => { b.disabled = !!disabled(); };
  return b;
}

export function mountSettings(host, deps) {
  const { store } = deps;
  const painters = [];
  const reg = (x) => { painters.push(x.paint || x.refresh); return x.el || x; };
  const row = (label, hint, control, cls = '') => h('div', { class: 'st-row ' + cls }, label ? h('div', { class: 'st-label' }, label) : null, control, hint ? h('div', { class: 'st-hint' }, hint) : null);
  const group = (title, sub, ...body) => h('details', { class: 'st-group', 'data-group': title.toLowerCase().replace(/[^a-z]+/g, '-') }, h('summary', {}, title, sub ? h('span', { class: 'st-sub' }, sub) : null), h('div', { class: 'st-body' }, ...body));
  const S = (path) => () => store.get(path);
  const T = (path) => (v) => store.set(path, v);

  // ── Appearance ──
  const theme = reg(seg('Theme', [{ value: 'dark', label: 'Dark', sub: 'soft' }, { value: 'oled', label: 'OLED black', sub: 'pure black' }, { value: 'light', label: 'Light' }], S('appearance.theme'), T('appearance.theme')));
  const swatches = h('div', { class: 'st-swatches', role: 'radiogroup', 'aria-label': 'Accent colour' });
  const hex = h('input', { class: 'st-hex', type: 'text', inputmode: 'text', maxlength: '7', placeholder: '#8E7BFF', 'aria-label': 'Custom accent colour as a hex code', autocomplete: 'off', spellcheck: 'false' });
  const hexMsg = h('div', { class: 'st-hint', 'aria-live': 'polite' });
  const sws = ACCENT_PRESETS.map((a) => h('button', { type: 'button', class: 'st-sw', role: 'radio', 'data-id': a.id, 'aria-label': a.label, title: a.label, style: `--sw:${a.hex};--sw-ink:${onAccent(a.hex)}`, onclick: () => { store.set('appearance.accent', a.id); hex.value = ''; hexMsg.textContent = ''; hex.removeAttribute('aria-invalid'); } }));
  swatches.append(...sws);
  const accentPaint = () => {
    const cur = store.get('appearance.accent');
    for (const b of sws) b.setAttribute('aria-checked', String(b.dataset.id === cur));
    const r = resolveAccent(cur); if (r && !ACCENT_PRESETS.some((a) => a.id === cur) && document.activeElement !== hex) hex.value = r.hex;
  };
  hex.addEventListener('input', () => {
    let v = hex.value.trim(); if (v && v[0] !== '#') v = '#' + v;
    if (!v || v === '#') { hexMsg.textContent = ''; hex.removeAttribute('aria-invalid'); return; }
    if (/^#[0-9a-fA-F]{6}$/.test(v) && store.set('appearance.accent', v)) { hexMsg.textContent = 'Applied.'; hex.removeAttribute('aria-invalid'); }
    else { hexMsg.textContent = 'Six hex digits, like #FE5031.'; hex.setAttribute('aria-invalid', 'true'); }
  });
  painters.push(accentPaint); accentPaint();
  const preview = h('div', { class: 'st-preview', 'aria-label': 'Preview', role: 'group' },
    h('div', { class: 'st-pv-title' }, 'Preview'), h('div', { class: 'st-pv-sub' }, 'Colours and text size update as you change them.'),
    h('div', { class: 'st-pv-row' }, h('span', { class: 'st-pv-chip' }, 'Selected'), h('span', { class: 'st-pv-chip off' }, 'Chip'), h('div', { class: 'st-pv-bar' })));
  const textSize = reg(seg('Text size', [{ value: 'small', label: 'Small' }, { value: 'default', label: 'Default' }, { value: 'large', label: 'Large' }], S('appearance.textSize'), T('appearance.textSize')));
  const motion = reg(seg('Motion', [{ value: 'system', label: 'Follow system' }, { value: 'reduce', label: 'Reduce always' }], S('appearance.reduceMotion'), T('appearance.reduceMotion')));

  const ct = deps.customTheme || {};
  const ctStatus = h('div', { class: 'st-hint' });
  const ctExport = h('pre', { class: 'st-pre', hidden: true, 'aria-label': 'Exported theme JSON' });
  const ctMsg = h('div', { class: 'st-hint', 'aria-live': 'polite' });
  const ctPaint = () => { try { ctStatus.textContent = (ct.status ? ct.status() : 'Built-in (default)') + (ct.status && ct.status() !== 'Built-in (default)' ? ' · its own colours replace the accent' : ''); } catch { ctStatus.textContent = ''; } };
  painters.push(ctPaint); ctPaint();
  const exportBtn = h('button', { type: 'button', class: 'st-btn', onclick: () => {
    try { ctExport.textContent = ct.exportText ? ct.exportText() : ''; } catch { ctExport.textContent = ''; }
    ctExport.hidden = false; ctMsg.textContent = 'Select the text to copy it, or use Copy.';
  } }, 'Export…');
  const copyBtn = h('button', { type: 'button', class: 'st-btn', onclick: async () => {
    if (ctExport.hidden) exportBtn.click();
    try { await navigator.clipboard.writeText(ctExport.textContent); ctMsg.textContent = 'Copied.'; } catch { ctMsg.textContent = 'Copy is not allowed here: select the text above instead.'; }
  } }, 'Copy');
  const customRow = row('Custom theme', null, h('div', { class: 'st-grow' }, ctStatus,
    h('div', { class: 'st-btns' }, h('button', { type: 'button', class: 'st-btn', onclick: () => ct.open && ct.open() }, 'Import JSON…'), exportBtn, copyBtn, h('button', { type: 'button', class: 'st-btn', onclick: () => { ct.reset && ct.reset(); ctExport.hidden = true; ctPaint(); } }, 'Reset')),
    ctExport, ctMsg));
  customRow.querySelector('.st-label').after(h('div', { class: 'st-hint' }, 'Paste a theme JSON; you see exactly what you pasted, as plain text, before anything is applied.'));

  const layouts = Array.isArray(deps.layouts) ? deps.layouts : [];
  const layoutRow = layouts.length ? row('Turntable layout', 'Albums page.', reg(seg('Turntable layout', layouts.map((l) => ({ value: l.id, label: l.label, sub: l.desc })), S('turntable.layout'), T('turntable.layout')))) : null;
  const haptics = reg(sw('Haptics', 'A short buzz when the needle crosses a gap, and on cassette buttons. Only on phones that can vibrate.', S('haptics'), T('haptics')));

  const appearance = group('Appearance', null,
    row('Theme', null, theme), row('Accent colour', 'Violet is the default; the orange is the logo colour. A custom theme, when one is set, brings its own.', swatches),
    h('div', { class: 'st-row' }, h('div', { class: 'st-hint' }, 'Or type your own colour (a hex code)'), h('div', { class: 'st-hexrow' }, hex, hexMsg)), preview, row('Text size', 'Applies to this page, search, the menu and Radio. The turntable and cassettes keep their drawn size.', textSize),
    row('Reduce motion', 'Always on follows your phone’s setting plus this switch; it never forces motion on.', motion), customRow, layoutRow, haptics);

  // ── Library ── (driven by src/library-prefs.js; the scan itself belongs to the library / device source)
  const lib = deps.library || {};
  const prefs = lib.prefs && typeof lib.prefs.get === 'function' ? lib.prefs : null;
  const libBody = [];
  if (prefs) {
    const P = (k) => () => { const v = prefs.get(); return k.split('.').reduce((o, x) => (o ? o[x] : undefined), v); };
    const patchOf = (k, v) => { const [a, b] = k.split('.'); return b ? { [a]: { [b]: v } } : { [a]: v }; };
    const bool = (k, label, hint) => reg(sw(label, hint, P(k), (v) => prefs.set(patchOf(k, v))));
    const deviceOk = lib.deviceAvailable ? !!lib.deviceAvailable() : false;
    if (lib.mountScanCard) { const card = h('div', { class: 'st-scancard' }); try { lib.mountScanCard(card); } catch { /* no card */ } libBody.push(card); }
    libBody.push(h('div', { class: 'st-text' }, 'Songs come from your own files only. The list of albums and songs is remembered on this phone.'));
    if (deviceOk) libBody.push(bool('sources.device', 'Songs on this phone', 'Read the phone\u2019s own music library.'));
    libBody.push(bool('sources.folder', 'Songs from a folder I choose', 'The folder picker scan. Works everywhere.'));
    const mins = [0, 15, 30, 60, 120];
    const curMin = () => Number(prefs.get().minDurationSec);
    const minOpts = () => (mins.includes(curMin()) ? mins : [...mins, curMin()].sort((x, y) => x - y)).map((n) => ({ value: n, label: n === 0 ? 'Off' : n >= 60 ? `${n / 60} min` : `${n} s` }));
    const minSeg = reg(seg('Hide songs shorter than', minOpts(), curMin, (v) => prefs.set({ minDurationSec: v })));
    libBody.push(row('Hide short songs', 'Keeps ringtones and voice notes out. Songs shorter than this are not listed.', minSeg));
    const listArea = (key, label, hint) => {
      const ta = h('textarea', { class: 'st-area', rows: '3', 'aria-label': label, spellcheck: 'false', autocapitalize: 'off', placeholder: 'One folder name per line' });
      const paint = () => { if (document.activeElement !== ta) ta.value = (prefs.get()[key] || []).join('\n'); };
      ta.addEventListener('change', () => prefs.set({ [key]: ta.value.split('\n').map((x) => x.trim()).filter(Boolean) }));
      painters.push(paint); paint();
      return row(label, hint, ta);
    };
    libBody.push(listArea('excludeFolders', 'Folders to leave out', 'Phone library only. A folder name or part of its path, one per line.'));
    libBody.push(listArea('includeFolders', 'Only these folders', 'Phone library only. When this is not empty, only these folders are listed.'));
    libBody.push(bool('rescanOnResume', 'Look for new songs when I come back to the app', 'A quick re-scan (not more than every few minutes).'));
    libBody.push(bool('parseUntagged', 'Read tags from the file when the phone has none', 'Slower the first time, better titles.'));
    const btns = [];
    if (lib.scanNow) btns.push(h('button', { type: 'button', class: 'st-btn primary', onclick: () => lib.scanNow() }, 'Scan now'));
    if (lib.clearCache) btns.push(confirmBtn('Clear library cache', 'Tap again to clear', () => lib.clearCache()));
    btns.push(confirmBtn('Reset library options', 'Tap again to reset', () => prefs.reset()));
    libBody.push(h('div', { class: 'st-btns' }, ...btns));
    if (typeof prefs.subscribe === 'function') prefs.subscribe(() => { for (const p of painters) { try { p(); } catch { /* */ } } });
  } else {
    libBody.push(h('div', { class: 'st-text' }, 'Songs come from your own files only. Choose a folder to scan; the list of albums and songs is remembered on this phone.'));
    if (lib.scanNow) libBody.push(h('div', { class: 'st-btns' }, h('button', { type: 'button', class: 'st-btn primary', onclick: () => lib.scanNow() }, 'Scan music folder\u2026')));
    libBody.push(h('div', { class: 'st-note' }, 'More library options (sources, minimum song length, folders to include or leave out) appear here when the phone library is available.'));
  }
  const library = group('Library', null, ...libBody);

  // ── Playback ──
  const rpm = reg(seg('Default speed', [{ value: 33.333, label: '33⅓' }, { value: 45, label: '45' }, { value: 78, label: '78' }], S('playback.defaultRpm'), T('playback.defaultRpm')));
  const audiophile = reg(sw('Audiophile mode', 'Shows the feel knobs (inertia, motor pull, friction, brake) and the latency readout in Albums → Deck details.', S('playback.audiophile'), T('playback.audiophile')));
  const playback = group('Playback', null, row('Default speed', 'The speed the turntable starts at.', rpm), audiophile,
    h('div', { class: 'st-row' }, h('div', { class: 'st-label' }, 'Advanced'), h('div', { class: 'st-hint' }, 'Fine speed, rate, position, wear, feel knobs, latency, load a single file and the build id stay in Deck details on the Albums page.'),
      h('div', { class: 'st-btns' }, h('button', { type: 'button', class: 'st-btn', onclick: () => deps.playback && deps.playback.openDeckDetails && deps.playback.openDeckDetails() }, 'Open Deck details'))));

  // ── Radio ──
  const rd = deps.radio || {};
  const ai = reg(sw('AI stations (experimental)', 'Adds You Radio: automated hosts who talk between your own songs, with lines written and spoken on this phone. Needs no network and no account. Off by default.', S('radio.aiStations'), T('radio.aiStations')));
  const clearFav = confirmBtn('Clear favourites', 'Tap again to clear', () => { rd.clearFavourites && rd.clearFavourites(); refreshRadio(); }, { disabled: () => !(rd.favouriteCount && rd.favouriteCount() > 0) });
  const clearRec = confirmBtn('Clear recents', 'Tap again to clear', () => { rd.clearRecents && rd.clearRecents(); refreshRadio(); }, { disabled: () => !(rd.recentCount && rd.recentCount() > 0) });
  const resetVoices = confirmBtn('Reset host voices', 'Tap again to reset', () => { rd.resetVoices && rd.resetVoices(); });
  const radioMsg = h('div', { class: 'st-hint' });
  const refreshRadio = () => { clearFav.refresh(); clearRec.refresh(); try { radioMsg.textContent = `${rd.favouriteCount ? rd.favouriteCount() : 0} favourites, ${rd.recentCount ? rd.recentCount() : 0} recents saved on this phone.`; } catch { radioMsg.textContent = ''; } };
  painters.push(refreshRadio); refreshRadio();
  const radio = group('Radio', null, ai,
    h('div', { class: 'st-text' }, h('b', {}, 'Pre-written shows'), ' are fictional stations written in advance, so they work with no internet. They are always available.'),
    h('div', { class: 'st-text' }, h('b', {}, 'Host voices'), ' are chosen per show: start a show and open “Cast and voices” on its card.'),
    h('div', { class: 'st-btns' }, clearFav, clearRec, resetVoices), radioMsg);

  // ── Booth ──
  const bt = deps.booth || {};
  const ringLine = h('div', { class: 'st-text' });
  const boothPaint = () => { let on = null; try { on = bt.ringOn ? bt.ringOn() : null; } catch { on = null; } ringLine.textContent = on === null ? '' : `The light ring is ${on ? 'on' : 'off'}.`; };
  painters.push(boothPaint); boothPaint();
  const booth = group('Booth', 'effects', h('div', { class: 'st-text' }, 'The light ring and latch (tap to switch an effect on and off) are in the Booth: open its menu and choose Settings…. Reduce motion above also quiets the ring.'), ringLine);

  // ── Privacy & about ──
  const pv = deps.privacy || {};
  const remember = reg(sw('Remember my searches', 'The last few searches are kept on this phone so you can repeat them. Switch off to stop saving them.', S('privacy.rememberSearches'), (v) => { const ok = store.set('privacy.rememberSearches', v); if (!v && pv.clearSearches) pv.clearSearches(); return ok; }));
  const ab = deps.about || {};
  const privacy = group('Privacy & about', null,
    h('div', { class: 'st-brand' }, h('img', { src: './assets/icon-192.png', alt: '', width: '48', height: '48' }), h('div', { class: 'st-grow' }, h('div', { class: 'st-label' }, 'Runout'), h('div', { class: 'st-hint' }, ab.build || 'build: dev'))),
    h('div', { class: 'st-text' }, h('b', {}, 'What leaves this phone: nothing, by default.'), ' Runout plays your own songs. Your library, mixtapes, favourites, searches and settings stay on this phone. The only things that use the network are the ones you start yourself: internet radio streams, and the internet radio directory when you tap “Search the internet radio directory”. The pre-written shows work offline. If the AI stations backend is ever switched on, it will be listed here first.'),
    remember, h('div', { class: 'st-btns' }, h('button', { type: 'button', class: 'st-btn', onclick: () => deps.about && deps.about.walkthrough && deps.about.walkthrough() }, 'Show the tour again')),
    h('div', { class: 'st-text' }, h('b', {}, 'Licence. '), 'PolyForm Noncommercial 1.0.0 (free for noncommercial use). A commercial licence is available separately: see COMMERCIAL-LICENSE.md in the project.'),
    h('div', { class: 'st-text' }, h('b', {}, 'Documents '), '(in the project folder, not fetched by the app):',
      h('ul', { class: 'st-list' }, ...['README.md', 'docs/SHELL.md', 'docs/SEARCH.md', 'docs/SETTINGS.md', 'docs/FX.md', 'docs/RADIO_ARCHITECTURE.md'].map((d) => h('li', {}, h('code', {}, d))))));

  const page = h('div', { class: 'st-page', role: 'region', 'aria-label': 'Settings' }, appearance, library, playback, radio, booth, privacy);
  appearance.open = true;
  host.append(page);

  const repaint = () => { for (const p of painters) { try { p(); } catch { /* one broken row does not stop the rest */ } } };
  const unsub = store.subscribe(repaint);
  if (ct.subscribe) ct.subscribe(ctPaint);
  return {
    onShow() { try { store.refresh(); } catch { /* */ } repaint(); },
    onHide() {},
    repaint,
    unmount() { unsub(); page.remove(); },
    page,
  };
}
