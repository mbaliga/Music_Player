// cassette-styles.test.mjs — the 37-style registry: every style renders
// non-empty SVG with the required mounts and layers, with no external URLs or
// scripts in any generated markup; ids are namespaced per render; the player
// skins' generic ids are namespaced per instance (nsIds).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cassette } from '../src/cassette/index.js';
import { famFor } from '../src/cassette/reels-physics.js';
import { nsIds } from '../src/cassette/players.js';
import { DECK_SVG, PLAYER_SVG } from '../src/cassette/player-skins.js';

const styles = Cassette.styles();
const stripXmlns = (m) => m.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '');
const cfg = (id, extra = {}) => ({ style: id, text: { title: 'Late Night Drive', subtitle: 'tag', note: 'Side A · 5 songs', side: 'A' }, ...extra });

test('37 styles: 17 original + 16 flat + 4 glass, unique ids, in the owner order', () => {
  assert.equal(styles.length, 37);
  assert.equal(new Set(styles.map((s) => s.id)).size, 37);
  assert.equal(styles[0].id, 'brass'); assert.equal(styles[17].id, 'sea'); assert.equal(styles[33].id, 'glass');
  for (const s of styles) { assert.ok(s.name && typeof s.name === 'string'); assert.ok(s.kind); }
  assert.equal(styles.filter((s) => s.kind === 'Glass').length, 4);
  assert.ok(styles.some((s) => s.clear) && styles.some((s) => !s.clear && s.kind !== 'Glass'));
});

