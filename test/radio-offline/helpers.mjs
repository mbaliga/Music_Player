// Shared test doubles for the offline host: a manual clock with timers, a fake speechSynthesis, a fake audio player and
// a fake library. Everything runs on virtual time, so a 45-minute show takes a couple of seconds.

export function fakeTime(startMs = Date.parse('2026-11-04T18:05:00Z')) {
  let t = startMs, seq = 0;
  const timers = new Map();
  const flush = () => new Promise((r) => setImmediate(r));
  const api = {
    now: () => t,
    setTimeout(fn, ms = 0) { const id = ++seq; timers.set(id, { at: t + Math.max(0, ms), fn, every: null }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = ++seq; timers.set(id, { at: t + ms, fn, every: ms }); return id; },
    clearInterval(id) { timers.delete(id); },
    get timers() { return { setTimeout: api.setTimeout, clearTimeout: api.clearTimeout, setInterval: api.setInterval, clearInterval: api.clearInterval }; },
    pending: () => timers.size,
    /** advance virtual time, firing timers in order, yielding to promises between steps */
    async advance(ms, step = 50) {
      const end = t + ms;
      while (t < end) {
        const next = Math.min(end, t + step);
        // fire every timer due up to `next` in time order
        for (;;) {
          let best = null, bid = null;
          for (const [id, x] of timers) if (x.at <= next && (!best || x.at < best.at)) { best = x; bid = id; }
          if (!best) break;
          t = Math.max(t, best.at);
          if (best.every) best.at += best.every; else timers.delete(bid);
          best.fn();
          await flush();
        }
        t = next;
        await flush();
      }
    },
    flush,
  };
  return api;
}

/** a fake window.speechSynthesis. mode: normal | nostart | noend | noevents | error */
export class FakeSynth {
  constructor(time, { voices = [], mode = 'normal', wps = 2.6 } = {}) {
    this.time = time; this.mode = mode; this.wps = wps; this._voices = voices; this.spoken = []; this.cancels = 0;
    this.speaking = false; this.pending = false; this.paused = false; this._cur = null; this._timers = []; this._listeners = {};
  }
  getVoices() { return this._voices; }
  addEventListener(n, f) { (this._listeners[n] ||= new Set()).add(f); }
  removeEventListener(n, f) { this._listeners[n]?.delete(f); }
  resume() { this.paused = false; }
  speak(u) {
    this.spoken.push({ text: u.text, rate: u.rate, pitch: u.pitch, voice: u.voice && u.voice.name, at: this.time.now() });
    this._cur = u; this.speaking = true;
    const words = (u.text.match(/\S+/g) || []).length;
    const dur = Math.max(300, (words / (this.wps * (u.rate || 1))) * 1000);
    const T = this.time;
    const sched = (fn, ms) => { const id = T.setTimeout(() => { if (this._cur === u) fn(); }, ms); this._timers.push(id); };
    if (this.mode === 'nostart' || this.mode === 'noevents') return;
    if (this.mode === 'error') { sched(() => { this.speaking = false; this._cur = null; u.onerror && u.onerror({ error: 'synthesis-failed' }); }, 30); return; }
    sched(() => u.onstart && u.onstart({}), 40);
    for (let i = 1; i <= words; i++) sched(() => u.onboundary && u.onboundary({ charIndex: i }), 40 + (dur * i) / (words + 1));
    if (this.mode === 'noend') return;
    sched(() => { this.speaking = false; this._cur = null; u.onend && u.onend({}); }, dur);
  }
  cancel() {
    this.cancels++;
    const u = this._cur;
    this._cur = null; this.speaking = false;
    for (const id of this._timers) this.time.clearTimeout(id);
    this._timers = [];
    if (u && this.mode === 'normal') u.onerror && u.onerror({ error: 'interrupted' });
  }
}
export class FakeUtterance { constructor(text) { this.text = text; this.rate = 1; this.pitch = 1; this.volume = 1; } }
export const VOICES = [
  { name: 'Alex', lang: 'en-US', voiceURI: 'alex', localService: true, default: true },
  { name: 'Fiona', lang: 'en-GB', voiceURI: 'fiona', localService: true, default: false },
  { name: 'Amelie', lang: 'fr-FR', voiceURI: 'amelie', localService: true, default: false },
  { name: 'Cloudy', lang: 'en-US', voiceURI: 'cloudy', localService: false, default: false },
];

/** library tracks as the app has them (id/title/artist/album/genre/durationSec/file) */
export function fakeLibrary(n = 12, { startAt = 1 } = {}) {
  const artists = ['The Velvet Lanterns', 'Mara Quill', 'Low Tide Orchestra', 'June Parlor', 'Static Orchard'];
  const genres = ['Jazz', 'Rock', 'Ambient', 'Folk', 'Electronic'];
  return Array.from({ length: n }, (_, i) => ({
    id: `t${String(i + startAt).padStart(3, '0')}`, title: `Song ${['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima'][i % 12]} ${i + startAt}`,
    artist: artists[i % artists.length], album: `Album ${String.fromCharCode(65 + (i % 4))}`, genre: genres[i % genres.length],
    durationSec: 150 + ((i * 37) % 90), file: { lastModified: 1700000000000 + i * 86400000, name: `f${i}.mp3` },
  }));
}

/** A fake audio player on virtual time. Records what played for dead-air analysis. */
export function fakePlayer(time, { failLoad = new Set(), failDecode = new Set(), loadMs = 0 } = {}) {
  let deck = null, next = null;
  const played = []; // { trackId, startSec, endSec }
  const ev = [];
  const sec = () => time.now() / 1000;
  const close = (endSec) => { if (deck && played.length) played[played.length - 1].endSec = endSec; };
  const p = {
    played, ev, failLoad, failDecode, get next() { return next; }, get deck() { return deck; },
    async load(lib) {
      ev.push(['load', lib.id]);
      if (failLoad.has(lib.id) || failDecode.has(lib.id)) throw new Error('decode failed');
      if (loadMs) { await new Promise((r) => time.setTimeout(r, loadMs)); }
      close(sec());
      next = null;
      deck = { id: lib.id, startedAt: time.now(), dur: lib.durationSec };
      played.push({ trackId: lib.id, startSec: sec(), endSec: sec() + lib.durationSec });
      return { durationSec: lib.durationSec, envelope: null, bytes: lib.durationSec * 352800 };
    },
    async decodeNext(lib) {
      ev.push(['decodeNext', lib.id]);
      if (failDecode.has(lib.id)) throw new Error('decode failed');
      return { id: lib.id, durationSec: lib.durationSec, envelope: null, bytes: lib.durationSec * 352800, name: lib.title };
    },
    async prepareNext(h) { next = h; ev.push(['prepareNext', h.id]); },
    joinNext(fade) { if (!next) return false; ev.push(['join', next.id, fade]); close(sec()); deck = { id: next.id, startedAt: time.now(), dur: next.durationSec }; played.push({ trackId: next.id, startSec: sec(), endSec: sec() + next.durationSec }); next = null; return true; },
    adopt() {},
    dropNext() { if (next) ev.push(['dropNext', next.id]); next = null; },
    position() { return deck ? { t: (time.now() - deck.startedAt) / 1000, T: deck.dur } : null; },
    async halt() { close(sec()); ev.push(['halt']); deck = null; next = null; },
  };
  return p;
}

/** minimal AudioParam recording every automation call */
export function fakeParam(initial = 1) {
  const calls = [];
  return { value: initial, calls, cancelScheduledValues(t) { calls.push(['cancel', t]); }, setValueAtTime(v, t) { calls.push(['set', v, t]); }, linearRampToValueAtTime(v, t) { calls.push(['ramp', v, t]); } };
}
