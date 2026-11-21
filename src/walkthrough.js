// walkthrough.js — first-run tour. Plain DOM, no deps. A short card overlay: five steps, plain words, Skip always on screen.

import { BOOTH_LABEL } from './shell/sections.js';

// highlight: 'hamburger' draws a ring around the menu button (above the dim backdrop; the card never covers it, see .wt-overlay padding).
export const STEPS = [
  {
    logo: true,
    title: 'Welcome to Runout',
    body: 'Your own music, played on a record player, a stack of cassettes and a radio dial. This takes a minute.',
  },
  {
    title: 'Find your way around',
    body: `Drag from the left edge of the screen, or tap the menu button, to open the menu: Albums, Mixtapes, Radio, ${BOOTH_LABEL} and Settings. Your music keeps playing while you look around.`,
    highlight: 'hamburger',
  },
  {
    title: 'Albums',
    body: 'Your records and CDs on a turntable. Tap play, then drag the record to scratch it. Pinch two fingers together to see your whole library; spread them to come back.',
  },
  {
    title: `Mixtapes, Radio and ${BOOTH_LABEL}`,
    body: `Mixtapes are cassettes you fill with your own songs. Radio has live stations and shows that talk between songs. ${BOOTH_LABEL} adds effects to the record you are playing.`,
  },
  {
    title: 'The lock key',
    body: 'The padlock at the top right locks the screen, so a stray touch does nothing while the music plays. Hold it for a second to unlock. Help is always in the menu.',
  },
];

export class Walkthrough {
  constructor() {
    this._step = 0;
    this._el = null;
  }

  showIfFirstRun() {
    if (!localStorage.getItem('runout.wtDone')) {
      setTimeout(() => this.show(0), 900);
    }
  }

  show(step = 0) {
    this._step = step;
    if (!this._el) this._build();
    this._el.classList.remove('hidden');
    this._render();
    // Scroll panel into view
    this._el.querySelector('.wt-card').scrollTop = 0;
  }

  /** A pulsing ring around the visible hamburger (above the backdrop) for the step that explains it. */
  _ring(on) {
    if (!this._ringEl) { this._ringEl = document.createElement('div'); this._ringEl.className = 'wt-ring hidden'; document.body.appendChild(this._ringEl); }
    const hb = document.querySelector('.page:not([hidden]) .hamburger');
    if (!on || !hb) { this._ringEl.classList.add('hidden'); return; }
    const r = hb.getBoundingClientRect();
    Object.assign(this._ringEl.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    this._ringEl.classList.remove('hidden');
  }

  hide() {
    this._ringEl?.classList.add('hidden');
    this._el?.classList.add('hidden');
    localStorage.setItem('runout.wtDone', '1');
  }

  _build() {
    const el = document.createElement('div');
    el.className = 'wt-overlay hidden';
    el.innerHTML = `
      <div class="wt-card" role="dialog" aria-modal="true" aria-label="Walkthrough">
        <button class="wt-x" type="button" aria-label="Close tour">✕</button>
        <div class="wt-icon"></div>
        <h2 class="wt-title"></h2>
        <p class="wt-body"></p>
        <footer class="wt-foot">
          <div class="wt-dots" aria-hidden="true"></div>
          <div class="wt-nav">
            <button class="wt-skip" type="button">Skip</button>
            <span class="wt-sp"></span>
            <button class="wt-prev" type="button">Back</button>
            <button class="wt-next" type="button">Next</button>
          </div>
        </footer>
      </div>`;
    document.body.appendChild(el);
    this._el = el;

    el.querySelector('.wt-x').addEventListener('click', () => this.hide());
    el.querySelector('.wt-skip').addEventListener('click', () => this.hide());
    el.addEventListener('click', (e) => { if (e.target === el) this.hide(); });
    el.querySelector('.wt-prev').addEventListener('click', () => {
      if (this._step > 0) { this._step--; this._render(); }
    });
    el.querySelector('.wt-next').addEventListener('click', () => {
      if (this._step < STEPS.length - 1) { this._step++; this._render(); }
      else this.hide();
    });

    // Swipe left/right
    let sx = null;
    el.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (sx === null) return;
      const dx = e.changedTouches[0].clientX - sx;
      sx = null;
      if (Math.abs(dx) < 40) return;
      if (dx < 0 && this._step < STEPS.length - 1) { this._step++; this._render(); }
      else if (dx > 0 && this._step > 0) { this._step--; this._render(); }
    }, { passive: true });
  }

  _render() {
    const s = STEPS[this._step];
    const card = this._el.querySelector('.wt-card');
    const icon = card.querySelector('.wt-icon');
    if (s.logo) { icon.replaceChildren(Object.assign(document.createElement('img'), { className: 'wt-logo', src: './assets/icon-192.png', alt: 'Runout', width: 64, height: 64 })); }
    else icon.replaceChildren();
    this._ring(s.highlight === 'hamburger');
    card.querySelector('.wt-title').textContent = s.title;
    card.querySelector('.wt-body').textContent = s.body;
    card.setAttribute('aria-label', `Tour, step ${this._step + 1} of ${STEPS.length}`);

    const next = card.querySelector('.wt-next');
    next.textContent = this._step === STEPS.length - 1 ? 'Let\u2019s go' : 'Next';
    card.querySelector('.wt-prev').style.visibility = this._step === 0 ? 'hidden' : '';

    card.querySelector('.wt-dots').innerHTML = STEPS.map((_, i) =>
      `<span class="wt-dot${i === this._step ? ' on' : ''}"></span>`
    ).join('');

    card.scrollTop = 0;
  }
}
