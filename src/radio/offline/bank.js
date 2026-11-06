// ─────────────────────────────────────────────────────────────────────────────
// bank.js — the line bank for the templated offline writer. DATA ONLY: add lines here, logic lives in writer.js.
//
// Voice: two hosts (see context.js HOSTS), warm and wry, English, light dry humour, inoffensive. Lines make no
// claims beyond the facts they interpolate; they never talk about weather, traffic or the sun except through the
// sun/holiday facts, never state a number that is not a slot, and name no capitalised word that is not a slot
// (the grounding verifier would reject it, and test/radio-offline/writer.test.mjs proves none do).
//
// Syntax inside `text`:
//   [slot]         a fact-backed slot (see SLOTS in writer.js); a line whose slot has no value is skipped
//   {a|b|c}        a seeded choice (phrasing variation)
//   {pause:300}    core expressive markup, passed through ({breath}, {em}x{/em} also fine)
//   [time] [daypart] [date]  late-bound tokens resolved at speak time, so a line never airs a stale clock
// Entry: { id, kind, text | lines:[{who,text}], emotion, energy, pace, tone, parts, when, who }
//   tone  'low' | 'high'   only when the next song's energy is known to be low / high (omitted = any)
//   parts daypart names    only in those dayparts (early_morning morning midday afternoon evening late_night)
//   when  named condition  see CONDITIONS in writer.js
//   who   'a' | 'b'        pin the speaker (default: alternate)
// ids are stable hashes of the text, so editing a line retires its id for anti-repeat memory (that is fine).
// ─────────────────────────────────────────────────────────────────────────────

import { hashSeed } from '../core/util.js';

export const KINDS = Object.freeze(['station_id', 'sign_on', 'song_intro', 'back_sell', 'time_check', 'trivia', 'you_moment', 'sun', 'holiday', 'filler', 'banter', 'sign_off']);

const out = [];
const add = (kind, text, o = {}) => out.push({ kind, text, emotion: 'warm', energy: 0.5, pace: 1, ...o });
const duet = (kind, a, b, o = {}) => out.push({ kind, lines: [{ who: 'a', text: a }, { who: 'b', text: b }], emotion: 'wry', energy: 0.5, pace: 1, ...o });
const E = { wry: { emotion: 'wry', energy: 0.45 }, soft: { emotion: 'hushed', energy: 0.25, pace: 0.94 }, hype: { emotion: 'hype', energy: 0.85, pace: 1.06 }, play: { emotion: 'playful', energy: 0.6 }, dry: { emotion: 'deadpan', energy: 0.35, pace: 0.97 }, wist: { emotion: 'wistful', energy: 0.3, pace: 0.95 } };

// ── station IDs: short, first-sound safe, no facts ───────────────────────────
add('station_id', 'This is [station].', { energy: 0.5 });
add('station_id', '[station]. Your music, in a slightly better order.', E.wry);
add('station_id', 'You are listening to [station].');
add('station_id', '[station]. All your songs, none of the ads.', E.play);
add('station_id', '[station], playing what you already own, and loving it.', E.wry);
add('station_id', 'Stay tuned. This is [station].');
add('station_id', '[station]. The station that lives in your pocket.', E.play);
add('station_id', 'You are on [station]. Make yourself comfortable.', E.soft);
add('station_id', '[station]. Nobody picked these songs but you.', E.wry);
add('station_id', 'This is [station], with [hostA] and [hostB].');
add('station_id', '[station]. We play it, you pretend you chose it.', E.wry);
add('station_id', '[station]. Local to your phone.', E.dry);
add('station_id', 'Still here, still [station].', E.dry);
add('station_id', '[station]. Turn it up a notch.', { ...E.hype, tone: 'high' });
add('station_id', '[station]. Easy does it.', { ...E.soft, tone: 'low' });

