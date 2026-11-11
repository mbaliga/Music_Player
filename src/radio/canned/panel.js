// ─────────────────────────────────────────────────────────────────────────────
// panel.js — the on-screen card for a canned station: the persistent "Pre-written show" label, now-playing, live captions with
// the speaking person's name (callers and skits marked "bit"), Skip, Stop (signs off first, a second tap stops at once), and the
// cast's voices. Browser glue only; styles and the element helper come from the You Radio panel so the two cards match.
// ─────────────────────────────────────────────────────────────────────────────

import { ensureStyles, el } from '../offline/panel.js';

const CSS = `
.pw-label .ai-dot{background:var(--violet)}
.pw-cap-bit{display:inline-block;margin-left:6px;padding:0 6px;border-radius:8px;border:1px solid var(--border);font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--ink2);vertical-align:1px}
.pw-voice-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:8px;align-items:center;margin-top:8px;font-size:13px}
.pw-voice-row span{min-width:0}
.pw-voice-row small{display:block;color:var(--ink2);font-size:11px}
.pw-voice-row select{min-width:0;padding:6px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);color:var(--ink);font:inherit;font-size:13px}
.pw-reset{margin-top:8px;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);color:var(--ink);font:inherit;font-size:12px;cursor:pointer}
`;
let styled2 = false;
function ensureCss(doc) { if (styled2) return; styled2 = true; const s = doc.createElement('style'); s.setAttribute('data-pw-panel', ''); s.textContent = CSS; doc.head.append(s); }

