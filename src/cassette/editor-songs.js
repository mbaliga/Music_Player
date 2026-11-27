// ─────────────────────────────────────────────────────────────────────────────
// editor-songs.js — the two song tabs of the mixtape editor:
//   Add     persistent library search (grouped by album, diacritic-insensitive), browse by album,
//           tap to add to the selected side, add a whole album, multi-select, "already on tape"
//           marks, refusal reasons; a virtualised list so 5,000+ tracks stay light.
//   Tracks  the selected side's list: drag to reorder (touch) or arrow keys / menu, swipe or menu
//           to remove or move to the other side, per-row durations, running time, a tape meter.
// Pure decisions live in mixtape.js / mixtape-pick.js; this file is DOM glue (text nodes only).
// ─────────────────────────────────────────────────────────────────────────────

import { h, icon, ICONS, reducedMotion } from './dom.js';
import {
  addMany, tryAdd, removeFromSide, moveInSide, moveAcross, autoFill, fmtDur, refSeconds, cleanDur, sideInfo, remaining, sideCapacity,
  resolveTracks, makeTrackRef, trackKey, MAX_SONGS_PER_SIDE, TAPES,
} from '../mixtape.js';
import { flattenGroups, virtualWindow, identOf } from '../mixtape-pick.js';

export const ROW_H = 58;

const subOf = (t) => [t.artist, t.album].filter(Boolean).join(' · ') || 'Unknown artist';
const durOf = (t) => { const d = cleanDur(t.durationSec); return d ? fmtDur(d) : '~' + fmtDur(240); };

/** Where each song on the tape is: Map(identity | trackKey -> 'A' | 'B'). */
export function tapeSides(m) {
  const map = new Map();
  for (const side of ['A', 'B']) for (const r of m.sides[side]) { if (r.id && !map.has(r.id)) map.set(r.id, side); const k = trackKey(r); if (!map.has(k)) map.set(k, side); }
  return map;
}
const sideOnTape = (map, t) => (t.id && map.get(t.id)) || map.get(trackKey(t)) || '';

