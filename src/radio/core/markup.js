// ─────────────────────────────────────────────────────────────────────────────
// markup.js — the vendor-neutral expressive script layer (architecture 3.4).
//
// Layer 1 (writer): per-utterance `style` + inline markers in `text`:
//     {pause:400}  {breath}  {laugh}  {sfx:name}  {em}word{/em}   and late-bound
//     templates {{time.spoken}} {{time.daypart}} {{date.spoken}}
//   Punctuation carries rhythm and survives every engine.
// Layer 2 (adapter): a TTS engine declares capabilities(); degradeUtterance()
//   maps the richest supported form and DROPS the rest, never leaking a marker
//   into spoken text. The golden tests check the output of each preset.
//
// Pure: string in, string/objects out. Never throws.
// ─────────────────────────────────────────────────────────────────────────────

import { numberToWords } from './numbers.js';

export const MAX_PAUSE_MS = 2000;
export const TEMPLATE_NAMES = ['time.spoken', 'time.daypart', 'date.spoken'];
const SFX_RE = /^[a-z][a-z0-9_-]{0,23}$/;
const TOKEN_RE = /\{\{[^{}]*\}\}|\{[^{}]*\}/g;

/**
 * Parse text into tokens. Never throws. {ok, errors[], tokens[]}
 * token: {type:'text',text} | {type:'pause',ms} | {type:'breath'} | {type:'laugh'}
 *        | {type:'sfx',name} | {type:'em',open:boolean} | {type:'template',name}
 * Invalid markers are reported in errors AND kept out of the token stream (so a
 * caller that ignores errors still never speaks a raw marker).
 */
export function parseMarkup(text) {
  const errors = [];
  const tokens = [];
  const s = typeof text === 'string' ? text : '';
  if (typeof text !== 'string') errors.push('text: must be a string');
  let last = 0, emOpen = false;
  const pushText = (t) => {
    if (!t) return;
    if (/[{}]/.test(t)) { errors.push(`stray brace in "${t.slice(0, 20)}"`); t = t.replace(/[{}]/g, ''); }
    if (t) tokens.push({ type: 'text', text: t });
  };
  for (const m of s.matchAll(TOKEN_RE)) {
    pushText(s.slice(last, m.index));
    last = m.index + m[0].length;
    const raw = m[0];
    if (raw.startsWith('{{')) {
      const name = raw.slice(2, -2).trim();
      if (TEMPLATE_NAMES.includes(name)) tokens.push({ type: 'template', name });
      else errors.push(`unknown template ${raw}`);
      continue;
    }
    const body = raw.slice(1, -1);
    let p;
    if ((p = /^pause:(\d+)$/.exec(body))) {
      const ms = Number(p[1]);
      if (ms > MAX_PAUSE_MS) { errors.push(`pause ${ms}ms exceeds ${MAX_PAUSE_MS}ms`); tokens.push({ type: 'pause', ms: MAX_PAUSE_MS }); }
      else tokens.push({ type: 'pause', ms });
    } else if (body === 'breath') tokens.push({ type: 'breath' });
    else if (body === 'laugh') tokens.push({ type: 'laugh' });
    else if ((p = /^sfx:(.+)$/.exec(body))) {
      if (SFX_RE.test(p[1])) tokens.push({ type: 'sfx', name: p[1] });
      else errors.push(`bad sfx name "${p[1].slice(0, 30)}"`);
    } else if (body === 'em') {
      if (emOpen) errors.push('nested {em}'); else { emOpen = true; tokens.push({ type: 'em', open: true }); }
    } else if (body === '/em') {
      if (!emOpen) errors.push('{/em} without {em}'); else { emOpen = false; tokens.push({ type: 'em', open: false }); }
    } else errors.push(`unknown marker ${raw.slice(0, 30)}`);
  }
  pushText(s.slice(last));
  if (emOpen) { errors.push('unclosed {em}'); tokens.push({ type: 'em', open: false }); }
  return { ok: errors.length === 0, errors, tokens };
}

export const validateMarkup = (text) => { const { ok, errors } = parseMarkup(text); return { ok, errors }; };

const tidy = (s) => s.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();

/**
 * Plain speech with every marker removed (em keeps its words). Templates are dropped,
 * or resolved when `templates` is a function (name) => string. The grounding verifier
 * works on this form.
 */
export function stripMarkup(text, { templates } = {}) {
  const out = [];
  for (const t of parseMarkup(text).tokens) {
    if (t.type === 'text') out.push(t.text);
    else if (t.type === 'template' && typeof templates === 'function') out.push(String(templates(t.name) ?? ''));
    else if (t.type === 'pause' || t.type === 'breath') out.push(' ');
  }
  return tidy(out.join(''));
}

/** Any unconsumed marker or template left in a rendered string? (leak detector for tests/guards) */
export const hasLeakedMarkers = (s) => /\{[^{}]*\}|\{\{|\}\}/.test(String(s ?? ''));

// ── Late-bound templates (resolved at TTS render time, 1–2 slots before air) ──