/** Mount the card into `container` for a canned `session`. Returns unmount(). `onStop(immediate)` is the host UI's stop hook. */
export function mountCannedPanel(container, session, { onStop, doc = document, station = null } = {}) {
  ensureStyles(doc); ensureCss(doc);
  container.replaceChildren();
  container.classList.remove('hidden');
  const title = el(doc, 'div', { class: 'ai-now-title' }, 'Tuning in…');
  const sub = el(doc, 'div', { class: 'ai-now-sub' }, '');
  const stationLine = el(doc, 'div', { class: 'ai-now-sub', 'data-pw-station': '' }, station && station.name ? `${station.name}${station.dial ? ` · ${station.dial}` : ''}` : '');
  const caps = el(doc, 'div', { class: 'ai-captions', 'aria-live': 'polite', 'aria-label': 'What the hosts are saying' });
  const note = el(doc, 'div', { class: 'ai-note', role: 'status' });
  const skip = el(doc, 'button', { type: 'button', 'data-act': 'skip', onclick: () => session.skip() }, 'Skip');
  let signing = false;
  const stop = el(doc, 'button', { type: 'button', 'data-act': 'stop', onclick: () => {
    if (onStop) return onStop(signing);
    if (signing) session.stop(); else session.signOff();
  } }, 'Stop');
  const voicesBody = el(doc, 'div', { 'data-voices': '' });
  const voices = el(doc, 'details', { class: 'ai-voices' }, el(doc, 'summary', {}, 'Cast and voices'), voicesBody);
  const label = el(doc, 'div', { class: 'ai-label pw-label', role: 'note', 'data-pw-label': '' },
    el(doc, 'span', { class: 'ai-dot' }), 'Pre-written show', el(doc, 'small', {}, ' · fixed scripts, read by this phone’s voice; your own songs between'));
  container.append(el(doc, 'div', { class: 'ai-card' }, label, el(doc, 'div', {}, stationLine, title, sub), caps, note, el(doc, 'div', { class: 'ai-controls' }, skip, stop), voices));

  let lines = [];
  const renderCaps = () => {
    caps.replaceChildren(...lines.slice(-3).map((l, i, a) => el(doc, 'div', { class: `ai-cap ${l.live ? 'live' : i === a.length - 1 ? '' : 'old'}${l.idle ? ' idle' : ''}`.trim() },
      el(doc, 'b', {}, `${l.name}:`), l.text, l.bit ? el(doc, 'span', { class: 'pw-cap-bit', title: 'A scripted bit, not a real caller' }, 'bit') : null)));
  };

  const fillVoices = () => {
    const pack = session.pack;
    if (!pack) return;
    const list = session.voice.voices();
    const assign = session.voiceAssignment().byHost || {};
    const rows = pack.hostList.map((h) => {
      const a = assign[h.id] || {};
      const sel = el(doc, 'select', { 'aria-label': `${h.name} voice`, 'data-host': h.id, disabled: list.length ? null : 'true' });
      sel.append(el(doc, 'option', { value: '' }, 'Automatic'));
      for (const v of list) { const o = el(doc, 'option', { value: v.id }, `${v.name}${v.lang ? ` (${v.lang})` : ''}`); if (session.voicePrefs()[h.id] === v.id) o.selected = true; sel.append(o); }
      sel.addEventListener('change', () => { session.setHostVoice(h.id, sel.value); fillVoices(); });
      return el(doc, 'div', { class: 'pw-voice-row' }, el(doc, 'span', {}, h.name, el(doc, 'small', {}, `${h.role}${a.voiceName ? ` · ${a.voiceName}` : ''}${a.shared ? ' · shared voice, told apart by pitch' : ''}`)), sel);
    });
    const reset = el(doc, 'button', { class: 'pw-reset', type: 'button', onclick: () => { session.resetVoices(); fillVoices(); } }, 'Automatic voices');
    const view = session.getView();
    voicesBody.replaceChildren(
      el(doc, 'div', { class: 'ai-note' }, view.recordings ? 'This station has recorded voices; the phone’s voice is the back-up.' : (list.length ? 'Each person gets the closest voice this phone has; voices that have to be shared are told apart by pitch and pace.' : 'No English voices were reported by this device; everyone uses the default voice, told apart by pitch and pace.')),
      ...rows, reset);
  };

  const off = session.onEvent((e) => {
    if (e.type === 'now') { title.textContent = e.track.title || 'Unknown title'; sub.textContent = [e.track.artist, e.track.album].filter((x) => x && !/^unknown/i.test(x)).join(' · '); fillVoices(); }
    else if (e.type === 'caption') { lines = lines.map((l) => ({ ...l, live: false })); lines.push({ name: e.name, text: e.text, live: true, bit: !!e.bit }); if (lines.length > 12) lines.shift(); renderCaps(); }
    else if (e.type === 'caption-clear') { lines = lines.map((l) => ({ ...l, live: false })); renderCaps(); }
    else if (e.type === 'caption-fade') { lines = lines.map((l) => ({ ...l, live: false, idle: true })); renderCaps(); }
    else if (e.type === 'notice') { note.textContent = e.text; note.classList.add('warn'); }
    else if (e.type === 'signing-off') { signing = true; stop.textContent = 'Stop now'; note.textContent = 'Signing off…'; note.classList.remove('warn'); }
    else if (e.type === 'pack') { stationLine.textContent = `${e.pack.name}${e.pack.dial ? ` · ${e.pack.dial}` : ''}`; fillVoices(); }
    else if (e.type === 'state') {
      if (e.phase === 'empty' && e.error) { note.textContent = e.error.message; note.classList.remove('warn'); title.textContent = 'Nothing to play yet'; skip.disabled = true; }
      else if (e.phase === 'error' && e.error) { note.textContent = e.error.message; note.classList.add('warn'); }
      else if (e.phase === 'playing' && e.speech === 'off') { note.textContent = session.voice.unavailableReason === 'no_local_voice' ? 'No offline voice on this device. Music only.' : 'Music only: this station’s talk is switched off on this device.'; note.classList.add('warn'); }
      else if (e.phase === 'starting') { note.textContent = ''; skip.disabled = false; }
    }
  });
  session.voice.init?.().then(fillVoices).catch(() => {});
  const onVis = () => { try { session.setBackground(doc.hidden); } catch { /* */ } };
  doc.addEventListener('visibilitychange', onVis);

  return function unmount() {
    off();
    doc.removeEventListener('visibilitychange', onVis);
    container.replaceChildren();
    container.classList.add('hidden');
  };
}
