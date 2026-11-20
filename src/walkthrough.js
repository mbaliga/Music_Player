// walkthrough.js — first-run onboarding. Plain DOM, no deps.
// Shows a full-screen card overlay step by step, explaining every concept
// in plain English — including latency and how to feel-test it on-device.

import { BOOTH_LABEL } from './shell/sections.js';

// highlight: 'hamburger' draws a ring around the menu button (above the dim backdrop; the card never covers it, see .wt-overlay padding).
const STEPS = [
  {
    logo: true,
    title: 'Welcome to Runout',
    body: 'A vinyl turntable, a cassette stack and a radio dial for your phone. The disc IS the sound — drag it to scratch through the music, swing the arm to jump ahead, hold the brake to stop. No progress bar. Everything is direct manipulation.',
  },
  {
    icon: '☰',
    title: 'Pull the page aside',
    body: `Runout has five sections: Albums, Mixtapes, Radio, ${BOOTH_LABEL} and Settings (the gear, last in the list).\n\nTap the menu button at the top left — or drag the page to the right from the very left edge — and the page slides aside to show the list. Tap a name to go there. The magnifier at the top searches your songs, albums, artists, mixtapes and radio stations. Tap the page, or press Esc, to put it back.\n\nMusic keeps playing while you move around; a small bar at the bottom shows what is playing and takes you back to it.`,
    highlight: 'hamburger',
  },
  {
    icon: '↺',
    title: 'Albums: drag to scratch',
    body: "The turntable sits at the top of Albums, your shelf of albums below it. Grab anywhere on the disc and drag it like a DJ.\n\nYour hand sets the motor speed — drag backward for reverse playback. Release and the motor winds back up to playing speed. That pitch-rising sound you hear is real platter physics.",
    highlight: 'disc',
  },
  {
    icon: '↗',
    title: 'Move the needle (silent seek)',
    body: "To jump to a different part of the track without hearing anything: start dragging from the very OUTER EDGE of the disc, then slide inward.\n\nThe tonearm lifts silently (you hear nothing) and drops back down when you release. Drop it in the gap between tracks to start the next one, or flick sideways there for next / previous.\n\n💡 If scrubbing activates instead, start your drag further outside the disc edge.",
    highlight: 'disc',
  },
  {
    icon: '◎',
    title: 'Speed and palm brake',
    body: "33⅓, 45, and 78 change the motor speed — just like real RPM settings. At 45, the track plays FASTER and HIGHER-PITCHED at the same time: pitch and tempo are always locked together, never stretched apart.\n\nHold BRAKE (or the space bar) to cut the motor. The disc slows with real momentum and winds back up when you let go.",
    highlight: 'rpmButtons',
  },
  {
    icon: '▭',
    title: 'Mixtapes: the stack',
    body: 'Your mixtapes are a stack of cassettes. Tap the one on top to play it; tap any other to bring it to the top. New, Import and Edit are the small buttons above the stack. Tap the cassette in the player to see its songs.',
  },
  {
    icon: '📻',
    title: 'Radio',
    body: 'Internet stations, pre-written shows with talking hosts that work offline, and your favourites and recents. Start one and keep browsing — it plays on while you visit the other sections.',
  },
  {
    icon: '🎚',
    title: `${BOOTH_LABEL}: the DJ side`,
    body: `${BOOTH_LABEL} is where the effects live. It works on the record you are playing; while a radio station or a mixtape has the sound, it is switched off and tells you so.`,
  },
  {
    icon: '✓',
    title: 'The feel test — does it feel LIVE?',
    body: "The only question for v0: when you drag the disc, does the pitch change AT the exact moment your finger moves — or does it feel like the audio is chasing behind?\n\nIf it feels 'stuck to your finger': ✓ pass. Web audio is fast enough.\nIf there's a noticeable delay: the audio engine needs swapping for a native Oboe one.",
  },
  {
    icon: '⏱',
    title: 'Measuring latency (the loopback test)',
    body: "Latency = the gap between your touch and the sound that comes out. The target is under 30 ms — at that speed your brain fuses them into one sensation.\n\nTo measure it precisely: hold the phone near a mic (or the built-in mic), tap the screen, and measure the gap between the tap transient and the audio response. That gap is your true round-trip latency.\n\nBut honestly — trust your hand first. If the scratch feels real, it's passing.",
    highlight: 'latency',
  },
  {
    icon: '⚙',
    title: 'Feel knobs, layout and theme',
    body: "Open the menu and tap ♦ to unlock four physics dials (they appear under Albums → Deck details):\n• J — disc inertia. Higher = heavier, takes longer to spin up.\n• k — motor pull. Higher = snappier return to speed.\n• c — friction. Higher = coast dies faster.\n• brake damp — stopping power.\n\nDial these by hand on-device until it feels right. They are the product.\n\nSettings (last in the list) holds the theme, accent colour, custom theme and the rest of the options; ☾ flips light and dark; ? brings this tour back.",
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
        <button class="wt-x" aria-label="Close">✕</button>
        <div class="wt-icon"></div>
        <h2 class="wt-title"></h2>
        <p class="wt-body"></p>
        <footer class="wt-foot">
          <div class="wt-dots"></div>
          <div class="wt-nav">
            <button class="wt-prev">← Back</button>
            <button class="wt-next">Next →</button>
          </div>
        </footer>
      </div>`;
    document.body.appendChild(el);
    this._el = el;

    el.querySelector('.wt-x').addEventListener('click', () => this.hide());
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
    else icon.textContent = s.icon;
    this._ring(s.highlight === 'hamburger');
    card.querySelector('.wt-title').textContent = s.title;
    card.querySelector('.wt-body').textContent = s.body;

    const next = card.querySelector('.wt-next');
    next.textContent = this._step === STEPS.length - 1 ? "Let's go →" : 'Next →';
    card.querySelector('.wt-prev').style.visibility = this._step === 0 ? 'hidden' : '';

    card.querySelector('.wt-dots').innerHTML = STEPS.map((_, i) =>
      `<span class="wt-dot${i === this._step ? ' on' : ''}"></span>`
    ).join('');

    card.scrollTop = 0;
  }
}
