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
//     sleep: the sleep timer model (src/sleep.js: start, cancel, state, subscribe); omit to hide the row
//     radio: { favouriteCount(), recentCount(), clearFavourites(), clearRecents(), resetVoices() },
//     booth: { ringOn(): boolean | null },
//     deviceMode: { open() },                          Device mode's own options sheet (src/devicemode/sheet.js); omit to hide the group
//     privacy: { clearSearches() },
//     about: { build: string, walkthrough?() },
//   }
import { ACCENT_PRESETS, resolveAccent, onAccent } from '../theme.js';
import { h, seg, sw } from './controls.js';
import { mountSleep } from '../sleep-ui.js';

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
  customRow.querySelector('.st-label').after(h('div', { class: 'st-hint' }, 'Paste a theme file to restyle the app. You see a preview before anything changes.'));

  const layouts = Array.isArray(deps.layouts) ? deps.layouts : [];
  const layoutRow = layouts.length ? row('Turntable layout', 'Albums page.', reg(seg('Turntable layout', layouts.map((l) => ({ value: l.id, label: l.label, sub: l.desc })), S('turntable.layout'), T('turntable.layout')))) : null;
  const haptics = reg(sw('Haptics', 'A short buzz on record gaps and cassette keys.', S('haptics'), T('haptics')));

  const appearance = group('Appearance', null,
    row('Theme', 'Applies to menus and settings. Player surfaces stay dark: the turntable, library, CD view and cassette player look the same in every theme.', theme), row('Accent colour', 'The colour of buttons and highlights.', swatches),
    h('div', { class: 'st-row' }, h('div', { class: 'st-hint' }, 'Or enter your own colour code'), h('div', { class: 'st-hexrow' }, hex, hexMsg)), preview, row('Text size', 'Bigger or smaller text in the menu, Settings, search and Radio.', textSize),
    row('Reduce motion', 'Follow system uses your phone’s own setting.', motion), customRow, layoutRow, haptics);

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
    libBody.push(h('div', { class: 'st-text' }, 'Runout plays music from your own files. Your song list is saved on this phone.'));
    if (deviceOk) libBody.push(bool('sources.device', 'Songs on this phone', 'The music already on this phone.'));
    libBody.push(bool('sources.folder', 'Songs from a folder I choose', 'Pick a folder of music to add.'));
    const mins = [0, 15, 30, 60, 120];
    const curMin = () => Number(prefs.get().minDurationSec);
    const minOpts = () => (mins.includes(curMin()) ? mins : [...mins, curMin()].sort((x, y) => x - y)).map((n) => ({ value: n, label: n === 0 ? 'Off' : n >= 60 ? `${n / 60} min` : `${n} s` }));
    const minSeg = reg(seg('Hide songs shorter than', minOpts(), curMin, (v) => prefs.set({ minDurationSec: v })));
    libBody.push(row('Hide short songs', 'Leaves out ringtones and voice notes.', minSeg));
    const listArea = (key, label, hint) => {
      const ta = h('textarea', { class: 'st-area', rows: '3', 'aria-label': label, spellcheck: 'false', autocapitalize: 'off', placeholder: 'One folder name per line' });
      const paint = () => { if (document.activeElement !== ta) ta.value = (prefs.get()[key] || []).join('\n'); };
      ta.addEventListener('change', () => prefs.set({ [key]: ta.value.split('\n').map((x) => x.trim()).filter(Boolean) }));
      painters.push(paint); paint();
      return row(label, hint, ta);
    };
    libBody.push(listArea('excludeFolders', 'Folders to leave out', 'One folder name per line.'));
    libBody.push(listArea('includeFolders', 'Only these folders', 'If you add any, only these folders are used.'));
    libBody.push(bool('rescanOnResume', 'Look for new songs when I come back to the app', 'A quick check each time you open Runout.'));
    libBody.push(bool('parseUntagged', 'Read song details from the files', 'Slower the first time, better titles.'));
    const btns = [];
    if (lib.scanNow) btns.push(h('button', { type: 'button', class: 'st-btn primary', onclick: () => lib.scanNow() }, (lib.deviceAvailable && lib.deviceAvailable() ? 'Rescan phone (same as Albums)' : 'Rescan music folder (same as Albums)')));
    if (lib.clearCache) btns.push(confirmBtn('Clear library cache', 'Tap again to clear', () => lib.clearCache()));
    btns.push(confirmBtn('Reset library options', 'Tap again to reset', () => prefs.reset()));
    libBody.push(h('div', { class: 'st-btns' }, ...btns));
    if (typeof prefs.subscribe === 'function') prefs.subscribe(() => { for (const p of painters) { try { p(); } catch { /* */ } } });
  } else {
    libBody.push(h('div', { class: 'st-text' }, 'Runout plays music from your own files. Choose a folder to add; your song list is saved on this phone.'));
    if (lib.scanNow) libBody.push(h('div', { class: 'st-btns' }, h('button', { type: 'button', class: 'st-btn primary', onclick: () => lib.scanNow() }, 'Scan music folder\u2026')));
    libBody.push(h('div', { class: 'st-note' }, 'More options appear in the Android app.'));
  }
  const library = group('Library', null, ...libBody);

  // ── Playback ──
  const rpm = reg(seg('Default speed', [{ value: 33.333, label: '33⅓' }, { value: 45, label: '45' }, { value: 78, label: '78' }], S('playback.defaultRpm'), T('playback.defaultRpm')));
  const audiophile = reg(sw('Audiophile mode', 'Adds fine-tuning dials for the record to Tracks and options.', S('playback.audiophile'), T('playback.audiophile')));
  const shuffleSw = reg(sw('Shuffle', 'Play an album, or Play all, in a random order.', S('playback.shuffle'), T('playback.shuffle')));
  const repeatSeg = reg(seg('Repeat', [{ value: 'off', label: 'Off' }, { value: 'all', label: 'All' }, { value: 'one', label: 'One' }], S('playback.repeat'), T('playback.repeat')));
  const sleepHost = h('div', { class: 'st-grow' });
  if (deps.sleep) mountSleep(sleepHost, deps.sleep);
  const sleepRow = deps.sleep ? row('Sleep timer', 'Fades the music out over the last 10 seconds, then stops it. Works with the screen off.', sleepHost) : null;
  const playback = group('Playback', null, row('Default speed', 'The speed the turntable starts at.', rpm), audiophile, shuffleSw, row('Repeat', 'All plays the album again when it ends; One repeats the track.', repeatSeg), sleepRow,
    h('div', { class: 'st-row' }, h('div', { class: 'st-label' }, 'More controls'), h('div', { class: 'st-hint' }, 'Fine speed, position and extra record details.'),
      h('div', { class: 'st-btns' }, h('button', { type: 'button', class: 'st-btn', onclick: () => deps.playback && deps.playback.openDeckDetails && deps.playback.openDeckDetails() }, 'Open Tracks and options'))));

  // ── Radio ──
  const rd = deps.radio || {};
  const ai = reg(sw('You Radio: offline shows from your library', 'Adds a station that plays your own songs with hosts talking in between. The talk is pre-written templates filled in with your song names, not generated by AI. Runs on this phone; no account needed.', S('radio.aiStations'), T('radio.aiStations')));
  const clearFav = confirmBtn('Clear favourites', 'Tap again to clear', () => { rd.clearFavourites && rd.clearFavourites(); refreshRadio(); }, { disabled: () => !(rd.favouriteCount && rd.favouriteCount() > 0) });
  const clearRec = confirmBtn('Clear recents', 'Tap again to clear', () => { rd.clearRecents && rd.clearRecents(); refreshRadio(); }, { disabled: () => !(rd.recentCount && rd.recentCount() > 0) });
  const resetVoices = confirmBtn('Reset host voices', 'Tap again to reset', () => { rd.resetVoices && rd.resetVoices(); });
  const radioMsg = h('div', { class: 'st-hint' });
  const refreshRadio = () => { clearFav.refresh(); clearRec.refresh(); try { radioMsg.textContent = `${rd.favouriteCount ? rd.favouriteCount() : 0} favourites, ${rd.recentCount ? rd.recentCount() : 0} recents saved on this phone.`; } catch { radioMsg.textContent = ''; } };
  painters.push(refreshRadio); refreshRadio();
  const radio = group('Radio', null, ai,
    h('div', { class: 'st-text' }, h('b', {}, 'Pre-written shows'), ' always work, even with no internet.'),
    h('div', { class: 'st-text' }, h('b', {}, 'Host voices'), ' are chosen on each show’s own card.'),
    h('div', { class: 'st-btns' }, clearFav, clearRec, resetVoices), radioMsg);

  // ── Booth ──
  const bt = deps.booth || {};
  const ringLine = h('div', { class: 'st-text' });
  const boothPaint = () => { let on = null; try { on = bt.ringOn ? bt.ringOn() : null; } catch { on = null; } ringLine.textContent = on === null ? '' : `The light ring is ${on ? 'on' : 'off'}.`; };
  painters.push(boothPaint); boothPaint();
  const booth = group('Booth', 'effects', h('div', { class: 'st-text' }, 'Effect options are inside Booth itself. Reduce motion also calms the light ring.'), ringLine);

  // ── Device mode ── (the lock key, always-on display and keep-awake live in src/devicemode/; its own options sheet is opened from here)
  const dm = deps.deviceMode;
  const device = dm ? group('Device mode', 'lock & always-on', h('div', { class: 'st-text' }, 'Lock the screen so a stray touch does nothing while music plays, keep it awake, and show a dim always-on clock. The lock key is in the top bar of every page.'),
    h('div', { class: 'st-btns' }, h('button', { type: 'button', class: 'st-btn', onclick: () => dm.open && dm.open() }, 'Open device mode options'))) : null;

  // ── Privacy & about ──
  const pv = deps.privacy || {};
  const remember = reg(sw('Remember my searches', 'Keeps your last few searches on this phone so you can repeat them.', S('privacy.rememberSearches'), (v) => { const ok = store.set('privacy.rememberSearches', v); if (!v && pv.clearSearches) pv.clearSearches(); return ok; }));
  const ab = deps.about || {};
  const version = String(ab.build || 'dev').replace(/^build:\s*/i, '');
  const privacy = group('Privacy & about', null,
    h('div', { class: 'st-brand' }, h('img', { src: './assets/icon-192.png', alt: '', width: '48', height: '48' }), h('div', { class: 'st-grow' }, h('div', { class: 'st-label' }, 'Runout'), h('div', { class: 'st-hint' }, 'Version ' + version))),
    h('div', { class: 'st-text' }, h('b', {}, 'Stays on this phone. '), 'Your library, mixtapes, favourites, searches and settings are saved here and never uploaded.'),
    h('div', { class: 'st-text' }, h('b', {}, 'The internet is used only when you ask. '), 'To play a radio station or search the radio directory. Pre-written shows work offline.'),
    remember, h('div', { class: 'st-btns' }, h('button', { type: 'button', class: 'st-btn', onclick: () => deps.about && deps.about.walkthrough && deps.about.walkthrough() }, 'Show the tour again')),
    h('div', { class: 'st-text' }, h('b', {}, 'Licence. '), 'Free for personal, noncommercial use (PolyForm Noncommercial 1.0.0). A commercial licence is available separately.'));

  const page = h('div', { class: 'st-page', role: 'region', 'aria-label': 'Settings' }, appearance, library, playback, radio, booth, device, privacy);
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
