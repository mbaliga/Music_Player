// SPIKE P1 -- THROWAWAY. Real-vendor adapters: STUBS ONLY.
//
// Nothing here talks to a network. Each class documents the contract a real implementation must
// meet and refuses to run unless its key is supplied through the ENVIRONMENT (Node) -- keys are
// never read from a file in this repo and never committed. In a browser page there is deliberately
// no way to supply them: a real caller loop goes through the radio backend proxy (separate repo).
//
// Vendors are NOT chosen here. No vendor feature, price, latency or licence claim is made:
// everything about any specific vendor is UNVERIFIED. The LLM model ids in the architecture doc
// come from the claude-api skill's cached table (dated 2026-10-06) and are also UNVERIFIED by this spike.

export class NotConfiguredError extends Error {
  constructor(envVar, what) { super(`${what} stub: set ${envVar} in the environment to enable (UNVERIFIED stub, no network code).`); this.name = 'NotConfiguredError'; }
}
export class NotImplementedError extends Error {
  constructor(what) { super(`${what}: real adapter is a STUB in the P1 spike -- implement against a vendor chosen in spike S3. UNVERIFIED.`); this.name = 'NotImplementedError'; }
}

export const ENV_KEYS = {
  stt: 'RUNOUT_SPIKE_STT_KEY',
  llm: 'RUNOUT_SPIKE_LLM_KEY',
  tts: 'RUNOUT_SPIKE_TTS_KEY',
};

function need(env, name, what) {
  const v = env && env[ENV_KEYS[name]];
  if (!v) throw new NotConfiguredError(ENV_KEYS[name], what);
  return v; // held in memory only; never logged, never written
}

export class RealSttStub {
  kind = 'real';
  constructor(env = (typeof process !== 'undefined' ? process.env : {})) { this._key = need(env, 'stt', 'STT'); }
  // Contract: streaming recognizer; finalize() should return as soon as the final hypothesis is ready.
  async finalize() { throw new NotImplementedError('STT'); }
}
export class RealWriterStub {
  kind = 'real';
  constructor(env = (typeof process !== 'undefined' ? process.env : {})) { this._key = need(env, 'llm', 'LLM writer'); }
  // Contract: async-iterable of text tokens, first yield = time-to-first-token (stage 4).
  // eslint-disable-next-line require-yield
  async *stream() { throw new NotImplementedError('LLM writer'); }
}
export class RealTtsStub {
  kind = 'real';
  constructor(env = (typeof process !== 'undefined' ? process.env : {})) { this._key = need(env, 'tts', 'TTS'); }
  // Contract: streaming synthesis; resolve with firstByteAt = clock.now() when the first audio byte arrives (stage 6).
  async synthesize() { throw new NotImplementedError('TTS'); }
}

/** Returns which real stubs could be constructed given an env object (never returns the keys). */
export function realAdapterAvailability(env = (typeof process !== 'undefined' ? process.env : {})) {
  return Object.fromEntries(Object.entries(ENV_KEYS).map(([k, v]) => [k, Boolean(env[v])]));
}
