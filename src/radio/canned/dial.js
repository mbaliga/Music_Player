// ─────────────────────────────────────────────────────────────────────────────
// dial.js — "the dial": the station picker section of the Radio tab. Browser glue over catalog.js (pure).
//
//   Pre-written shows   the six canned stations as cards (name, dial number, tagline, vibe, host chips, about N minutes of
//                       talk, a "Pre-written show" badge, a daypart badge that only orders and hints). Tap = start. Star = favourite.
//   AI station styles   only with the radio.ai flag on: the five bible styles as GREYED cards, "Needs internet — coming soon".
//                       Tap = style info and a "hear a host" audition through the phone's voice. Never startable yet.
// Loaded lazily from the Radio tab (radio-player.js), never from boot. Real stations and You Radio stay in radio-player.js.
// ─────────────────────────────────────────────────────────────────────────────

import { buildCatalog, PRE_WRITTEN_LABEL, NEEDS_INTERNET } from './catalog.js';
import { hostProsody } from './ai-styles.js';
import { loadStationsIndex } from './session.js';
import { createAuditioner } from './audition.js';

const CSS = `
.dial-sec{margin-bottom:14px}
.dial-sub{font-size:12px;color:var(--ink2);margin:0 2px 8px;line-height:1.35}
.dial-cards{display:flex;flex-direction:column;gap:10px}
.dial-card{position:relative;padding:12px;border-radius:12px;background:var(--surface);border:1px solid var(--border);color:var(--ink);cursor:pointer;text-align:left}
.dial-card.on{border-color:var(--violet);box-shadow:0 0 0 1px var(--violet) inset}
.dial-card:has(.dial-play:focus-visible){outline:2px solid var(--violet);outline-offset:2px}
.dial-card.grey{opacity:.62;cursor:pointer}
.dial-play{display:block;width:100%;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dial-play:focus{outline:none}
.dial-play::after{content:"";position:absolute;inset:0;border-radius:12px}
.dial-card .dial-info{position:relative;z-index:1;cursor:auto}
.dial-top{display:flex;align-items:baseline;gap:8px;padding-right:44px}
.dial-name{font-size:16px;font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis}
.dial-num{font-size:12px;font-weight:700;color:var(--ink2);border:1px solid var(--border);border-radius:8px;padding:0 6px;white-space:nowrap}
.dial-tag{font-size:14px;margin-top:3px}
.dial-vibe{font-size:12px;color:var(--ink2);margin-top:4px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dial-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.dial-chip{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--surface2);border:1px solid var(--border);color:var(--ink)}
.dial-chip.dim{color:var(--ink2)}
.dial-meta{display:flex;flex-wrap:wrap;gap:6px 10px;margin-top:8px;font-size:11px;color:var(--ink2);align-items:center}
.dial-badge{font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--ink)}
.dial-badge.soon{color:var(--ink2)}
.dial-star{position:absolute;top:0;right:0;z-index:2;width:44px;height:44px;margin:0}
.dial-bar{height:6px;border-radius:3px;background:var(--surface2);overflow:hidden;margin-top:8px;display:flex}
.dial-bar i{display:block;height:100%;background:var(--violet)}
.dial-bar b{display:block;height:100%;background:var(--border)}
.dial-info{margin-top:10px;font-size:13px;line-height:1.4;border-top:1px solid var(--border);padding-top:10px}
.dial-info dl{margin:6px 0 0;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:12px}
.dial-info dt{color:var(--ink2)}
.dial-info dd{margin:0}
.dial-host{margin-top:8px;padding:8px;border-radius:8px;background:var(--surface2)}
.dial-host button{margin-top:6px;min-height:40px;padding:6px 14px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--ink);font:inherit;font-size:12px;cursor:pointer}
.dial-aud{min-height:1.2em;font-size:12px;color:var(--ink2);margin-top:4px}
`;
let styled = false;
function ensureStyles() { if (styled || typeof document === 'undefined') return; styled = true; const s = document.createElement('style'); s.setAttribute('data-dial', ''); s.textContent = CSS; document.head.append(s); }

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
  ensureStyles();
  const baseUrl = ctx.baseUrl || document.baseURI;
  const fetchFn = ctx.fetchFn || ((u, o) => fetch(u, o));
  const index = await loadStationsIndex({ fetchFn, baseUrl });
  try { if (ctx.onIndex) ctx.onIndex(index); } catch { /* saved-list refresh is best effort */ }
  const hour = Number.isFinite(ctx.hour) ? ctx.hour : new Date().getHours();
  const cat = buildCatalog({ index, flagOn: ctx.aiOn(), hour, cloudAvailable: false });
  const kids = [];

  if (cat.canned.length) {
    kids.push(h('section', { class: 'dial-sec', 'data-sec': 'canned' },
      h('div', { class: 'radio-sec-head' }, h('span', {}, 'Pre-written shows')),
      h('p', { class: 'dial-sub' }, 'Fictional stations with hosts who talk between your own songs. Written in advance, so they work with no internet. The stations that suit this time of day are listed first.'),
      h('div', { class: 'dial-cards' }, cat.canned.map((c) => cannedCard(c, ctx)))));
  } else {
    kids.push(h('section', { class: 'dial-sec', 'data-sec': 'canned' }, h('div', { class: 'radio-sec-head' }, h('span', {}, 'Pre-written shows')),
      h('p', { class: 'dial-sub' }, 'The station list could not be loaded.')));
  }
  if (cat.styles.length) {
    kids.push(h('section', { class: 'dial-sec', 'data-sec': 'styles' },
      h('div', { class: 'radio-sec-head' }, h('span', {}, 'AI station styles')),
      h('p', { class: 'dial-sub' }, 'These need an internet connection and are not available yet. Tap one to read about it and hear its hosts through this phone’s voice.'),
      h('div', { class: 'dial-cards' }, cat.styles.map((c) => styleCard(c, ctx)))));
  }
  root.replaceChildren(...kids);
  return { canned: cat.canned.length, styles: cat.styles.length };
}