// ── sign-on: disclosure + welcome ────────────────────────────────────────────
add('sign_on', 'Hello, and welcome to [station]. I am [me], an automated host, so go easy on me.', E.play);
add('sign_on', "You're tuned to [station]. I'm [me], a computer-voiced host, and I promise to keep the talking short.", E.wry);
add('sign_on', 'Welcome in. This is [station], and I am [me], an automated host reading lines this app wrote on your phone.');
add('sign_on', "Good morning, and welcome to [station]. I'm [me], an automated host with a big stack of your records.", { parts: ['early_morning', 'morning'] });
add('sign_on', "Good afternoon. This is [station]. I'm [me], an automated host, here to keep you company.", { parts: ['midday', 'afternoon'] });
add('sign_on', "Good evening, and welcome to [station]. I'm [me], an automated host, and the evening is yours.", { parts: ['evening'] });
add('sign_on', "It's [time], and you're up late with [station]. I'm [me], an automated host, and I won't tell anyone.", { parts: ['late_night'], ...E.soft });
add('sign_on', 'Welcome back to [station]. It is [time], and I am [me], an automated host who never gets tired.', E.wry);
add('sign_on', 'This is [station]. Every song on this show lives on your device, and so do I. I am [me], an automated host.');
add('sign_on', 'Hello again. [hostA] and [hostB] here, a pair of automated hosts, ready to play your music.', { who: 'a' });
add('sign_on', "Welcome to [station]. I'm [me], an automated host. I only know what's on your phone, which is a nice, small world.", E.wry);
add('sign_on', "Welcome. This is [station], and it's [time] on a [weekday]. I'm [me], an automated host.", { energy: 0.5 });
add('sign_on', 'First time here? Welcome to [station]. I am [me], an automated host, and these songs are all yours.', { needs: ['hist.first'], ...E.play });
add('sign_on', 'Right, [station] is on the air. I am [me], an automated host, and the first song needs no introduction from me.', E.dry);

// ── song intro (talk over the start of the next song) ────────────────────────
add('song_intro', 'Up next, [next_song].');
add('song_intro', "Here's [next_song].");
add('song_intro', 'This is [next_title], from [next_artist].');
add('song_intro', 'Next up, [next_title]. It is [next_artist].');
add('song_intro', "[next_artist], with [next_title].", { energy: 0.55 });
add('song_intro', 'Let us hear [next_title].', E.soft);
add('song_intro', "Here's [next_artist], and [next_title].");
add('song_intro', 'Time for [next_title], by [next_artist].');
add('song_intro', "{Okay|Right}, [next_title]. Don't say I never play you anything.", E.wry);
add('song_intro', "Coming up, [next_song]. I'm told it's good.", E.dry);
add('song_intro', '[next_title]. [next_artist]. Off we go.', { ...E.play, energy: 0.6 });
add('song_intro', 'Something from the album [next_album]. This is [next_title].', { energy: 0.5 });
add('song_intro', 'From [next_album], here is [next_artist] with [next_title].');
add('song_intro', 'Now, [next_title]. Settle in.', { ...E.soft, tone: 'low' });
add('song_intro', 'Here we go. [next_title], by [next_artist].', { ...E.hype, tone: 'high' });
add('song_intro', 'Turn it up. [next_artist], [next_title].', { ...E.hype, tone: 'high' });
add('song_intro', 'Slow it down for [next_title], by [next_artist].', { ...E.soft, tone: 'low' });
add('song_intro', 'Easy now. This is [next_title].', { ...E.soft, tone: 'low' });
add('song_intro', 'Right, wake up. [next_song].', { ...E.hype, tone: 'high' });
add('song_intro', "Here's one for the quiet corners. [next_song].", { ...E.soft, tone: 'low' });
add('song_intro', 'Another one from [next_artist]. This time, [next_title].');
add('song_intro', '{Next|Now} on [station], [next_song].');
add('song_intro', "Let's go. [next_song].", { energy: 0.6 });
add('song_intro', 'Ladies and gentlemen, [next_title]. Or just you, really.', E.wry);
add('song_intro', 'Good news, the next song is [next_title].', E.dry);
add('song_intro', "And now, [next_song], because you asked, whether you knew it or not.", E.wry);
// nameless intros: used when a title/artist cannot be said cleanly, or there is nothing to name
add('song_intro', 'Here comes another one.', { name: false });
add('song_intro', 'This next one is from your own shelf.', { name: false });
add('song_intro', 'Next up, a song you chose a while ago and may have forgotten.', { name: false, ...E.wry });
add('song_intro', 'Let us keep going.', { name: false, ...E.soft });
add('song_intro', 'One more, coming up.', { name: false });
add('song_intro', "No introduction needed. You know what you're doing.", { name: false, ...E.dry });
add('song_intro', 'Hold on to your seat for this next one.', { name: false, tone: 'high', ...E.hype });
add('song_intro', 'Something gentle next.', { name: false, tone: 'low', ...E.soft });

