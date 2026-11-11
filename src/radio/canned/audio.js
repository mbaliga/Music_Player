// ─────────────────────────────────────────────────────────────────────────────
// audio.js — plays one pre-rendered segment through a MediaElement (<audio>), NOT Web Audio.
//
// Why an element: Opus decode support in the Android WebView is unverified, and a media element is the most widely supported
// path (decodeAudioData on a 20-second voice file would also work but needs the whole file and a second code path). The
// music keeps playing through the engine's music bus; the voice is a separate element at full volume while the music bus
// is ducked by the controller. Every failure settles the promise: play() NEVER rejects and never hangs.
//
//   const a = createAudioBackend({ createAudio, timers });
//   const r = await a.play({ candidates:[{url,type}], durationSec, onStart });   // -> { ok, reason, candidate }
//   a.cancel();
//
// Candidates are tried in order, skipping types the element cannot play (canPlayType === '') and moving on after a load error,
// so an .opus that this WebView cannot decode falls through to an .m4a the manifest names, and finally to a failure the
// caller answers with system TTS.
// ─────────────────────────────────────────────────────────────────────────────

export const AUDIO_TIMEOUTS = Object.freeze({ startMs: 7000, endSlackMs: 4000, endFactor: 1.5 });

export function createAudioBackend({ createAudio = () => new Audio(), timers = { setTimeout, clearTimeout }, timeouts = AUDIO_TIMEOUTS } = {}) {
  let cur = null; // { cancel }
  const api = {
    get playing() { return !!cur; },
    cancel() { if (cur) cur.cancel('cancelled'); },
    play({ candidates = [], durationSec = 20, onStart, onProgress } = {}) {
      if (cur) cur.cancel('cancelled');
      return new Promise((resolve) => {
        let settled = false, el = null, idx = 0, startT = null, endT = null, started = false, tried = 0;
        const clear = () => { if (startT) timers.clearTimeout(startT); if (endT) timers.clearTimeout(endT); startT = endT = null; };
        const release = () => { try { if (el) { el.onplaying = el.onended = el.onerror = el.ontimeupdate = null; el.pause(); el.removeAttribute('src'); el.load(); } } catch { /* */ } el = null; };
        const finish = (res) => { if (settled) return; settled = true; clear(); const c = candidates[idx - 1] || null; release(); if (cur === handle) cur = null; resolve({ ...res, candidate: c, tried }); };
        const handle = { cancel: (reason = 'cancelled') => finish({ ok: false, reason }) };
        cur = handle;
        const next = (why) => {
          if (settled) return;
          clear(); release(); started = false;
          if (idx >= candidates.length) return finish({ ok: false, reason: tried ? `load_failed:${why}` : 'unsupported' });
          const cand = candidates[idx++];
          let probe = '';
          try { el = createAudio(); probe = cand.type ? el.canPlayType(cand.type) : 'maybe'; } catch (e) { return finish({ ok: false, reason: 'no_audio_element' }); }
          if (cand.type && probe === '') { release(); return next('unsupported_type'); }
          tried++;
          el.preload = 'auto';
          el.onplaying = () => {
            if (settled || started) return;
            started = true; if (startT) timers.clearTimeout(startT); startT = null;
            try { onStart && onStart(); } catch { /* host callback must not break us */ }
            endT = timers.setTimeout(() => finish({ ok: true, reason: 'assumed_end', assumed: true }), durationSec * 1000 * timeouts.endFactor + timeouts.endSlackMs);
          };
          el.onended = () => finish({ ok: true, reason: 'done' });
          el.onerror = () => { if (!started) next('error'); else finish({ ok: false, reason: 'error_mid_play' }); };
          if (onProgress) el.ontimeupdate = () => { try { onProgress(el.currentTime); } catch { /* */ } };
          startT = timers.setTimeout(() => { if (!started) next('no_start'); }, timeouts.startMs);
          try {
            el.src = cand.url;
            const p = el.play();
            if (p && typeof p.catch === 'function') p.catch((e) => { if (settled || started) return; if (e && e.name === 'AbortError') return; next('play_rejected'); });
          } catch { next('throw'); }
        };
        next('start');
      });
    },
  };
  return api;
}
