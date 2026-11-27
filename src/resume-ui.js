// resume-ui.js — the small "Resume" chip on the Albums page: shown when the last record was put back on the platter paused.
// DOM only; the app decides when to show / hide it and what a tap does.
export function mountResumeChip(host, { onTap } = {}) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'rs-chip'; b.id = 'resumeChip'; b.hidden = true;
  const ic = document.createElement('span'); ic.className = 'rs-ic'; ic.setAttribute('aria-hidden', 'true'); ic.textContent = '▶';
  const tx = document.createElement('span'); tx.className = 'rs-tx';
  b.append(ic, tx);
  b.addEventListener('click', () => { try { onTap && onTap(); } catch { /* */ } });
  host.appendChild(b);
  return {
    el: b,
    show({ title = '', time = '' } = {}) { tx.textContent = time ? `Resume ${time}` : 'Resume'; b.setAttribute('aria-label', `Resume ${title || 'where you left off'}${time ? ' at ' + time : ''}`); b.hidden = false; },
    hide() { b.hidden = true; },
    get shown() { return !b.hidden; },
  };
}
