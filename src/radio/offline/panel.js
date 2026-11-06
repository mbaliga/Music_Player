// ─────────────────────────────────────────────────────────────────────────────
// panel.js — the You station's on-screen card: the "Automated host" disclosure, now-playing card, live captions of
// what the hosts say, skip / stop, the host-voice pickers, and plain-language notices (empty library, speech off).
// Browser glue only; every decision lives in show-state.js / show-runner.js. Styles are injected here (one <style>)
// so the shared index.html is untouched.
// ─────────────────────────────────────────────────────────────────────────────

const CSS = `
.ai-card{display:flex;flex-direction:column;gap:10px;margin:10px 0 4px;padding:12px;border-radius:12px;background:var(--surface);border:1px solid var(--border);color:var(--ink)}
.ai-card.hidden{display:none}
.ai-label{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink2)}
.ai-label .ai-dot{width:8px;height:8px;border-radius:50%;background:var(--secondary);flex:0 0 auto}
.ai-label small{font-weight:400;letter-spacing:0;text-transform:none}
.ai-now-title{font-size:16px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ai-now-sub{font-size:13px;color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ai-captions{min-height:3.2em;display:flex;flex-direction:column;gap:4px;font-size:14px;line-height:1.35}
.ai-cap{color:var(--ink2);transition:color .2s,opacity .4s}
.ai-cap b{font-weight:700;margin-right:6px}
.ai-cap.live{color:var(--ink)}
.ai-cap.old{opacity:.55}
.ai-cap.idle{opacity:.4}
.ai-controls{display:flex;gap:8px}
.ai-controls button{flex:1;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface2);color:var(--ink);font:inherit;font-size:14px;cursor:pointer}
.ai-controls button:disabled{opacity:.5;cursor:default}
.ai-voices summary{cursor:pointer;font-size:13px;color:var(--ink2)}
.ai-voices label{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px}
.ai-voices select{flex:1;min-width:0;padding:6px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);color:var(--ink);font:inherit;font-size:13px}
.ai-note{font-size:13px;color:var(--ink2)}
.ai-note:empty{display:none}
.ai-note.warn{color:#f5c542}
`;

let styled = false;
function ensureStyles(doc) {
  if (styled) return;
  styled = true;
  const s = doc.createElement('style');
  s.setAttribute('data-ai-panel', '');
  s.textContent = CSS;
  doc.head.append(s);
}

const el = (doc, tag, props = {}, ...kids) => {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
};

/**
 * Mount the card into `container` for `session` (a station-session.js session). Returns unmount().
 * `onStop` is called when the user taps Stop (the host UI stops the session and tidies its own state).
 */
