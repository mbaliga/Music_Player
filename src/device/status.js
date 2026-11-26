// ─────────────────────────────────────────────────────────────────────────────
// status.js — the scan state shown to the user: a DOM-free `scanStatus` object, the copy for each
// state (describeStatus, pure), and a tiny `mountScanCard(container, deps)` helper the library view
// mounts in its empty / scanning state. Library UI code never imports Capacitor; it mounts this.
//
//   scanStatus.get()        -> { phase, permission, found, processed, total, tagged, taggingTotal, error, lastScanAt, trackCount }
//   scanStatus.subscribe(fn)-> unsubscribe (fn(state))
//   describeStatus(state)   -> { show, title, body, progress (0..1|null), action: 'allow'|'settings'|'retry'|null, actionLabel }
//   mountScanCard(el, { status, onAllow, onOpenSettings, onRetry, document })  -> { destroy() }
//
// phases: 'unavailable' (not the Android app: the folder picker stays) | 'needs-permission' | 'denied'
//   (asked once, can ask again) | 'blocked' (permanently denied: only app settings can fix it) |
//   'idle' | 'scanning' | 'tagging' | 'error'
// ─────────────────────────────────────────────────────────────────────────────

export const PHASES = Object.freeze(['unavailable', 'needs-permission', 'denied', 'blocked', 'idle', 'scanning', 'tagging', 'error']);

export function createScanStatus(initial = {}) {
  let s = Object.freeze({
    phase: 'unavailable', permission: 'unknown', found: 0, processed: 0, total: 0, tagged: 0, taggingTotal: 0,
    error: '', lastScanAt: 0, trackCount: 0, ...initial,
  });
  const subs = new Set();
  return {
    get: () => s,
    set(patch) {
      const next = { ...s, ...patch };
      if (Object.keys(next).every((k) => next[k] === s[k])) return s;
      s = Object.freeze(next);
      for (const fn of [...subs]) { try { fn(s); } catch { /* subscriber errors must not break the scan */ } }
      return s;
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

export function describeStatus(s) {
  switch (s.phase) {
    case 'needs-permission':
      return { show: true, title: 'Play the music on this phone', body: 'Runout plays the music on your phone. Allow access to your audio files.', progress: null, action: 'allow', actionLabel: 'Allow' };
    case 'denied':
      return { show: true, title: 'Audio access is off', body: 'Runout can only play your music with access to your audio files. You can allow it now.', progress: null, action: 'allow', actionLabel: 'Allow' };
    case 'blocked':
      return { show: true, title: 'Audio access is blocked', body: 'Android will not ask again. Open Runout’s settings, choose Permissions, and allow Music and audio.', progress: null, action: 'settings', actionLabel: 'Open settings' };
    case 'scanning': {
      const found = s.total || s.found;
      return {
        show: true, title: `Found ${fmt(found)} tracks…`,
        body: s.total ? `${fmt(s.processed)} of ${fmt(s.total)} read` : 'Looking through your audio files',
        progress: s.total ? Math.min(1, s.processed / s.total) : null, action: null, actionLabel: '',
      };
    }
    case 'tagging':
      return { show: true, title: 'Reading tags…', body: `${fmt(s.tagged)} of ${fmt(s.taggingTotal)} untagged files`, progress: s.taggingTotal ? Math.min(1, s.tagged / s.taggingTotal) : null, action: null, actionLabel: '' };
    case 'error':
      return { show: true, title: 'Could not read your music', body: s.error || 'Something went wrong while scanning.', progress: null, action: 'retry', actionLabel: 'Try again' };
    case 'idle':
      if (!s.trackCount) return { show: true, title: 'No music found', body: 'Nothing on this phone matched your filters (tracks under the minimum length and system sounds are hidden).', progress: null, action: 'retry', actionLabel: 'Scan now' };
      return { show: false, title: `${plural(s.trackCount, 'track', 'tracks')}`, body: '', progress: null, action: null, actionLabel: '' };
    default:
      return { show: false, title: '', body: '', progress: null, action: null, actionLabel: '' };
  }
}

const CSS = `
.dv-host{position:absolute;left:0;right:0;top:34%;padding:0 16px;z-index:30;pointer-events:none}
@media (orientation:landscape){.dv-host{right:auto;left:3.5%;top:22%;width:46%;max-width:380px;padding:0}}
.dv-host .dv-card{pointer-events:auto;background:color-mix(in srgb,var(--surface,#0d0d12) 94%,transparent)}
.dv-card{margin:12px auto;max-width:420px;padding:16px 18px;border-radius:var(--rx,12px);background:var(--surface,#0d0d12);border:1px solid var(--border,rgba(255,255,255,.07));color:var(--ink,#e8e8f0);text-align:center;font-size:13px;line-height:1.5}
.dv-card[hidden]{display:none}
.dv-title{font-size:15px;font-weight:700;margin-bottom:4px}
.dv-body{color:var(--ink2,rgba(232,232,240,.64));margin-bottom:12px}
.dv-body:last-child{margin-bottom:0}
.dv-bar{height:4px;border-radius:2px;background:var(--surface2,#16161e);overflow:hidden;margin:6px 0 2px}
.dv-bar>i{display:block;height:100%;width:0;background:var(--secondary,#8E7BFF);transition:width .2s}
.dv-bar.indet>i{width:35%;animation:dv-slide 1.2s ease-in-out infinite}
@keyframes dv-slide{0%{margin-left:-35%}100%{margin-left:100%}}
.dv-btn{padding:9px 22px;font-size:13px}
@media (prefers-reduced-motion:reduce){.dv-bar.indet>i{animation:none;width:100%;opacity:.4}}
`;

/** Mount the card into `container`. It re-renders on every status change and hides itself when there is nothing to say. */
export function mountScanCard(container, { status, onAllow, onOpenSettings, onRetry, document: doc } = {}) {
  const d = doc || container.ownerDocument || globalThis.document;
  if (!d.getElementById('dv-card-css')) {
    const st = d.createElement('style'); st.id = 'dv-card-css'; st.textContent = CSS;
    (d.head || d.documentElement).appendChild(st);
  }
  const card = d.createElement('div');
  card.className = 'dv-card'; card.setAttribute('role', 'status'); card.setAttribute('aria-live', 'polite');
  container.appendChild(card);

  const handlers = { allow: onAllow, settings: onOpenSettings, retry: onRetry };
  function render(s) {
    const v = describeStatus(s);
    card.hidden = !v.show;
    card.textContent = '';
    if (!v.show) return;
    const t = d.createElement('div'); t.className = 'dv-title'; t.textContent = v.title; card.appendChild(t);
    if (v.body) { const b = d.createElement('div'); b.className = 'dv-body'; b.textContent = v.body; card.appendChild(b); }
    if (v.progress !== null || s.phase === 'scanning') {
      const bar = d.createElement('div'); bar.className = 'dv-bar' + (v.progress === null ? ' indet' : '');
      const i = d.createElement('i'); if (v.progress !== null) i.style.width = `${Math.round(v.progress * 100)}%`;
      bar.appendChild(i); card.appendChild(bar);
    }
    if (v.action) {
      const btn = d.createElement('button'); btn.type = 'button'; btn.className = 'sort-chip active dv-btn'; btn.textContent = v.actionLabel;
      btn.addEventListener('click', () => { btn.disabled = true; try { handlers[v.action]?.(); } finally { setTimeout(() => { btn.disabled = false; }, 400); } });
      card.appendChild(btn);
    }
  }
  render(status.get());
  const off = status.subscribe(render);
  return { destroy() { off(); card.remove(); }, element: card };
}