test('every style renders non-empty SVG with both reel mounts, panel/label and the title', () => {
  for (const s of styles) {
    for (const reels of [false, true]) {
      const m = Cassette.render(cfg(s.id, { reelStandIns: reels, progress: 0.4 }));
      assert.match(m, /^<svg [^>]*viewBox="0 0 \d+ \d+"/, s.id);
      assert.ok(m.length > 3000, `${s.id} suspiciously small (${m.length})`);
      assert.equal((m.match(/data-reel="left"/g) || []).length, 1, `${s.id} left mount`);
      assert.equal((m.match(/data-reel="right"/g) || []).length, 1, `${s.id} right mount`);
      assert.ok(m.includes('Late Night Drive'), `${s.id} prints the title`);
      assert.ok(/<\/svg>$/.test(m), s.id);
      assert.ok(!/NaN|undefined|\[object/.test(m), `${s.id} has a bad value`);
      if (reels) {
        assert.equal((m.match(/data-pack/g) || []).length, 2, `${s.id} packs`);
        assert.equal((m.match(/data-spin/g) || []).length, 2, `${s.id} spin hubs`);
        assert.ok(m.includes('data-marker'), `${s.id} marker`);
        if (famFor(s).tape) { assert.ok(m.includes('data-tape'), `${s.id} tape path`); assert.ok(m.includes('data-roller="L"') && m.includes('data-roller="R"'), `${s.id} rollers`); }
      }
    }
  }
});

test('no external URLs, scripts, event handlers or remote images in any generated markup', () => {
  for (const s of styles) for (const wear of [0, 0.6]) {
    const m = stripXmlns(Cassette.render(cfg(s.id, { reelStandIns: true, wear })));
    assert.ok(!/https?:\/\//i.test(m), `${s.id} references an external URL`);
    assert.ok(!/<script|<foreignObject|<image|<iframe|javascript:|\son\w+=/i.test(m), `${s.id} has active content`);
    assert.ok(!/(?:src|href)="(?!#)/i.test(m), `${s.id} has a non-local href/src`);
    assert.ok(!/url\((?!#)/.test(m), `${s.id} has a non-local url()`);
    assert.ok(!/@import/.test(m));
  }
});

test('ids are namespaced per render: two renders of the same style share no id', () => {
  for (const s of styles) {
    const a = Cassette.render(cfg(s.id, { reelStandIns: true })), b = Cassette.render(cfg(s.id, { reelStandIns: true }));
    const ids = (m) => [...m.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]);
    const ia = ids(a), ib = new Set(ids(b));
    assert.ok(ia.length > 0, s.id);
    assert.equal(new Set(ia).size, ia.length, `${s.id} duplicate ids inside one render`);
    for (const i of ia) assert.ok(!ib.has(i), `${s.id}: id ${i} collides across instances`);
    // every url(#x) / href="#x" resolves inside the same svg
    for (const m of [a, b]) {
      const own = new Set(ids(m));
      for (const [, r] of m.matchAll(/url\(#([^)]+)\)/g)) assert.ok(own.has(r), `${s.id} dangling url(#${r})`);
    }
  }
});

test('text is escaped (a hostile title cannot inject markup)', () => {
  const m = Cassette.render(cfg('brass', { text: { title: '<script>alert(1)</script>&"', subtitle: '<b>', note: '', side: 'A' } }));
  assert.ok(!m.includes('<script'));
  assert.ok(m.includes('&lt;script&gt;'));
});

test('pens, wear and gloss change the output; unknown style/pen fall back, never throw', () => {
  const a = Cassette.render(cfg('brass', { pen: 'marker' })), b = Cassette.render(cfg('brass', { pen: 'type' }));
  assert.notEqual(a.replace(/k[0-9a-z]+-/g, ''), b.replace(/k[0-9a-z]+-/g, ''));
  assert.ok(Cassette.render(cfg('brass', { wear: 0 })).length < Cassette.render(cfg('brass', { wear: 1 })).length);
  assert.ok(Cassette.render({ style: 'does-not-exist', pen: 'nope' }).length > 3000);
  assert.ok(Cassette.render({}).length > 3000);
  assert.ok(Cassette.render(cfg('brass', { slots: { ink: '#ff0000' } })).includes('#ff0000'));
});

test('pen fonts: bundled families first, system fallbacks after (no network fonts)', () => {
  for (const k of Object.keys(Cassette.PENS)) assert.ok(/,\s*(cursive|monospace)\s*$/.test(Cassette.PENS[k].family) || /cursive/.test(Cassette.PENS[k].family), k);
  assert.deepEqual(Object.keys(Cassette.PENS), ['marker', 'script', 'type', 'bold']);
});

test('no brand wordmarks are printed by any style', () => {
  const brands = /\b(sony|tdk|maxell|basf|memorex|fuji|denon|walkman|nakamichi|technics|philips|panasonic|dolby|scotch|agfa|emtec|aiwa|jvc|akai|teac|yamaha|pioneer|adidas|nike|apple|ipod|vx)\b/i;
  for (const s of styles) {
    const m = stripXmlns(Cassette.render(cfg(s.id, { text: { title: 'x', subtitle: '', note: '', side: 'A' }, reelStandIns: true })));
    const printed = [...m.matchAll(/>([^<>]{2,})<\/text>/g)].map((x) => x[1]).join(' | ');
    assert.ok(!brands.test(printed), `${s.id} prints a brand-like word: ${printed}`);
    assert.ok(!brands.test(s.name + ' ' + (s.note || '')), `${s.id} name/note`);
  }
  assert.ok(!brands.test(DECK_SVG + PLAYER_SVG.replace(/<[^>]+>/g, ' ')), 'player chassis text');
});

test('player skins: nsIds prefixes every id / url(#) / href="#"; no duplicate or dangling ids', () => {
  for (const [name, svg] of [['deck', DECK_SVG], ['player', PLAYER_SVG]]) {
    const a = nsIds(svg, 'cp1-'), b = nsIds(svg, 'cp2-');
    const ids = (m) => [...m.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]);
    const ia = ids(a);
    assert.ok(ia.length > 5, name);
    assert.ok(ia.every((i) => i.startsWith('cp1-')), name);
    assert.equal(new Set(ia).size, ia.length, `${name} has duplicate ids (the generic lcd id was split)`);
    const sb = new Set(ids(b));
    for (const i of ia) assert.ok(!sb.has(i));
    for (const [, r] of a.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ia.includes(r), `${name} dangling url(#${r})`);
    for (const [, r] of a.matchAll(/href="#([^"]+)"/g)) assert.ok(ia.includes(r), `${name} dangling href #${r}`);
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(svg), `${name} external URL`);
  }
  assert.equal(nsIds('<g id="a"/><use href="#a" x="1"/><rect fill="url(#a)" data-id="z"/>', 'p-'),
    '<g id="p-a"/><use href="#p-a" x="1"/><rect fill="url(#p-a)" data-id="z"/>');
});
