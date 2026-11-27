// sleep-audio.js — the sleep timer's volume: ONE place that can fade everything that makes sound.
//   * the engine's music bus (albums, tapes, offline shows): a dedicated unity GainNode between the bus and the output, inserted the first time it
//     is needed (a separate node, so the Booth's ducking on the bus's own gain keeps working untouched);
//   * streamed radio: its <audio> elements (not in the DOM), found through a registry filled by wrapping HTMLMediaElement.play().
// Browser only; every call is try/caught and a no-op where there is nothing to fade.
const media = new Set();   // WeakRef<HTMLMediaElement>
let patched = false;

/** Remember every media element that is asked to play (so a stream's detached <audio> can be faded). Call once, early. */
export function installMediaRegistry(proto = typeof HTMLMediaElement !== 'undefined' ? HTMLMediaElement.prototype : null) {
  try {
    if (patched || !proto || typeof proto.play !== 'function') return false;
    const orig = proto.play;
    proto.play = function patchedPlay(...a) { try { media.add(new WeakRef(this)); } catch { /* */ } return orig.apply(this, a); };
    patched = true;
    return true;
  } catch { return false; }
}
function eachMedia(fn) {
  for (const r of [...media]) {
    const el = r.deref();
    if (!el) { media.delete(r); continue; }
    try { fn(el); } catch { /* */ }
  }
}

/** A fader for the engine's bus + streamed audio. `engine` = AudioEngine (ctx, musicBus). */
export function createSleepFader(engine) {
  let node = null, level = 1;
  function ensureNode() {
    if (node || !engine || !engine.ctx) return node;
    try {
      const ctx = engine.ctx, bus = engine.musicBus;
      node = ctx.createGain(); node.gain.value = level;
      bus.disconnect(ctx.destination);     // only this one connection; anything else tapped off the bus stays
      bus.connect(node); node.connect(ctx.destination);
    } catch { node = null; }
    return node;
  }
  return {
    /** g in 0..1 (1 = untouched). */
    set(g) {
      level = Math.max(0, Math.min(1, g));
      if (level < 1 && !node) ensureNode();
      if (node) { try { const t = engine.ctx.currentTime; node.gain.cancelScheduledValues(t); node.gain.setTargetAtTime(level, t, level === 1 ? 0.02 : 0.12); } catch { /* */ } }
      eachMedia((el) => { el.volume = level; });
    },
    get level() { return level; },
    get inserted() { return !!node; },
  };
}