export function mountYouPanel(container, session, { onStop, doc = document } = {}) {
  ensureStyles(doc);
  container.replaceChildren();
  container.classList.remove('hidden');
  const title = el(doc, 'div', { class: 'ai-now-title' }, 'Tuning in…');
  const sub = el(doc, 'div', { class: 'ai-now-sub' }, '');
  const caps = el(doc, 'div', { class: 'ai-captions', 'aria-live': 'polite', 'aria-label': 'What the hosts are saying' });
  const note = el(doc, 'div', { class: 'ai-note', role: 'status' });
  const skip = el(doc, 'button', { type: 'button', 'data-act': 'skip', onclick: () => session.skip() }, 'Skip');
  const stop = el(doc, 'button', { type: 'button', 'data-act': 'stop', onclick: () => (onStop ? onStop() : session.stop()) }, 'Stop');
  const selA = el(doc, 'select', { 'aria-label': 'Host one voice', 'data-host': 'a' });
  const selB = el(doc, 'select', { 'aria-label': 'Host two voice', 'data-host': 'b' });
  const voices = el(doc, 'details', { class: 'ai-voices' }, el(doc, 'summary', {}, 'Host voices'),
    el(doc, 'label', {}, 'Casey', selA), el(doc, 'label', {}, 'Jo', selB),
    el(doc, 'div', { class: 'ai-note', 'data-voice-note': '' }));
  const label = el(doc, 'div', { class: 'ai-label', role: 'note', 'data-ai-label': '' },
    el(doc, 'span', { class: 'ai-dot' }), 'Automated host', el(doc, 'small', {}, ' · lines written on your phone, read by its built-in voice'));
  container.append(el(doc, 'div', { class: 'ai-card' }, label, el(doc, 'div', {}, title, sub), caps, note, el(doc, 'div', { class: 'ai-controls' }, skip, stop), voices));

  let lines = [];
  const renderCaps = () => {
    caps.replaceChildren(...lines.slice(-3).map((l, i, a) => el(doc, 'div', { class: `ai-cap ${l.live ? 'live' : i === a.length - 1 ? '' : 'old'}${l.idle ? ' idle' : ''}`.trim() }, el(doc, 'b', {}, `${l.name}:`), l.text)));
  };

  const fillVoices = () => {
    const list = session.voice.voices();
    const hosts = session.voice.hosts();
    for (const [sel, who] of [[selA, 'a'], [selB, 'b']]) {
      sel.replaceChildren(...(list.length ? list : [{ id: '', name: 'System default' }]).map((v) => {
        const o = el(doc, 'option', { value: v.id }, `${v.name}${v.lang ? ` (${v.lang})` : ''}`);
        if (v.id === hosts[who]) o.selected = true;
        return o;
      }));
      sel.disabled = !list.length;
    }
    voices.querySelector('[data-voice-note]').textContent = list.length
      ? 'Pick a voice for each host. If both are the same voice they are told apart by pitch.'
      : 'No English voices were reported by this device; the hosts use the system default.';
  };
  const onPick = (who) => (e) => { session.voice.setHost(who, e.target.value); session.saveVoices(); };
  selA.addEventListener('change', onPick('a'));
  selB.addEventListener('change', onPick('b'));

  const off = session.onEvent((e) => {
    if (e.type === 'now') { title.textContent = e.track.title || 'Unknown title'; sub.textContent = [e.track.artist, e.track.album].filter((x) => x && !/^unknown/i.test(x)).join(' · '); fillVoices(); }
    else if (e.type === 'caption') { lines = lines.map((l) => ({ ...l, live: false })); lines.push({ name: e.name, text: e.text, live: true }); if (lines.length > 12) lines.shift(); renderCaps(); }
    else if (e.type === 'caption-clear') { lines = lines.map((l) => ({ ...l, live: false })); renderCaps(); }
    else if (e.type === 'caption-fade') { lines = lines.map((l) => ({ ...l, live: false, idle: true })); renderCaps(); }
    else if (e.type === 'notice') { note.textContent = e.text; note.classList.add('warn'); }
    else if (e.type === 'state') {
      if (e.phase === 'empty' && e.error) { note.textContent = e.error.message; note.classList.remove('warn'); title.textContent = 'Nothing to play yet'; skip.disabled = true; }
      else if (e.phase === 'error' && e.error) { note.textContent = e.error.message; note.classList.add('warn'); }
      else if (e.phase === 'playing' && e.speech === 'off') { note.textContent = session.voice.available ? 'Music only: the hosts are staying quiet.' : 'This device reported no speech engine, so the hosts will stay quiet. Music only.'; note.classList.add('warn'); }
      else if (e.phase === 'starting') { note.textContent = ''; skip.disabled = false; }
    }
  });
  session.voice.init?.().then(fillVoices).catch(() => {});
  fillVoices();

  const onVis = () => { try { session.setBackground(doc.hidden); } catch { /* */ } };
  doc.addEventListener('visibilitychange', onVis);

  return function unmount() {
    off();
    doc.removeEventListener('visibilitychange', onVis);
    container.replaceChildren();
    container.classList.add('hidden');
  };
}