/** "Added 9 of 12 to side A. 3 did not fit: Side A has 0:40 left; this song is 3:45." */
export function summarizeAdd(side, tracks, res) {
  if (tracks.length === 1) {
    return res.added ? `Added “${tracks[0].title}” to side ${side}.` : (res.skipped[0] ? res.skipped[0].reason : 'Could not add that song.');
  }
  if (!res.skipped.length) return `Added ${res.added} song${res.added === 1 ? '' : 's'} to side ${side}.`;
  const by = {};
  for (const s of res.skipped) by[s.code] = (by[s.code] || 0) + 1;
  const why = by.count && by.time ? 'side is full' : by.count ? `a side holds at most ${MAX_SONGS_PER_SIDE} songs` : res.skipped[0].reason;
  return `Added ${res.added} of ${tracks.length} to side ${side}. ${res.skipped.length} did not fit (${why}).`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Add tab
// ═════════════════════════════════════════════════════════════════════════════
export function createAddTab(E) {
  let picker = null, q = '', rows = [], expanded = new Set(), selectMode = false;
  const selected = new Map();   // identity -> track
  let onTape = new Map(), raf = 0, qTimer = 0, result = null;

  const root = h('div', { class: 'pk' });
  const segA = h('button', { class: 'pk-sidebtn', type: 'button', onclick: () => E.setSide('A') });
  const segB = h('button', { class: 'pk-sidebtn', type: 'button', onclick: () => E.setSide('B') });
  const seg = h('div', { class: 'pk-seg', role: 'group', 'aria-label': 'Add songs to side' }, segA, segB);
  const input = h('input', { class: 'pk-q', type: 'search', placeholder: 'Search songs, artists, albums', 'aria-label': 'Search your whole library', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search' });
  const selBtn = h('button', { class: 'pk-sel-toggle', type: 'button', 'aria-pressed': 'false', title: 'Pick several songs at once, then add them together', onclick: () => { selectMode = !selectMode; if (!selectMode) selected.clear(); paintAll(); } }, 'Pick several');
  const status = h('div', { class: 'pk-status', 'aria-live': 'polite' });
  const scroller = h('div', { class: 'pk-scroll', tabindex: '-1' });
  const spacer = h('div', { class: 'pk-spacer' });
  scroller.append(spacer);
  const bar = h('div', { class: 'pk-bar hidden' });
  root.append(seg, h('div', { class: 'pk-search' }, h('span', { class: 'pk-ico' }, icon(ICONS.search, { size: 18 })), input, selBtn), status, scroller, bar);

  function ensurePicker() {
    const p = E.picker();
    if (p !== picker) { picker = p; compute(); }
  }

  function compute() {
    if (!picker) return;
    result = picker.query(q);
    if (result.empty) {
      // browse by album: one row per album, tap to open it
      rows = [];
      for (const g of result.groups) {
        rows.push({ kind: 'album', album: g.album, tracks: g.tracks });
        if (expanded.has(g.album.key)) for (const t of g.tracks) rows.push({ kind: 'track', t, album: g.album });
      }
    } else rows = flattenGroups(result.groups).map((r) => (r.kind === 'head' ? { ...r, tracks: result.groups.find((g) => g.album.key === r.album.key).tracks } : r));
    scroller.scrollTop = 0;
    paintAll();
  }

  function sideTitle(side) {
    const r = remaining(E.m, side), info = sideInfo(E.m, side);
    return [h('b', {}, `Side ${side}`), h('small', {}, `${fmtDur(r.sec)} left · ${info.count} of ${MAX_SONGS_PER_SIDE} songs`)];
  }
  function paintHead() {
    onTape = tapeSides(E.m);
    for (const [btn, side] of [[segA, 'A'], [segB, 'B']]) {
      btn.replaceChildren(...sideTitle(side));
      btn.setAttribute('aria-pressed', String(E.side === side));
      btn.classList.toggle('on', E.side === side);
    }
    const lib = E.lib();
    if (!lib.length) status.textContent = '';
    else if (result && !result.empty) status.textContent = result.total ? `${result.total} song${result.total === 1 ? '' : 's'}${result.truncated ? ' (showing the first 400, refine to see more)' : ''}` : `No songs match “${q.trim()}”.`;
    else status.textContent = `${picker ? picker.browse().length : 0} albums · ${lib.length} songs · “Pick several” adds many at once`;
    selBtn.setAttribute('aria-pressed', String(selectMode)); selBtn.classList.toggle('on', selectMode);
    if (selectMode && lib.length) status.textContent = selected.size ? `${selected.size} picked. Tap more songs, then Add.` : 'Tap songs to pick several, then tap Add. Tap “Pick several” again to stop.';
    bar.classList.toggle('hidden', !(selectMode && selected.size));
    if (selectMode && selected.size) {
      bar.replaceChildren(h('span', {}, `${selected.size} selected`),
        h('button', { class: 'pk-go', type: 'button', onclick: addSelected }, `Add to side ${E.side}`),
        h('button', { class: 'pk-clear', type: 'button', onclick: () => { selected.clear(); paintAll(); } }, 'Clear'));
    }
  }

  function paintAll() { paintHead(); paintRows(); }

  function paintRows() {
    const lib = E.lib();
    if (!lib.length) {
      const native = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
      const scan = E.ctx.scanMusic ? h('button', { class: 'pk-scan', type: 'button', onclick: async () => { try { await E.ctx.scanMusic(); } catch { /* cancelled */ } E.libraryChanged(); setTimeout(() => E.libraryChanged(), 2500); } }, native ? 'Scan phone' : 'Scan music') : null;
      spacer.style.height = '0px'; spacer.replaceChildren(h('div', { class: 'pk-empty' }, E.ctx.scanMusic ? 'Your library is empty. Scan your music to add songs.' : (native ? 'Your library is empty. Open Albums and tap Scan phone first.' : 'Your library is empty. Scan your music folder in Albums first.'), scan));
      return;
    }
    if (!rows.length) { spacer.style.height = '0px'; spacer.replaceChildren(h('div', { class: 'pk-empty' }, q.trim() ? 'No songs match.' : 'Nothing to show.')); return; }
    const w = virtualWindow({ count: rows.length, rowH: ROW_H, scrollTop: scroller.scrollTop, viewH: scroller.clientHeight || 400 });
    spacer.style.height = w.totalH + 'px';
    const kids = [];
    for (let i = w.from; i < w.to; i++) kids.push(rowEl(rows[i], i));
    spacer.replaceChildren(...kids);
  }

  function rowEl(r, i) {
    const style = { transform: `translateY(${i * ROW_H}px)` };
    if (r.kind === 'head' || r.kind === 'album') {
      const open = r.kind === 'album' && expanded.has(r.album.key);
      const all = r.tracks;
      const left = all.filter((t) => !sideOnTape(onTape, t)).length;
      const main = h('button', { class: 'pk-albmain', type: 'button', 'data-i': i, 'data-act': 'toggle', 'aria-expanded': r.kind === 'album' ? String(open) : null,
        'aria-label': `${r.album.title} by ${r.album.artist}, ${r.album.count} songs` },
        r.kind === 'album' ? h('span', { class: 'pk-chev' + (open ? ' open' : '') }, icon(ICONS.chev, { size: 16 })) : null,
        h('span', { class: 'pk-main' }, h('b', {}, r.album.title), h('small', {}, `${r.album.artist} · ${r.album.count} song${r.album.count === 1 ? '' : 's'}${r.album.kind === 'cd' ? ' · CD' : ''}`)));
      const add = h('button', { class: 'pk-addall', type: 'button', 'data-i': i, 'data-act': 'album', disabled: left ? null : '', 'aria-label': `Add whole album ${r.album.title} to side ${E.side}` }, left ? 'Add album' : 'On tape');
      return h('div', { class: 'pk-alb', style }, main, add);
    }
    const t = r.t, side = sideOnTape(onTape, t), id = identOf(t), sel = selected.has(id);
    return h('div', { class: 'pk-row' + (side ? ' on' : '') + (sel ? ' sel' : ''), style },
      h('button', { class: 'pk-rowbtn', type: 'button', 'data-i': i, 'data-act': 'track', role: selectMode ? 'checkbox' : null, 'aria-checked': selectMode ? String(sel) : null,
        'aria-label': `${t.title}, ${subOf(t)}${side ? ', already on side ' + side : ''}` },
        h('span', { class: 'pk-main' }, h('b', {}, t.title), h('small', {}, subOf(t))),
        h('span', { class: 'pk-dur' }, durOf(t)),
        h('span', { class: 'pk-act' + (side ? ' ok' : '') }, selectMode ? (sel ? icon(ICONS.check, { size: 18, stroke: 2.6 }) : h('i', { class: 'pk-box' })) : (side ? h('span', {}, icon(ICONS.check, { size: 14, stroke: 2.8 }), side) : icon(ICONS.plus, { size: 20, stroke: 2.4 })))));
  }

  function addTracks(tracks) {
    const res = addMany(E.m, E.side, tracks);
    if (res.added) E.setM(res.mixtape);
    E.toast(summarizeAdd(E.side, tracks, res), { bad: !res.added });
    paintAll();
    return res;
  }
  function addSelected() { const list = [...selected.values()]; selected.clear(); addTracks(list); }

  scroller.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-act]'); if (!b) return;
    const r = rows[+b.getAttribute('data-i')]; if (!r) return;
    const act = b.getAttribute('data-act');
    if (act === 'toggle') { if (r.kind === 'album') { expanded.has(r.album.key) ? expanded.delete(r.album.key) : expanded.add(r.album.key); const top = scroller.scrollTop; compute(); scroller.scrollTop = top; paintRows(); } return; }
    if (act === 'album') { addTracks(r.tracks.filter((t) => !sideOnTape(onTape, t))); return; }
    if (act === 'track') {
      const t = r.t, id = identOf(t);
      if (selectMode) { selected.has(id) ? selected.delete(id) : selected.set(id, t); paintAll(); return; }
      const where = sideOnTape(onTape, t);
      if (where) { E.toast(`“${t.title}” is already on side ${where}.`); return; }
      addTracks([t]);
    }
  });
  scroller.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paintRows(); }); }, { passive: true });
  input.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { q = input.value; compute(); }, 110); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = ''; q = ''; compute(); } });

  return {
    el: root,
    show() { ensurePicker(); paintAll(); },
    refresh() { if (picker) paintAll(); },
    libraryChanged() { picker = null; if (root.isConnected) ensurePicker(); },
    focusSearch() { input.focus(); },
    /** Seed the search (e.g. from a search result). */
    setQuery(text) { input.value = text; q = text; if (picker) compute(); },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Tracks tab
// ═════════════════════════════════════════════════════════════════════════════
export function createTracksTab(E) {
  let menuAt = -1;
  const root = h('div', { class: 'tk' });
  const segA = h('button', { class: 'pk-sidebtn', type: 'button', onclick: () => E.setSide('A') });
  const segB = h('button', { class: 'pk-sidebtn', type: 'button', onclick: () => E.setSide('B') });
  const seg = h('div', { class: 'pk-seg', role: 'group', 'aria-label': 'Side to edit' }, segA, segB);
  const meter = h('div', { class: 'tk-meter', role: 'img' });
  const note = h('div', { class: 'tk-note' });
  const relink = h('div', { class: 'tk-relink' });
  const acts = h('div', { class: 'tk-acts' });
  const list = h('ol', { class: 'tk-list' });
  root.append(seg, meter, note, relink, acts, list);

  function paintHead() {
    for (const [btn, side] of [[segA, 'A'], [segB, 'B']]) {
      const info = sideInfo(E.m, side);
      btn.replaceChildren(h('b', {}, `Side ${side}`), h('small', {}, `${info.count} song${info.count === 1 ? '' : 's'} · ${fmtDur(info.sec, info.est)}`));
      btn.setAttribute('aria-pressed', String(E.side === side)); btn.classList.toggle('on', E.side === side);
    }
    // the tape meter: one segment per song, to scale against the side's capacity
    const side = E.side, cap = sideCapacity(E.m), refs = E.m.sides[side], info = sideInfo(E.m, side);
    const over = info.sec > cap;
    meter.className = 'tk-meter' + (over ? ' over' : '');
    meter.setAttribute('aria-label', `Side ${side}: ${fmtDur(info.sec, info.est)} of ${fmtDur(cap)}`);
    const total = Math.max(cap, info.sec);
    meter.replaceChildren(...refs.map((r, i) => { const d = refSeconds(r); return h('i', { class: 'seg' + (d.est ? ' est' : '') + (i % 2 ? ' alt' : ''), style: { width: (d.sec / total * 100).toFixed(2) + '%' }, title: r.title }); }));
    const r = remaining(E.m, side);
    note.textContent = over ? `Side ${side} is over by ${fmtDur(info.sec - cap)}: remove a song to make room.`
      : `${fmtDur(info.sec, info.est)} of ${fmtDur(cap)} · ${fmtDur(r.sec)} left · ${info.count} of ${MAX_SONGS_PER_SIDE} songs${info.est ? ' (~ = estimated length)' : ''}`;
    note.classList.toggle('bad', over);
  }

  function paintActs() {
    const lib = E.lib(), side = E.side;
    acts.replaceChildren(
      h('button', { class: 'tk-btn', type: 'button', disabled: E.m.tracks.length ? null : '', onclick: () => E.play(0) }, icon(ICONS.play, { size: 14, fill: 'currentColor', stroke: 0 }), ' Play tape'),
      h('button', { class: 'tk-btn', type: 'button', onclick: () => E.goTab('add') }, icon(ICONS.plus, { size: 16 }), ` Add to side ${side}`),
      h('button', { class: 'tk-btn', type: 'button', title: `Fill side ${side} with the rest of the albums already on the tape`, disabled: lib.length && E.m.tracks.length ? null : '', onclick: fillRest }, `Fill side ${side} with the rest`));
  }
  function fillRest() {
    const lib = E.lib(), picker = E.picker();
    if (!picker) return;
    const res = resolveTracks(E.m, lib).filter(Boolean);
    const have = new Set(res);
    const keys = new Set();
    for (const a of picker.index.albums) if (a.tracks.some((t) => have.has(t))) keys.add(a.key);
    const pool = [];
    for (const a of picker.index.albums) if (keys.has(a.key)) for (const t of a.tracks) if (!have.has(t)) pool.push(t);
    if (!pool.length) { E.toast('There is nothing left from the albums on this tape.'); return; }
    const r = autoFill(E.m, E.side, pool);
    if (r.added) E.setM(r.mixtape);
    E.toast(r.added ? summarizeAdd(E.side, pool, r) : r.skipped[0].reason, { bad: !r.added });
    paint();
  }

  const status = (resolved, i) => (!resolved[i] ? 'miss' : (resolved[i].file ? '' : 'relink'));

  function paintList() {
    const m = E.m, side = E.side, refs = m.sides[side], off = side === 'B' ? m.sides.A.length : 0;
    const resolved = resolveTracks(m, E.lib());
    const needs = resolved.some((r, i) => status(resolved, i) === 'relink');
    relink.replaceChildren();
    if (needs && E.ctx.relink) {
      relink.append(h('span', {}, 'Some songs are remembered but need re-linking to your music folder.'),
        h('button', { type: 'button', onclick: async () => { try { await E.ctx.relink(); } catch { /* cancelled */ } E.libraryChanged(); } }, 'Re-link…'));
    }
    if (!refs.length) {
      list.replaceChildren(h('li', { class: 'tk-empty' }, `Nothing on side ${side} yet. Use Add to search your library.`));
      return;
    }
    list.replaceChildren(...refs.map((r, i) => {
      const d = refSeconds(r);
      const st = status(resolved, off + i);
      const tag = st === 'miss' ? h('span', { class: 'tag miss' }, 'not in library') : st === 'relink' ? h('span', { class: 'tag' }, 'needs re-link') : null;
      const grip = h('button', { class: 'tk-grip', type: 'button', 'data-i': i, 'aria-label': `Reorder ${r.title}: drag, or use the up and down arrow keys`, onkeydown: (e) => gripKey(e, i) }, icon(ICONS.grip, { size: 20, stroke: 2.4 }));
      const main = h('div', { class: 'tk-main' },
        h('span', { class: 'tk-n' }, String(i + 1).padStart(2, '0')),
        h('span', { class: 'tk-text' }, h('b', {}, r.title), h('small', {}, [r.artist, r.album].filter(Boolean).join(' · ') || 'Unknown artist', tag)),
        h('span', { class: 'tk-time' }, h('span', {}, fmtDur(d.sec, d.est))));
      const dots = h('button', { class: 'tk-dots', type: 'button', 'aria-label': `More for ${r.title}`, 'aria-haspopup': 'true', 'aria-expanded': String(menuAt === i),
        onclick: (e) => { e.stopPropagation(); menuAt = menuAt === i ? -1 : i; paintList(); } }, icon(ICONS.dots, { size: 20, stroke: 2.6 }));
      const li = h('li', { class: 'tk-row' + (st === 'miss' ? ' dim' : ''), 'data-i': i }, grip, main, dots);
      if (menuAt === i) li.append(menuEl(i, r, side));
      attachDrag(li, grip, i);
      attachSwipe(li, main, i, r);
      return li;
    }));
    const tot = sideInfo(m, side);
    list.append(h('li', { class: 'tk-foot' }, h('span', {}, `Side ${side} total`), h('b', {}, fmtDur(tot.sec, tot.est)), h('small', {}, `of ${fmtDur(sideCapacity(m))} · ${refs.length} of ${MAX_SONGS_PER_SIDE} songs`)));
  }

  function menuEl(i, r, side) {
    const other = side === 'A' ? 'B' : 'A', n = E.m.sides[side].length;
    const item = (label, fn, o = {}) => h('button', { type: 'button', role: 'menuitem', class: o.cls || '', disabled: o.disabled ? '' : null, onclick: (e) => { e.stopPropagation(); menuAt = -1; fn(); } }, label);
    return h('div', { class: 'tk-menu', role: 'menu' },
      item('Move up', () => move(i, i - 1), { disabled: i === 0 }),
      item('Move down', () => move(i, i + 1), { disabled: i === n - 1 }),
      item(`Move to side ${other}`, () => across(i, side, other)),
      item('Play from here', () => E.play((side === 'B' ? E.m.sides.A.length : 0) + i)),
      item('Remove', () => remove(i, r), { cls: 'rm' }));
  }

  function move(from, to) {
    const m2 = moveInSide(E.m, E.side, from, to);
    if (m2 !== E.m) E.setM(m2);
    paint();
  }
  function across(i, from, to) {
    const res = moveAcross(E.m, from, i, to);
    if (res.ok) { const t = E.m.sides[from][i].title; E.setM(res.mixtape); E.toast(`Moved “${t}” to side ${to}.`); } else E.toast(res.reason, { bad: true });
    paint();
  }
  function remove(i, ref) {
    const before = E.m, side = E.side;
    E.setM(removeFromSide(E.m, side, i));
    E.toast(`Removed “${ref.title}”.`, { undo: () => { E.setM(before); paint(); } });
    paint();
  }
  function gripKey(e, i) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const to = i + (e.key === 'ArrowUp' ? -1 : 1), n = E.m.sides[E.side].length;
    if (to < 0 || to >= n) return;
    move(i, to);
    E.announce(`Moved to position ${to + 1} of ${n}`);
    const g = list.querySelector(`.tk-grip[data-i="${to}"]`); if (g) g.focus();
  }

  // drag to reorder (pointer events: touch + mouse; the handle is the only touch-action:none area)
  function attachDrag(li, grip, i) {
    grip.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button > 0) return;
      e.preventDefault();
      try { grip.setPointerCapture(e.pointerId); } catch { /* ok */ }
      const rowsEls = [...list.children].filter((x) => x.classList.contains('tk-row'));
      const hgt = li.getBoundingClientRect().height, n = rowsEls.length, y0 = e.clientY;
      let target = i;
      li.classList.add('drag');
      const mv = (ev) => {
        const dy = ev.clientY - y0;
        li.style.transform = `translateY(${dy}px)`;
        target = Math.max(0, Math.min(n - 1, i + Math.round(dy / hgt)));
        rowsEls.forEach((r, k) => {
          if (k === i) return;
          const shift = i < target && k > i && k <= target ? -hgt : (i > target && k < i && k >= target ? hgt : 0);
          r.style.transform = shift ? `translateY(${shift}px)` : '';
          r.classList.toggle('shift', !!shift);
        });
      };
      const up = () => {
        grip.removeEventListener('pointermove', mv); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', cancel);
        if (target !== i) { move(i, target); E.announce(`Moved to position ${target + 1} of ${n}`); } else paintList();
      };
      const cancel = () => { grip.removeEventListener('pointermove', mv); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', cancel); paintList(); };
      grip.addEventListener('pointermove', mv); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', cancel);
    });
  }

  // swipe left on the row to remove (with undo)
  function attachSwipe(li, main, i, ref) {
    let x0 = 0, y0 = 0, dx = 0, on = false, id = null;
    main.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') return; x0 = e.clientX; y0 = e.clientY; dx = 0; on = true; id = e.pointerId; });
    main.addEventListener('pointermove', (e) => {
      if (!on || e.pointerId !== id) return;
      dx = e.clientX - x0;
      if (Math.abs(e.clientY - y0) > 14 && Math.abs(dx) < 14) { on = false; main.style.transform = ''; return; }
      if (dx < -6) { main.style.transform = `translateX(${Math.max(dx, -140)}px)`; li.classList.toggle('arm', dx < -96); }
    });
    const end = () => {
      if (!on) return; on = false;
      const fire = dx < -96; main.style.transform = ''; li.classList.remove('arm');
      if (fire) remove(i, ref);
    };
    main.addEventListener('pointerup', end); main.addEventListener('pointercancel', () => { on = false; main.style.transform = ''; li.classList.remove('arm'); });
  }

  function paint() { paintHead(); paintActs(); paintList(); }
  root.addEventListener('click', (e) => { if (menuAt >= 0 && !(e.target.closest && e.target.closest('.tk-menu'))) { menuAt = -1; paintList(); } });
  return { el: root, show: paint, refresh: paint };
}