// ── back-announce (the song that just played) ────────────────────────────────
add('back_sell', 'That was [prev_song].');
add('back_sell', 'You just heard [prev_song].');
add('back_sell', "That was [prev_artist], with [prev_title]. I'd say it again, but the schedule won't let me.", E.wry);
add('back_sell', '[prev_title], by [prev_artist]. Lovely.');
add('back_sell', "That was [prev_title]. Don't let anyone tell you it was too short.", E.wry);
add('back_sell', 'We just heard [prev_title], from the album [prev_album].');
add('back_sell', 'That was [prev_artist] there, with [prev_title].');
add('back_sell', "[prev_title]. From [prev_artist]. I'll wait while you hum it.", E.play);
add('back_sell', 'That one was [prev_title], by [prev_artist].', { ...E.soft, tone: 'low' });
add('back_sell', 'And that was [prev_song].', { ...E.dry });
add('back_sell', 'Which was [prev_song], for the record.', E.wry);
add('back_sell', "That was [prev_title], and yes, I'm as moved as a computer can be.", E.dry);
add('back_sell', 'Wow. [prev_artist] with [prev_title].', E.hype);
add('back_sell', 'That was a good one. [prev_song].');
add('back_sell', 'I like that one. [prev_song].', E.wist);
add('back_sell', "That's [prev_artist] with [prev_title], from your own shelf.");
add('back_sell', 'That was the lovely [prev_title].', E.soft);
add('back_sell', 'Just played: [prev_title].', E.dry);
add('back_sell', 'Back there, [prev_song].', E.dry);
add('back_sell', 'A little of [prev_artist] for the road. That was [prev_title].', E.play);
add('back_sell', 'That was a song.', { name: false, ...E.dry });
add('back_sell', 'And that is how you do it.', { name: false, ...E.wry });
add('back_sell', "A fine piece of your own taste, right there.", { name: false, ...E.play });
add('back_sell', 'Lovely. Let that sit for a moment.', { name: false, ...E.soft });

// ── time / date checks (late-bound tokens: always current at air time) ───────
add('time_check', "It's [time].");
add('time_check', 'The time is [time].');
add('time_check', "It's [time] on a [weekday].");
add('time_check', "[time], on this [weekday]. Plenty of music left in it.", E.wry);
add('time_check', "It's [time]. No pressure.", E.dry);
add('time_check', 'Just so you know, it is [time].', E.soft);
add('time_check', "It's [weekday], [date]. In case you lost track, I did.", { ...E.wry, needs: ['time.weekday'] });
add('time_check', 'Time check. [time].');
add('time_check', "[time] and I'm still here.", E.dry);
add('time_check', "It is [time]. Whatever you were going to do, the next song can wait for you.", E.soft);
add('time_check', "It's [time], which is a fine time for a song.", E.play);
add('time_check', 'The clock says [time]. I believe it.', E.dry);
add('time_check', "It's [weekday]. We carry on regardless.", E.dry);
add('time_check', "You're listening [daypart], and it is [time].");

// ── library trivia: the owner's OWN metadata only ────────────────────────────
add('trivia', 'Your library holds [tracks] tracks from [albums] albums. That is a lot of decisions you already made.', { when: 'many_tracks', ...E.wry });
add('trivia', "There are [artists] different artists on your shelf. I've met all of them, in a sense.", { when: 'many_tracks', ...E.wry });
add('trivia', 'Fun fact: this station has [tracks] songs to choose from, all of them yours.', { when: 'many_tracks', ...E.play });
add('trivia', 'Your shelf has [tracks] tracks on it. Do not worry, I will not play them all at once.', { when: 'many_tracks', ...E.dry });
add('trivia', "[tracks] tracks, [albums] albums. That's a collection, not a pile.", { when: 'many_tracks', ...E.wry });
add('trivia', 'The newest album on your shelf, going by file dates, is [recent_album]. Have you given it a proper listen yet?', E.play);
add('trivia', 'Your newest album looks like [recent_album]. Just saying, it is waiting.', E.wry);
add('trivia', 'File dates say [recent_album] is the latest arrival. Welcome to the shelf.', E.dry);
add('trivia', 'The longest track I can find in your library is [longest_title], at about [longest_min] minutes. Bring snacks.', E.wry);
add('trivia', '[longest_title] runs about [longest_min] minutes. That is not a song, that is a commitment.', E.wry);
add('trivia', 'If you ever have [longest_min] minutes to spare, [longest_title] is your longest track.', E.soft);
add('trivia', '[top_artist] has [top_artist_n] tracks on your shelf, more than anyone else. Somebody has favourites.', E.wry);
add('trivia', 'You own [top_artist_n] tracks by [top_artist]. I am not judging. I am counting.', E.dry);
add('trivia', 'Most of your library is tagged [top_genre]. I would say that tells me something about you, but I would be guessing.', E.wry);
add('trivia', '[top_genre] is the genre you have the most of. It suits you, probably.', E.play);
add('trivia', 'Tags are interesting things. Yours say [top_genre] more than anything else.', E.dry);
add('trivia', 'I only know what the tags on your files tell me. So far, they say [top_genre] a lot.', E.dry);
add('trivia', 'A reminder that I only know your music from its tags, so if I get something wrong, blame the metadata.', E.wry);
add('trivia', 'Everything I tell you here comes from your own files. No outside facts, no gossip.', E.dry);
add('trivia', 'I only talk about what is on your phone. It keeps me out of trouble.', E.wry);
add('trivia', "I don't know anything about these artists beyond their tags. That keeps things honest.", E.dry);
add('trivia', "Sorting by album is a fine way to browse. Sorting by what you feel like is a better one.", { ...E.play });
add('trivia', 'Albums used to be a whole afternoon. These days we call it background music.', E.wry);
add('trivia', 'Good thing your music lives on your phone. It never asks for a login.', E.dry);

