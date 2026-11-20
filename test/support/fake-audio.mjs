// A recording fake of the bits of Web Audio the FX bus touches (node:test only).
export function makeFakeCtx(sampleRate = 44100) {
  const edges = new Set(), nodes = [];
  let id = 0;
  const param = (v = 0) => ({ value: v, calls: [], setTargetAtTime(...a) { this.calls.push(['target', ...a]); }, setValueAtTime(...a) { this.calls.push(['set', ...a]); }, cancelScheduledValues() {}, linearRampToValueAtTime() {} });
  const mk = (type, extra = {}) => {
    const n = { id: ++id, kind: type, ...extra,
      connect(d) { edges.add(`${n.id}>${d.id}`); return d; },
      disconnect(d) { if (d) { if (!edges.delete(`${n.id}>${d.id}`)) throw new Error('InvalidAccessError: not connected'); } else for (const e of [...edges]) if (e.startsWith(n.id + '>')) edges.delete(e); } };
    nodes.push(n); return n;
  };
  const destination = mk('destination');
  const ctx = {
    sampleRate, currentTime: 0, destination, nodes, edges,
    createGain: () => mk('gain', { gain: param(1) }),
    createBiquadFilter: () => mk('biquad', { frequency: param(350), Q: param(1), type: 'lowpass' }),
    createDelay: (max) => mk('delay', { delayTime: param(0), max }),
    createConvolver: () => mk('convolver', { buffer: null }),
    createBuffer: (ch, len, sr) => ({ ch, len, sr, data: Array.from({ length: ch }, () => new Float32Array(len)), getChannelData(i) { return this.data[i]; } }),
  };
  const bus = ctx.createGain(); bus.connect(destination);
  return { ctx, bus, edges, nodes, destination, snapshot: () => [...edges].sort().join('|'), engine: { ctx, musicBus: bus } };
}
export function fakeTimers() {
  let t = 0, id = 0; const q = new Map();
  return { set(f, ms) { q.set(++id, { f, at: t + ms }); return id; }, clear(h) { q.delete(h); },
    advance(ms) { t += ms; for (const [k, v] of [...q]) if (v.at <= t) { q.delete(k); v.f(); } }, pending: () => q.size };
}
