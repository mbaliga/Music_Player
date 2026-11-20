// walkthrough.js — first-run onboarding. Plain DOM, no deps.
// Shows a full-screen card overlay step by step, explaining every concept
// in plain English — including latency and how to feel-test it on-device.

import { BOOTH_LABEL } from './shell/sections.js';

// highlight: 'hamburger' draws a ring around the menu button (above the dim backdrop; the card never covers it, see .wt-overlay padding).
const STEPS = [
  {
    logo: true,
    title: 'Welcome to Runout',
    body: 'A vinyl turntable, a cassette stack and a radio dial for your phone, playing your own music. The disc IS the sound: drag it to scratch through a song, drag the arm to jump to another part, hold the label to brake. There is no progress bar.\n\nThis short tour covers the five sections, the lock key and the one question this version has to answer: does it feel live under your hand?',
  },
  {
    icon: '☰',
    title: 'Pull the page aside',
    body: `Runout has five sections: Albums, Mixtapes, Radio, ${BOOTH_LABEL} and Settings (the gear, last in the list).\n\nTap the menu button at the top left, or drag the page to the right from the very left edge, and the page slides aside to show the list. Tap a name to go there. Tap the page, or press Esc, to put it back.\n\nMusic keeps playing while you move around; a small bar at the bottom shows what is playing and takes you back to it.`,
    highlight: 'hamburger',
  },
  {
    icon: '↺',
    title: 'Albums: the turntable',
    body: "Albums is a turntable. Tap Play to lower the arm and start; tap Stop to freeze the record exactly where it is. 33, 45 and 78 pick the speed (45 plays faster and higher at once, like the real thing), and − / + nudge it.\n\nGrab the disc and drag it to scratch: your hand sets the speed, backward plays in reverse, and when you let go the motor winds back up. Until you scan some music you get a built-in test record.",
    highlight: 'disc',
  },
  {
    icon: '↗',
    title: 'The arm and the brake',
    body: "To jump somewhere without scratching, grab the little dimple on the tonearm and slide it along its rail. The sound goes silent while the arm is lifted and the needle sets down where you let go. Drop it in a gap between tracks to start the next track; a quick flick goes to the next or previous one.\n\nTo brake, hold the centre label of the disc (or the space bar). The disc slows with real momentum and winds back up when you let go.",
    highlight: 'disc',
  },
  {
    icon: '▦',
    title: 'Pinch in for your library',
    body: "Pinch two fingers together on the turntable and it shrinks into your library: a coverflow of albums. Swipe sideways to browse, tap a track to play it, tap the cover again to bring the record back. A CD (a folder labelled CD1, Disc 2 and so on) opens its own CD player. Pinch outwards to return to the turntable.\n\nThe Scan button at the top of the library reads your music: on the Android app it scans the phone itself (it asks permission first); in a browser you pick a folder.",
  },
  {
    icon: '⌕',
    title: 'Search',
    body: 'The magnifier in the top bar (also Ctrl or Cmd + K, or the / key) searches your songs, albums, artists, mixtapes and radio stations at once, and works offline. Tap a result to play it or open it. The only thing that uses the network is a row you tap yourself: searching the internet radio directory.',
  },
  {
    icon: '▭',
    title: 'Mixtapes',
    body: 'Your mixtapes are a stack of cassettes. Tap the one on top to play it; tap another to bring it to the top. New builds one: choose the tape length (C30, C60 or C90), search for songs or whole albums and add them to side A or side B, then style the cassette. A side holds at most 15, 30 or 45 minutes and 20 songs, and a song that does not fit is refused rather than squeezed.\n\nIn the player, AUTO flips to side B by itself at the end of side A; with AUTO off the tape stops and asks you to FLIP it. Tap the cassette to see its songs.',
  },
  {
    icon: '📻',
    title: 'Radio',
    body: 'Internet stations, six pre-written shows with talking hosts that work with no network (they play between your own songs), and your favourites and recents. Start one and keep browsing: it plays on while you visit the other sections, and the music ducks under a host.',
  },
  {
    icon: '🎚',
    title: `${BOOTH_LABEL}: the DJ side`,
    body: `${BOOTH_LABEL} is where the effects live: beat repeat, stutter, blend scratch, band pass and echo, played on a touch pad. It works on the record you are playing; while a radio station or a mixtape has the sound, it is switched off and tells you so.`,
  },
  {
    icon: '🔒',
    title: 'The lock key',
    body: 'The padlock at the top right of every page turns the phone into a device with buttons. Locked, the screen stays awake and only the keys work: Play / Stop and the speed keys on Albums, the cassette keys on Mixtapes, Stop on Radio. The disc, the arm, the library and the menu are frozen so a stray touch does nothing. After a while a dim always-on display takes over; double-tap to wake it. Hold the key for about a second to unlock. Options are in Settings > Device mode.',
  },
  {
    icon: '✓',
    title: 'The feel test: does it feel LIVE?',
    body: "The only question for this version: when you drag the disc, does the pitch change AT the exact moment your finger moves, or does it feel like the audio is chasing behind?\n\nIf it feels 'stuck to your finger': pass. If there is a noticeable delay, the audio engine needs swapping for a native one. The latency readout in Deck details (the sliders icon on Albums) is the browser's own estimate, not a measurement: to measure properly, tap the screen next to a microphone and compare the tap with the sound. Trust your hand first.",
    highlight: 'latency',
  },
  {
    icon: '⚙',
    title: 'Feel knobs, settings and this tour',
    body: "Deck details (the sliders icon on Albums) holds track controls, the fine speed slider and, once you tap the ◦ / ♦ mode button at the bottom of the menu, four physics dials: J (disc inertia), k (motor pull), c (friction) and brake damp. Dial them by hand on the phone until it feels right. They are the product.\n\nSettings (last in the menu) holds the theme (dark, OLED black, light or your own), accent colour, text size, reduced motion, library options, radio, Booth, device mode and privacy. The ? button in the menu brings this tour back.",
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