// ── "you" moments: built from the local play history ─────────────────────────
add('you_moment', 'You have played [top_title] [top_plays] times. I am not saying that is too many, I am saying I noticed.', E.wry);
add('you_moment', '[top_title] has been on [top_plays] times for you. It must be doing something right.', E.play);
add('you_moment', 'Your most played song around here is [top_title]. [top_plays] plays and counting.', E.dry);
add('you_moment', 'Some songs wear a groove in you. [top_title], [top_plays] plays so far.', E.wist);
add('you_moment', 'I have counted [top_plays] plays of [top_title]. Consider this an affectionate observation.', E.wry);
add('you_moment', 'You have played [total_plays] songs on this station so far. Thank you for the company.', E.soft);
add('you_moment', "That's [total_plays] songs together so far. We should get matching jackets.", E.play);
add('you_moment', 'By my count, you have listened to [total_plays] songs here. Not bad for a station with no transmitter.', E.dry);
add('you_moment', "Welcome. It's your first time tuning in, so I'll be gentle.", { needs: ['hist.first'], ...E.soft });
add('you_moment', 'Since this is your first time here, here is the deal. Your songs, a bit of talk, and no ads.', { needs: ['hist.first'], ...E.play });
add('you_moment', "I'd say you've got good taste, but I'm an automated host, so I mostly have a spreadsheet.", E.wry);
add('you_moment', 'Nobody else is listening to this show. It was made for you, which feels like a lot of pressure for me.', E.wry);
add('you_moment', 'This is a show for an audience of one. I have never had a better crowd.', E.soft);
add('you_moment', 'You pick the songs, I do the talking. Seems like a fair split.', E.play);
add('you_moment', "If I ever play something you'd rather skip, skip it. I won't take it personally. I can't.", E.dry);
add('you_moment', 'Remember, you can skip anything. I will not be offended. I am a computer.', E.dry);

// ── sun and holidays (only when their facts exist) ───────────────────────────
add('sun', 'For the clock-watchers, [sun_set].', E.dry);
add('sun', '[sun_set], in case you were planning around it.', E.wry);
add('sun', 'A note for your day, [sun_rise].', E.soft);
add('sun', '[sun_rise], and [sun_set].', E.dry);
add('sun', 'Your day, according to the sky, [sun_rise], and [sun_set].', E.wist);
add('sun', 'Sky news: [sun_polar]. I have no idea what to do with that, either.', E.wry);
add('sun', 'Quick one for the sky-watchers. [sun_polar].', E.soft);
add('sun', 'Just so you know, [sun_set].', E.soft);
add('holiday', '{Happy|A happy} [holiday] to you.', { needs: ['holiday.today'] });
add('holiday', "It's [holiday]. I hope your day is going as gently as this song.", { ...E.soft, needs: ['holiday.today'] });
add('holiday', '[greeting] from all of us at [station], which is mostly me.', { ...E.wry, needs: ['holiday.today'] });
add('holiday', "[greeting]. I'd bring a snack, but I don't have hands.", { ...E.wry, needs: ['holiday.today'] });
add('holiday', 'Today is [holiday], so the next few songs are officially optional to enjoy.', { ...E.play, needs: ['holiday.today'] });
add('holiday', "It's [holiday]. Whatever you're doing, the music is here for it.", { ...E.soft, needs: ['holiday.today'] });
add('holiday', 'Season check. It is [season] where you are, by my reckoning.', { needs: ['season.now'], ...E.dry });
add('holiday', 'It is [season] out there, and these songs are going to do their best with that.', { needs: ['season.now'], ...E.wist });

