// walkthrough.js — first-run tour. Plain DOM, no deps. A short card overlay: five steps, plain words, Skip always on screen.

import { trapFocus } from './ui/focus-trap.js';
import { BOOTH_LABEL } from './shell/sections.js';

// highlight: 'hamburger' draws a ring around the menu button (above the dim backdrop; the card never covers it, see .wt-overlay padding).
export const STEPS = [
  {
    logo: true,
    title: 'Welcome to Runout',
    body: 'Your own music on a record player, a stack of cassettes and a radio dial.',
  },
  {
    title: 'Find your way around',
    body: `Tap the menu button for Albums, Mixtapes, Radio, ${BOOTH_LABEL} and Settings. Or drag in from the left edge.`,
    highlight: 'hamburger',
  },
  {
    title: 'Albums',
    body: 'Tap Library, pick an album, press Play. Drag the record to scratch. Pinch two fingers together to open the library.',
  },
  {
    title: `Mixtapes, Radio and ${BOOTH_LABEL}`,
    body: `Mixtapes are cassettes of your own songs. Radio plays live stations and shows. ${BOOTH_LABEL} adds effects to what is playing.`,
  },
  {
    title: 'Keep listening',
    body: 'Your music keeps playing when the screen is off. Padlock = ignore touches: hold it a second to unlock.',
    cta: true,   // the last card offers to scan the music (Walkthrough({ onScan, scanLabel }))
  },
];

export class Walkthrough {
  /** opts: { onScan(), scanLabel, hasMusic() } — the last card's button ('Choose music folder' on the web, 'Scan my music' on the phone); hidden once there is music. */
  constructor(opts = {}) {
    this._step = 0;
    this._el = null;
    this._o = opts;
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
    if (!this._release) this._release = trapFocus(this._el.querySelector('.wt-card'), { initial: this._el.querySelector('.wt-next'), onEscape: () => this.hide() });
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
    if (this._release) { const r = this._release; this._release = null; r(); }
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
        <div class="wt-cta" hidden><button class="wt-scan" type="button"></button></div>
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
    el.querySelector('.wt-scan').addEventListener('click', () => { const f = this._o.onScan; this.hide(); if (f) { try { f(); } catch { /* the scan reports its own errors */ } } });
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
    const cta = card.querySelector('.wt-cta'), want = !!(s.cta && this._o.onScan && !(this._o.hasMusic && this._o.hasMusic()));
    cta.hidden = !want;
    if (want) card.querySelector('.wt-scan').textContent = this._o.scanLabel || 'Choose music folder';
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