function cannedCard(c, ctx) {
  const st = c.station;
  const fav = ctx.isFav(st);
  const star = h('button', { class: 'radio-star dial-star' + (fav ? ' on' : ''), type: 'button', 'aria-pressed': String(fav), 'aria-label': (fav ? 'Remove ' : 'Add ') + c.name + (fav ? ' from favourites' : ' to favourites'),
    onclick: (e) => { e.stopPropagation(); ctx.toggleFav(st); } }, fav ? '★' : '☆');
  const tagId = `dial-tag-${c.id}`;
  // A plain container: the ONE real <button> is the station name, stretched over the card (::after) so the whole card plays it;
  // the star is a sibling above the overlay (44 px hit area, no taller card), so a missed star tap can only miss, never start.
  return h('div', { class: 'dial-card' + (ctx.isCurrent(st) ? ' on' : ''), 'data-k': c.key, 'data-station': c.id },
    h('div', { class: 'dial-top' },
      h('button', { class: 'dial-play', type: 'button', 'aria-label': `Play ${c.name}, dial ${c.dial}`, 'aria-describedby': tagId, onclick: () => ctx.play(st) },
        h('span', { class: 'dial-name' }, c.name), ' ', h('span', { class: 'dial-num' }, c.dial))),
    h('div', { class: 'dial-tag', id: tagId }, c.tagline),
    h('div', { class: 'dial-vibe' }, c.vibe),
    h('div', { class: 'dial-chips' }, c.hostChips.map((x) => h('span', { class: 'dial-chip', title: x.role }, x.name)), c.castCount ? h('span', { class: 'dial-chip dim' }, `+${c.castCount} more voices`) : null),
    h('div', { class: 'dial-meta' }, h('span', { class: 'dial-badge' }, PRE_WRITTEN_LABEL), h('span', {}, `about ${c.minutes} min of talk`), h('span', { 'data-daypart': c.inDaypart ? 'fit' : 'other' }, c.daypartBadge)),
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
