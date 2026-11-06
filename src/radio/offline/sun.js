// ─────────────────────────────────────────────────────────────────────────────
// sun.js — sunrise / sunset from a pure astronomical formula (NOAA solar-calculator
// equations, accurate to a minute or two away from the poles). No network, no data files.
//
//   sunTimes({lat, lon, year, month, day, utcOffsetMin}) ->
//     { kind: 'normal', sunriseMin, sunsetMin }   minutes after local midnight (0..1439)
//     { kind: 'polar_day' }                       the sun does not set
//     { kind: 'polar_night' }                     the sun does not rise
//     { kind: 'none' }                            no usable location
//   season({lat, month, day}) -> 'winter'|'spring'|'summer'|'autumn'|null (null near the equator or without lat)
//
// Location is optional and user-entered at city level (never requested automatically); every function
// degrades to {kind:'none'} / null without it. Never throws.
// ─────────────────────────────────────────────────────────────────────────────

const RAD = Math.PI / 180;

const dayOfYear = (y, m, d) => {
  const cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return cum[m - 1] + d + (leap && m > 2 ? 1 : 0);
};

export function sunTimes({ lat, lon, year, month, day, utcOffsetMin = 0 } = {}) {
  try {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return { kind: 'none' };
    if (!(year > 1800 && month >= 1 && month <= 12 && day >= 1 && day <= 31)) return { kind: 'none' };
    const n = dayOfYear(year, month, day);
    const g = (2 * Math.PI / 365) * (n - 1 + (12 - 12) / 24); // fractional year at local noon-ish
    const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    const cosHa = (Math.cos(90.833 * RAD) / (Math.cos(lat * RAD) * Math.cos(decl))) - Math.tan(lat * RAD) * Math.tan(decl);
    if (cosHa > 1) return { kind: 'polar_night' };
    if (cosHa < -1) return { kind: 'polar_day' };
    const ha = Math.acos(cosHa) / RAD; // degrees
    const wrap = (m) => { const x = Math.round(m + utcOffsetMin) % 1440; return x < 0 ? x + 1440 : x; };
    return { kind: 'normal', sunriseMin: wrap(720 - 4 * (lon + ha) - eqtime), sunsetMin: wrap(720 - 4 * (lon - ha) - eqtime) };
  } catch { return { kind: 'none' }; }
}

export function season({ lat, month, day } = {}) {
  if (!Number.isFinite(lat) || Math.abs(lat) < 10 || !(month >= 1 && month <= 12)) return null;
  const md = month * 100 + (day || 1);
  // meteorological-ish boundaries on the 21st (astronomical): Mar 20, Jun 21, Sep 22, Dec 21
  const north = md >= 1221 || md < 320 ? 'winter' : md < 621 ? 'spring' : md < 922 ? 'summer' : 'autumn';
  if (lat >= 0) return north;
  return { winter: 'summer', spring: 'autumn', summer: 'winter', autumn: 'spring' }[north];
}

/** minutes after midnight -> {h12, minute, ampm} for text such as "6:41 am". */
export function clockParts(min) {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  return { h12: h % 12 || 12, minute: m, ampm: h < 12 ? 'am' : 'pm' };
}
export const clockText = (min) => { const p = clockParts(min); return `${p.h12}:${String(p.minute).padStart(2, '0')} ${p.ampm}`; };
