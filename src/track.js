// ─────────────────────────────────────────────────────────────────────────────
// track.js — track sources.
//
// v0 ships with ONE hardcoded track (spec §10), but bundling a copyrighted
// audio file is not appropriate, so the default track is synthesized at runtime.
// It is deliberately built with sharp transients (good to scratch) and a clear
// dynamic arc — quiet intro → full section → breakdown — so the envelope
// banding on the groove visibly shows the music's shape (spec §6).
//
// Loading a real local file (drag-drop / picker → decodeAudioData) is also here;
// that is technically a v1 feature but it's a few lines and makes the prototype
// immediately useful for feeling the scrub on real material.
// ─────────────────────────────────────────────────────────────────────────────

/** Returns { channels: [L, R], frames } at the given sample rate. */
export function synthesizeTrack(sampleRate, seconds = 24) {
  const frames = Math.floor(sampleRate * seconds);
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);

  const bpm = 120;
  const beat = 60 / bpm;            // 0.5 s
  const bar = beat * 4;             // 2 s

  // Section gain envelope over the whole track — drives the dynamic arc.
  const sectionGain = (t) => {
    const barIdx = Math.floor(t / bar);
    if (barIdx < 2) return 0.45;     // quiet intro (bass + hat)
    if (barIdx < 6) return 1.0;      // full
    if (barIdx < 8) return 0.35;     // breakdown
    if (barIdx < 10) return 1.0;     // full again
    return 0.7;                      // outro
  };

  // Pentatonic bass + lead motif (semitone offsets from A2 / A3).
  const bassSeq = [0, 0, 7, 5, 3, 3, -2, 0];
  const leadSeq = [12, 15, 19, 15, 12, 10, 7, 12];
  const noteHz = (semisFromA, baseA) => baseA * Math.pow(2, semisFromA / 12);

  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const g = sectionGain(t);
    const tBeat = t % beat;
    const beatIdx = Math.floor(t / beat);
    const barIdx = Math.floor(t / bar);

    let s = 0;

    // ── Kick: sharp pitched-down thump on every beat (the prime scratch hit) ──
    if (barIdx >= 2) {
      const kEnv = Math.exp(-tBeat * 45);
      const kHz = 120 * Math.exp(-tBeat * 30) + 45;
      s += 0.9 * g * kEnv * Math.sin(TAU * kHz * tBeat);
    }

    // ── Hi-hat: filtered noise burst on the offbeat ──
    const tHalf = (t + beat / 2) % beat;
    if (tHalf < beat) {
      const hEnv = Math.exp(-((t % (beat / 2))) * 90);
      s += 0.18 * g * hEnv * (Math.random() * 2 - 1);
    }

    // ── Bass: short saw note per beat ──
    {
      const n = noteHz(bassSeq[beatIdx % bassSeq.length], 110); // A2 = 110
      const bEnv = Math.exp(-tBeat * 4) * (1 - Math.exp(-tBeat * 200));
      const phase = (t * n) % 1;
      const saw = 2 * phase - 1;
      s += 0.35 * g * bEnv * saw;
    }

    // ── Lead: gentler sine motif, one note per beat, only in full sections ──
    if (g > 0.6) {
      const n = noteHz(leadSeq[beatIdx % leadSeq.length], 220); // A3 = 220
      const lEnv = Math.exp(-tBeat * 2.5) * (1 - Math.exp(-tBeat * 80));
      const vib = 1 + 0.004 * Math.sin(TAU * 5 * t);
      s += 0.22 * g * lEnv * Math.sin(TAU * n * vib * t);
    }

    // Gentle stereo width via a tiny phase offset on the lead-ish content.
    const wob = 0.04 * Math.sin(TAU * 0.3 * t);
    L[i] = clampSample(s * (1 + wob));
    R[i] = clampSample(s * (1 - wob));
  }

  // Soft-clip / normalize pass to keep peaks sane.
  normalizeInPlace(L, R, 0.9);
  return { channels: [L, R], frames, name: 'Runout — test pressing' };
}

/** Decode a user-picked File into channel Float32Arrays at the ctx rate. */
export async function loadFile(file, audioContext) {
  const arr = await file.arrayBuffer();
  const buf = await audioContext.decodeAudioData(arr);
  const channels = [];
  for (let c = 0; c < buf.numberOfChannels; c++) {
    channels.push(buf.getChannelData(c).slice());
  }
  if (channels.length === 1) channels.push(channels[0].slice()); // mono → stereo
  return {
    channels,
    frames: buf.length,
    name: file.name.replace(/\.[^.]+$/, ''),
  };
}

const TAU = Math.PI * 2;

function clampSample(x) {
  return x > 1 ? 1 : x < -1 ? -1 : x;
}

function normalizeInPlace(L, R, target) {
  let peak = 1e-9;
  for (let i = 0; i < L.length; i++) {
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  const g = target / peak;
  if (g >= 1) return;
  for (let i = 0; i < L.length; i++) { L[i] *= g; R[i] *= g; }
}
