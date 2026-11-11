// SPIKE P1 -- THROWAWAY. Seeded RNG so fake-adapter runs are reproducible.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Standard normal via Box-Muller. */
export function gauss(rng) {
  const u = Math.max(rng(), 1e-12), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/** Log-normal delay with the given MEDIAN (so p50 of many draws ~= median) and sigma (log-space spread). */
export function lognormalDelay(rng, medianMs, sigma = 0.25) {
  return medianMs * Math.exp(sigma * gauss(rng));
}
