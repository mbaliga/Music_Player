// ─────────────────────────────────────────────────────────────────────────────
// dial.js — "the dial": the station picker section of the Radio tab. Browser glue over catalog.js (pure).
//
//   Pre-written shows   the six canned stations as cards (name, dial number, tagline, vibe, host chips, about N minutes of
//                       talk, a "Pre-written show" badge, a daypart badge that only orders and hints). Tap = start. Star = favourite.
//   AI station styles   only with the radio.ai flag on: the five bible styles as GREYED cards, "Needs internet — coming soon".
//                       Tap = style info and a "hear a host" audition through the phone's voice. Never startable yet.
// Loaded lazily from the Radio tab (radio-player.js), never from boot. Real stations and You Radio stay in radio-player.js.
// ─────────────────────────────────────────────────────────────────────────────

import { buildCatalog, OFFLINE_LABEL, NEEDS_INTERNET } from './catalog.js';
import { hostProsody } from './ai-styles.js';
import { loadStationsIndex } from './session.js';
import { createAuditioner } from './audition.js';

const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
};

let auditioner = null;

/**
 * ctx = { aiOn(): boolean, isFav(station): boolean, toggleFav(station), play(station), isCurrent(station), isPlaying(): boolean,
 *         fetchFn?, baseUrl?, hour?, storage?, onChanged?() }
 * Renders into `root`. -> Promise<{ canned: number, styles: number }>
 */
export async function renderDial(root, ctx) {
  const baseUrl = ctx.baseUrl || document.baseURI;
  const fetchFn = ctx.fetchFn || ((u, o) => fetch(u, o));
  const index = await loadStationsIndex({ fetchFn, baseUrl });
  try { if (ctx.onIndex) ctx.onIndex(index); } catch { /* saved-list refresh is best effort */ }
  const hour = Number.isFinite(ctx.hour) ? ctx.hour : new Date().getHours();
  const cat = buildCatalog({ index, flagOn: ctx.aiOn(), hour, cloudAvailable: false });
  const kids = [];

  if (cat.canned.length) {
    kids.push(h('section', { class: 'dial-sec', 'data-sec': 'canned' },
      h('div', { class: 'radio-sec-head' }, h('span', {}, 'Offline shows')),
      h('p', { class: 'dial-sub' }, 'Made-up stations with hosts who chat between your own songs. Everything is written in advance, so they work without internet. The ones that suit this time of day come first.'),
      h('div', { class: 'dial-cards' }, cat.canned.map((c) => cannedCard(c, ctx)))));
  } else {
    kids.push(h('section', { class: 'dial-sec', 'data-sec': 'canned' }, h('div', { class: 'radio-sec-head' }, h('span', {}, 'Offline shows')),
      h('p', { class: 'dial-sub' }, 'The station list could not be loaded.')));
  }
  if (cat.styles.length) {
    kids.push(h('section', { class: 'dial-sec', 'data-sec': 'styles' },
      h('div', { class: 'radio-sec-head' }, h('span', {}, 'AI station styles')),
      h('p', { class: 'dial-sub' }, 'These need an internet connection and are not available yet. Tap one to read about it and hear its hosts through this phone’s voice.'),
      h('div', { class: 'dial-cards' }, cat.styles.map((c) => styleCard(c, ctx)))));
  }
  root.replaceChildren(...kids);
  if (ctx.paintCard) root.querySelectorAll('.dial-card[data-station]').forEach((el) => ctx.paintCard(el));
  return { canned: cat.canned.length, styles: cat.styles.length };
}

function cannedCard(c, ctx) {
  const st = c.station;
  const fav = ctx.isFav(st);
  const star = h('button', { class: 'radio-star dial-star' + (fav ? ' on' : ''), type: 'button', 'aria-pressed': String(fav), 'aria-label': (fav ? 'Remove ' : 'Add ') + c.name + (fav ? ' from favourites' : ' to favourites'),
    onclick: (e) => { e.stopPropagation(); ctx.toggleFav(st); } }, fav ? '★' : '☆');
  const tagId = `dial-tag-${c.id}`;
  // A plain container; the ONE real <button> is the visible Play / Stop button at the bottom, stretched over the card (::after) so the
  // whole card plays it. The star is a sibling above the overlay (44 px hit area), so a missed star tap can only miss, never start.
  // The label ("Play" / "Stop"), the now-playing line and the .on state are painted by the Radio tab (paintCard) as the station changes.
  return h('div', { class: 'dial-card' + (ctx.isCurrent(st) ? ' on' : ''), 'data-k': c.key, 'data-station': c.id },
    h('div', { class: 'dial-top' }, h('span', { class: 'dial-name' }, c.name), ' ', h('span', { class: 'dial-num' }, c.dial)),
    h('div', { class: 'dial-tag', id: tagId }, c.tagline),
    h('div', { class: 'dial-vibe' }, c.vibe),
    h('div', { class: 'dial-chips' }, c.hostChips.map((x) => h('span', { class: 'dial-chip', title: x.role }, x.name)), c.castCount ? h('span', { class: 'dial-chip dim' }, `+${c.castCount} more voices`) : null),
    h('div', { class: 'dial-meta' }, h('span', { class: 'dial-badge' }, OFFLINE_LABEL), h('span', {}, `about ${c.minutes} min of talk`), h('span', { 'data-daypart': c.inDaypart ? 'fit' : 'other' }, c.daypartBadge)),
    h('div', { class: 'dial-actions' },
      h('button', { class: 'dial-play', type: 'button', 'data-play': '', 'data-name': c.name, 'data-dial': c.dial, 'aria-describedby': tagId, 'aria-label': `Play ${c.name}, dial ${c.dial}`, onclick: () => ctx.play(st) }, '▶ Play'),
      h('span', { class: 'rr-now', 'data-now': '', role: 'status' })),
    star);
}

