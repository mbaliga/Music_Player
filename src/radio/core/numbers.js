// ─────────────────────────────────────────────────────────────────────────────
// numbers.js — number extraction/normalisation shared by the grounding verifier
// and the markup template resolver. Pure.
//
// extractNumbers() finds every number a listener would hear in a sentence, whether
// written as digits ("18", "1,200", "6:45", "3rd") or spelled ("eighteen",
// "twenty-one", "one hundred"). The bare word "one" is NOT counted on its own
// ("one of those days") but is inside compounds ("twenty-one", "one hundred").
// Values are absolute (a minus sign is a word, not part of the claim magnitude).
// ─────────────────────────────────────────────────────────────────────────────

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 0..9999 -> "forty-five". Outside that range falls back to digits. */
export function numberToWords(n) {
  if (!Number.isInteger(n) || n < 0 || n > 9999) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberToWords(n % 100)}` : ''}`;
  return `${numberToWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberToWords(n % 1000)}` : ''}`;
}

const WORD_VAL = new Map();
ONES.forEach((w, i) => WORD_VAL.set(w, i));
TENS.forEach((w, i) => { if (w) WORD_VAL.set(w, i * 10); });

function extractWordNumbers(text) {
  const words = text.toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
  const out = [];
  let i = 0;
  while (i < words.length) {
    if (!WORD_VAL.has(words[i])) { i++; continue; }
    // Greedy run: [ones|tens ones] [hundred] [tens ones] [thousand] [hundreds...]. 'one' alone is
    // a pronoun/article ("one of those days"), so a single 'one' is not a number claim.
    let total = 0, cur = 0, j = i, thousands = false;
    for (; j < words.length; j++) {
      const x = words[j];
      if (WORD_VAL.has(x)) {
        const v = WORD_VAL.get(x), r = cur % 100;
        if (v >= 20) { if (r !== 0) break; cur += v; }
        else if (r === 0) { if (j > i && v === 0) break; cur += v; }
        else if (r >= 20 && r % 10 === 0 && v > 0 && v < 10) cur += v;
        else break;
      } else if (x === 'hundred' && j > i && cur > 0 && cur < 10) cur *= 100;
      else if (x === 'thousand' && j > i && cur > 0 && !thousands) { total += cur * 1000; cur = 0; thousands = true; }
      else break;
    }
    if (!(j - i === 1 && words[i] === 'one')) out.push({ value: total + cur, raw: words.slice(i, j).join(' '), kind: 'word' });
    i = Math.max(j, i + 1);
  }
  return out;
}

/** All numbers in a string: [{value, raw, kind:'digit'|'word'}], digits first-pass in text order. */
export function extractNumbers(text) {
  const s = String(text ?? '');
  const out = [];
  const re = /\d[\d,]*(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(s))) {
    const v = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(v)) out.push({ value: v, raw: m[0], kind: 'digit' });
  }
  return out.concat(extractWordNumbers(s.replace(/\d[\d,]*(?:\.\d+)?/g, ' ')));
}

/** Numeric leaves of any JSON-ish value plus numbers spoken in its strings. */
export function numbersInValue(v, out = []) {
  if (typeof v === 'number' && Number.isFinite(v)) out.push(Math.abs(v));
  else if (typeof v === 'string') for (const n of extractNumbers(v)) out.push(n.value);
  else if (Array.isArray(v)) v.forEach((x) => numbersInValue(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => numbersInValue(x, out));
  return out;
}

/** Does a spoken number match a fact number allowing the rounding a host would do? */
export function numberMatches(spoken, factNum) {
  if (spoken === factNum) return true;
  if (Number.isInteger(spoken) && !Number.isInteger(factNum)) {
    return spoken === Math.round(factNum) || spoken === Math.floor(factNum) || spoken === Math.ceil(factNum);
  }
  return Math.abs(spoken - factNum) < 1e-9;
}