const DAYPART_PHRASE = {
  early_morning: 'early this morning', morning: 'this morning', midday: 'around midday',
  afternoon: 'this afternoon', evening: 'this evening', late_night: 'late tonight',
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * parts = {hour(0-23), minute, daypart, weekday, month(1-12), day}. Returns a resolver
 * (name) => spoken string for stripMarkup/templates or for TTS render.
 */
export function templateResolver(parts) {
  const p = parts || {};
  const spokenTime = () => {
    const h12 = ((p.hour % 12) || 12), m = p.minute;
    if (!Number.isInteger(p.hour) || !Number.isInteger(m)) return '';
    return m === 0 ? `${numberToWords(h12)} o'clock` : `${numberToWords(h12)} ${m < 10 ? `oh ${numberToWords(m)}` : numberToWords(m)}`;
  };
  return (name) => {
    if (name === 'time.spoken') return spokenTime();
    if (name === 'time.daypart') return DAYPART_PHRASE[p.daypart] || '';
    if (name === 'date.spoken') {
      return p.weekday && p.month >= 1 && p.month <= 12 && Number.isInteger(p.day)
        ? `${p.weekday}, ${MONTHS[p.month - 1]} ${numberToWords(p.day)}` : '';
    }
    return '';
  };
}

// ── Layer 2: engine capability downgrade ─────────────────────────────────────

/**
 * Capability record an engine adapter returns from capabilities():
 *   ssml:        <speak>/<break>/<emphasis>/<prosody> supported
 *   namedStyles: engine style names it knows (array) — emotions map via styleMap
 *   styleMap:    {emotion: engineStyleName}
 *   direction:   accepts a natural-language acting note
 *   audioTags:   inline tags, e.g. {laugh:'[laughs]', breath:'[sighs]'} (object) or false
 *   rate:        accepts a numeric speed multiplier outside SSML
 */
export const CAPS_NONE = Object.freeze({ ssml: false, namedStyles: null, styleMap: {}, direction: false, audioTags: false, rate: false });
export const CAPS_SSML = Object.freeze({ ...CAPS_NONE, ssml: true });
export const CAPS_RICH = Object.freeze({
  ssml: false, namedStyles: ['cheerful', 'calm', 'excited', 'whispering', 'sad'],
  styleMap: { warm: 'calm', hype: 'excited', hushed: 'whispering', playful: 'cheerful', wistful: 'sad' },
  direction: true, audioTags: { laugh: '[laughs]', breath: '[sighs]' }, rate: true,
});

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Map one script utterance onto an engine. Returns
 *   {form:'ssml'|'text', body, params:{rate?, pitchSemitones?, engineStyle?, direction?}, sfx:[{name, atChar}] (atChar = index into the plain speech, markers excluded), dropped:[...]}
 * `dropped` names every feature the engine could not honour (so tests and telemetry-free
 * logs can see degradation). `resolve` renders late-bound templates (see templateResolver).
 */
export function degradeUtterance(utt, capsIn = CAPS_NONE, { resolve } = {}) {
  const caps = { ...CAPS_NONE, ...(capsIn || {}) };
  const style = (utt && utt.style) || {};
  const dropped = new Set();
  const sfx = [];
  const params = {};
  const { tokens } = parseMarkup(utt && utt.text);
  let body = '';
  let plainLen = 0;
  const add = (frag, plain) => { body += frag; plainLen += plain; };
  for (const t of tokens) {
    if (t.type === 'text') add(caps.ssml ? xml(t.text) : t.text, t.text.length);
    else if (t.type === 'template') { const r = resolve ? String(resolve(t.name) ?? '') : ''; add(caps.ssml ? xml(r) : r, r.length); }
    else if (t.type === 'pause') {
      if (caps.ssml) add(`<break time="${t.ms}ms"/>`, 0);
      else add(t.ms >= 600 ? '... ' : t.ms >= 200 ? ', ' : ' ', 0);
      if (!caps.ssml) dropped.add('pause-ms'); // approximated by punctuation
    } else if (t.type === 'breath') {
      if (caps.audioTags && caps.audioTags.breath) add(` ${caps.audioTags.breath} `, 0);
      else if (caps.ssml) { add('<break time="250ms"/>', 0); dropped.add('breath'); }
      else { add(', ', 0); dropped.add('breath'); }
    } else if (t.type === 'laugh') {
      if (caps.audioTags && caps.audioTags.laugh) add(` ${caps.audioTags.laugh} `, 0);
      else dropped.add('laugh');
    } else if (t.type === 'sfx') sfx.push({ name: t.name, atChar: plainLen }); // played by the bus, not the voice
    else if (t.type === 'em') {
      if (caps.ssml) add(t.open ? '<emphasis level="moderate">' : '</emphasis>', 0);
      else dropped.add('emphasis');
    }
  }
  body = caps.ssml ? body.replace(/ {2,}/g, ' ').trim() : tidy(body);

  // style -> params
  if (typeof style.pace === 'number') {
    if (caps.ssml) params.rate = style.pace;
    else if (caps.rate) params.rate = style.pace;
    else if (style.pace !== 1) dropped.add('pace');
  }
  if (typeof style.pitchSemitones === 'number' && style.pitchSemitones !== 0) {
    if (caps.ssml) params.pitchSemitones = style.pitchSemitones; else dropped.add('pitch');
  }
  if (caps.namedStyles && caps.styleMap && caps.styleMap[style.emotion] && caps.namedStyles.includes(caps.styleMap[style.emotion])) {
    params.engineStyle = caps.styleMap[style.emotion];
  } else if (style.emotion && style.emotion !== 'warm') dropped.add('emotion');
  if (style.direction) {
    if (caps.direction) params.direction = style.direction; else dropped.add('direction');
  }

  let form = 'text';
  if (caps.ssml) {
    const attrs = [];
    if (params.rate) attrs.push(`rate="${Math.round(params.rate * 100)}%"`);
    if (params.pitchSemitones) attrs.push(`pitch="${params.pitchSemitones > 0 ? '+' : ''}${params.pitchSemitones}st"`);
    const inner = attrs.length ? `<prosody ${attrs.join(' ')}>${body}</prosody>` : body;
    body = `<speak>${inner}</speak>`;
    form = 'ssml';
  }
  return { form, body, params, sfx, dropped: [...dropped] };
}