function styleCard(c, ctx) {
  const s = c.style;
  const info = h('div', { class: 'dial-info', hidden: true });
  let built = false;
  const toggle = () => {
    if (!built) { built = true; fillInfo(info, c, ctx); }
    info.hidden = !info.hidden;
    card.querySelector('.dial-play').setAttribute('aria-expanded', String(!info.hidden));
  };
  const infoId = `dial-info-${c.id}`;
  info.id = infoId;
  const card = h('div', { class: 'dial-card grey', 'data-k': c.key, 'data-style': c.id, 'data-startable': 'false' },
    h('div', { class: 'dial-top' },
      h('button', { class: 'dial-play', type: 'button', 'aria-expanded': 'false', 'aria-controls': infoId, 'aria-label': `${c.name}, ${c.subtitle}. ${NEEDS_INTERNET}. Tap for details.`, onclick: toggle },
        h('span', { class: 'dial-name' }, c.name), ' ', h('span', { class: 'dial-num' }, c.subtitle))),
    h('div', { class: 'dial-tag' }, c.mode),
    h('div', { class: 'dial-bar', role: 'img', 'aria-label': `${Math.round(c.talkShare * 100)} percent talk, ${Math.round(c.musicShare * 100)} percent music` },
      h('i', { style: `width:${Math.round(c.talkShare * 100)}%` }), h('b', { style: `width:${Math.round(c.musicShare * 100)}%` })),
    h('div', { class: 'dial-chips' }, c.hostChips.map((x) => h('span', { class: 'dial-chip', title: x.role }, x.name))),
    h('div', { class: 'dial-meta' }, h('span', { class: 'dial-badge soon' }, NEEDS_INTERNET), h('span', { 'data-daypart': c.inDaypart ? 'fit' : 'other' }, c.daypartBadge),
      h('span', {}, `${Math.round(c.talkShare * 100)}% talk · ${Math.round(c.musicShare * 100)}% music`)),
    info);
  // taps inside the info panel (audition buttons) must not collapse it
  info.addEventListener('click', (e) => e.stopPropagation());
  return card;
}

function fillInfo(info, c, ctx) {
  const s = c.style;
  const note = h('div', { class: 'dial-aud', role: 'status' });
  const hosts = s.hosts.map((host) => {
    const pr = hostProsody(host);
    const first = host.id.charAt(0).toUpperCase() + host.id.slice(1);
    const btn = h('button', { type: 'button', 'data-audition': host.id, onclick: async () => {
      if (ctx.isPlaying && ctx.isPlaying()) { note.textContent = 'Stop the station that is playing first, then listen.'; return; }
      auditioner = auditioner || createAuditioner({ storage: ctx.storage || null });
      if (btn.dataset.busy === '1') { auditioner.stop(); btn.dataset.busy = '0'; btn.textContent = `Hear ${first}`; note.textContent = ''; return; }
      btn.dataset.busy = '1'; btn.textContent = 'Stop';
      const r = await auditioner.audition(host, { onLine: (t) => { note.textContent = t; } });
      btn.dataset.busy = '0'; btn.textContent = `Hear ${first}`;
      note.textContent = r.ok ? 'That was the audition script, read in this host’s pace and pitch.' : r.reason === 'no speech engine' ? 'This device reported no speech engine, so there is nothing to play the audition with.' : r.reason === 'no offline voice' ? 'No offline voice on this device, so there is nothing to play the audition with (the phone’s online voices are never used).' : 'The phone’s voice stopped before the audition finished.';
    } }, `Hear ${first}`);
    return h('div', { class: 'dial-host' },
      h('b', {}, host.name), host.default ? ' (default)' : '', h('div', { class: 'dial-vibe' }, `${host.age}, ${host.register}. Flat-voice device: ${host.flatDevice}.`),
      h('dl', {}, h('dt', {}, 'Pace / pitch'), h('dd', {}, `${pr.rate} / ${pr.pitch} (${host.mood})`), h('dt', {}, 'Pauses'), h('dd', {}, host.pauseHabit), h('dt', {}, 'Listen for'), h('dd', {}, host.auditionFor)), btn);
  });
  info.append(
    h('div', {}, s.tone), h('div', { class: 'dial-vibe' }, `${c.windowNote} Talk about ${Math.round(c.talkShare * 100)}% of the time, ${s.breaksPerHour} breaks an hour, up to ${s.maxBreakSec} s each.`),
    ...hosts, note);
}