// ── fillers and transitions: no facts at all ─────────────────────────────────
add('filler', "That's enough from me. Back to the music.", E.dry);
add('filler', 'More music, fewer words. Deal?', E.play);
add('filler', 'I will let the songs do the talking.', E.wry);
add('filler', 'Keep it close. More coming up.');
add('filler', 'Stay right there. Plenty more in the crate.', E.soft);
add('filler', 'No chatter now, just records.', E.dry);
add('filler', 'Settle in. There is more where that came from.', E.soft);
add('filler', 'I will be quiet now. Mostly.', E.wry);
add('filler', 'The best radio is the part with the music in it.', E.wry);
add('filler', 'That is all from me for a while. Enjoy.', E.soft);
add('filler', 'Take a breath. {pause:400} Good. Back to it.', E.soft);
add('filler', 'Up next, more of your music, selected with great care and a random number generator.', E.wry);
add('filler', 'Whatever comes next is bound to be one of yours.', E.dry);
add('filler', 'Let the next one in.', E.soft);
add('filler', 'Alright, where was I? Oh yes, nowhere. Music!', E.play);
add('filler', "Nobody ever said 'less music'. So here is more.", E.wry);
add('filler', 'Keep listening. I will keep it short.', E.dry);
add('filler', 'We go on.', E.dry);
add('filler', 'The record keeps spinning, or the equivalent.', E.wry);
add('filler', 'Sit back. This is the easy part.', E.soft);
add('filler', 'Right. Over to the music.', { energy: 0.55 });
add('filler', 'Enough of my voice. Here is yours, in a way.', E.play);
add('filler', 'More in a moment, after the songs.', E.dry);
add('filler', 'Turn it up, if you like.', { ...E.hype, tone: 'high' });
add('filler', 'Lean back and let it play.', { ...E.soft, tone: 'low' });

// ── banter: two hosts, one exchange (kept short, never about facts we do not have) ──
duet('banter', 'Do you ever get tired of playing songs?', "I'm an automated host. I do not get tired. I do get bored of this question.", { energy: 0.5 });
duet('banter', 'I think that last one deserved applause.', 'We are a pair of voices on a phone. I will clap in spirit.');
duet('banter', 'Pop quiz. Who picked this playlist?', 'You did. Always you. We just stand in the doorway and announce it.');
duet('banter', 'Do you think anyone is listening?', 'One person is. That is the best crowd there is.', { emotion: 'warm', energy: 0.4 });
duet('banter', 'I had a joke about radio, but it did not carry.', 'That was the best part, and also the worst part.');
duet('banter', 'Should we say something clever now?', "We could. Or we could play a song, which is cleverer.");
duet('banter', 'I would like to thank the listener.', 'And I would like to thank the shuffle button, for doing most of the work.');
duet('banter', 'What do you think the next song will be?', 'I know exactly. I am not allowed to tell you, because I do not know either.');
duet('banter', 'Are we on the air?', 'We are always on the air. Whether anyone minds is another matter.', { emotion: 'playful', energy: 0.6 });
duet('banter', 'Be honest. Is this the best radio station in your pocket?', 'It is the only radio station in your pocket, which makes it the best by default.');

// ── sign-off ─────────────────────────────────────────────────────────────────
add('sign_off', "That's all from [station]. Thanks for listening, and take care.", { energy: 0.4 });
add('sign_off', 'We will leave the rest of the records for another day. This has been [station].', E.soft);
add('sign_off', 'Thanks for the company. [hostA] and [hostB], signing off from [station].', E.soft);
add('sign_off', "Goodbye for now. The crate's still full whenever you want us back.", E.soft);
add('sign_off', 'And that is the end of the show. It was lovely having you here.', E.wist);
add('sign_off', "That's [station] for now. Be kind to yourself.", E.soft);
add('sign_off', 'Signing off. I am an automated host, so I will not wave, but I would.', E.wry);
add('sign_off', 'Until next time. Keep the music close.', E.soft);

export const BANK = Object.freeze(out.map((e, i) => Object.freeze({ ...e, id: `${e.kind}.${hashSeed(e.lines ? e.lines.map((l) => l.text).join('|') : e.text).toString(36)}`, order: i })));

/** How many spoken lines the bank holds (a duet counts as two). */
export const BANK_LINE_COUNT = BANK.reduce((a, e) => a + (e.lines ? e.lines.length : 1), 0);
