import test from 'node:test';
import assert from 'node:assert/strict';
import { speakable, cleanTitle, cleanArtist, cleanAlbum, yearWords, ordinalWords } from '../../src/radio/offline/pronounce.js';

test('speakable: numbers, years, times, ordinals, decades', () => {
  const cases = [
    ['in 1999', 'in nineteen ninety-nine'], ['2007', 'two thousand seven'], ['2000', 'two thousand'], ['1905', 'nineteen oh five'], ['1900', 'nineteen hundred'],
    ['4:52 pm', 'four fifty-two p m'], ['12:00', "twelve o'clock"], ['7:05', 'seven oh five'], ['the 3rd of May', 'the third of May'], ['21st', 'twenty-first'], ['12th', 'twelfth'],
    ['1,200 songs', 'one thousand two hundred songs'], ['3.5 stars', 'three point five stars'], ['the 90s', 'the nineties'], ['the 1990s', 'the nineteen nineties'], ['track 7', 'track seven'],
    ['12345678', 'twelve million three hundred forty-five thousand six hundred seventy-eight'], ['007', 'zero zero seven'],
  ];
  for (const [i, o] of cases) assert.equal(speakable(i), o, i);
});

test('speakable: symbols, feat., ampersands, file cruft', () => {
  assert.equal(speakable('Bob feat. Jane & Tom'), 'Bob featuring Jane and Tom');
  assert.equal(speakable('Bob ft. Jane'), 'Bob featuring Jane');
  assert.equal(speakable('Rock + Roll'), 'Rock plus Roll');
  assert.equal(speakable('100% pure'), 'one hundred percent pure');
  assert.equal(speakable('Dr. Dre vs. Mr. T'), 'Doctor Dre versus Mister T');
  assert.equal(speakable('Part_One__Final'), 'Part One Final');
  assert.equal(speakable('a/b'), 'a b');
  assert.equal(speakable('wait… what — really'), 'wait... what, really');
  assert.equal(speakable('see https://example.com/x now'), 'see now');
  assert.equal(speakable('Rocky IV'), 'Rocky four');
  assert.equal(speakable('I met VI there'), 'I met VI there'); // not after a capitalised word at phrase end
  assert.equal(speakable('party \u{1F389} time'), 'party time');
  assert.equal(speakable('No. 5'), 'number five');
  assert.equal(speakable('#1 hit'), 'number one hit');
  assert.equal(speakable("it's 5°"), "it's five degrees");
});

test('speakable never throws, is idempotent, and leaves no digits or markup braces', () => {
  const nasty = [null, undefined, 42, {}, '', '   ', '{pause:300}', '\u0000\u0001', 'a'.repeat(5000), '9'.repeat(40), '1:99', '99:99 pm', '0:00 am', '1,2,3', '..5', '5..', '$5.50', '12.34.56'];
  for (const n of nasty) {
    const a = speakable(n);
    assert.equal(typeof a, 'string');
    assert.equal(speakable(a), a, `not idempotent for ${String(n).slice(0, 20)}`);
    assert.doesNotMatch(a, /[{}]/);
  }
  assert.doesNotMatch(speakable('Track 7 of 12, 1999, 4:52 pm, 3rd, 5% and 2,000'), /\d/);
});

test('ordinal and year helpers', () => {
  assert.equal(ordinalWords(1), 'first'); assert.equal(ordinalWords(22), 'twenty-second'); assert.equal(ordinalWords(30), 'thirtieth'); assert.equal(ordinalWords(100), 'one hundredth');
  assert.equal(yearWords(1984), 'nineteen eighty-four'); assert.equal(yearWords(2010), 'twenty ten'); assert.equal(yearWords(1100), 'eleven hundred');
});

test('cleanTitle: removes file-name cruft and keeps meaningful brackets', () => {
  const cases = [
    ['01 - Song_Name (feat. X) [Remastered 2011].mp3', 'Song Name (feat. X)'], ['7. Blue Monday', 'Blue Monday'], ['A2 Hello (Live)', 'A2 Hello (Live)'],
    ['Foo (Official Video)', 'Foo'], ['Bar [HD]', 'Bar'], ['Baz (Part 2)', 'Baz (Part 2)'], ['  Wide   Gap  ', 'Wide Gap'], ['Tune.FLAC', 'Tune'],
    ['Heat (2009 Remaster)', 'Heat'], ['Odd <b>tag</b>', 'Odd b tag /b'], ['pipe|bar{x}', 'pipe bar x'],
  ];
  for (const [i, o] of cases) assert.equal(cleanTitle(i), o, i);
  for (const bad of ['Track 03', 'track03', 'Untitled', 'Untitled 2', 'Unknown', '', '   ', '12', '---', null, undefined, '\u0001\u0002']) assert.equal(cleanTitle(bad), null, String(bad));
  assert.equal(cleanTitle('x'.repeat(61)), null);
  assert.equal(cleanTitle(`${'Very long '.repeat(6)}title - Version`), null); // first segment still > 60
  assert.equal(cleanTitle('A fairly long title that goes on and on for a while - Extended Mix'), 'A fairly long title that goes on and on for a while');
});

test('cleanArtist / cleanAlbum drop unknowns and compilations', () => {
  for (const bad of ['Unknown Artist', 'unknown', '<unknown>', 'Various Artists', 'VA', '', null, 'x'.repeat(51)]) assert.equal(cleanArtist(bad), null, String(bad));
  assert.equal(cleanArtist('Mara Quill'), 'Mara Quill');
  assert.equal(cleanArtist('A{b}c'), 'A b c');
  assert.equal(cleanAlbum('Unknown Album'), null); assert.equal(cleanAlbum('Singles'), null);
  assert.equal(cleanAlbum('Night Drive [Deluxe Edition]'), 'Night Drive');
});

test('speakable stays fast on hostile runs of brackets and punctuation (late space-before-punctuation pass was quadratic)', () => {
  for (const ch of ['[', '(', ' [', ' ,', '{', '|']) {
    const t = performance.now();
    speakable(ch.repeat(60000));
    assert.ok(performance.now() - t < 100, `speakable(${JSON.stringify(ch)} x 60000) took ${(performance.now() - t).toFixed(0)} ms`);
  }
  assert.ok(speakable('x'.repeat(100000)).length <= 4000, 'input is bounded');
});
