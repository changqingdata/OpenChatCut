// Verifies the caption builder: word splitting, timing coverage, and the page
// breaks that keep one subtitle line from bleeding into the next.
//
//   npx tsx production/captions.verify.ts

import assert from 'node:assert/strict';
import { buildCaptions, splitCueText, wordsFromCues } from './captions.ts';
import { parseSrtCues } from './srt.ts';

// --- splitting ------------------------------------------------------------

assert.deepEqual(splitCueText('关于复利'), ['关', '于', '复', '利'], 'CJK splits per character');
assert.deepEqual(splitCueText('每天进步 1%'), ['每', '天', '进', '步', '1%'], 'latin runs stay whole');
assert.deepEqual(splitCueText('hello world'), ['hello', 'world'], 'latin splits on spaces');
assert.deepEqual(splitCueText('复利，很重要'), ['复', '利，', '很', '重', '要'], 'punctuation attaches to the previous unit');
assert.deepEqual(splitCueText('每天 1%，然后'), ['每', '天', '1%，', '然', '后'], 'punctuation after latin attaches too');
assert.deepEqual(splitCueText('   '), [], 'whitespace yields nothing');

// --- timing ---------------------------------------------------------------

const SRT = `1
00:00:00,000 --> 00:00:02,000
关于复利

2
00:00:02,000 --> 00:00:04,000
每天进步百分之一
`;

const cues = parseSrtCues(SRT);
assert.equal(cues.length, 2, 'two cues parsed');

const words = wordsFromCues(cues);
assert.equal(words.length, 4 + 8, 'one entry per character across both cues');
assert.equal(words[0]!.start, 0, 'first word starts at the cue start');
assert.equal(words[words.length - 1]!.end, 4000, 'last word ends at the cue end');

// Every word must have positive duration and they must not overlap.
for (let i = 0; i < words.length; i += 1) {
  assert.ok(words[i]!.end > words[i]!.start, `word ${i} has no duration`);
  if (i > 0) assert.ok(words[i]!.start >= words[i - 1]!.end, `word ${i} overlaps its predecessor`);
}

// The split must be proportional: a 4-character cue over 2000ms gives ~500ms each.
assert.equal(words[0]!.end - words[0]!.start, 500, 'cue duration split evenly across characters');

// --- captions -------------------------------------------------------------

const captions = buildCaptions(cues);
assert.equal(captions.enabled, true, 'captions are on by default');
assert.equal(captions.pacing, 'phrase', 'phrase pacing keeps a line together');
assert.equal(captions.words?.length, words.length, 'words carried through');
assert.equal(captions.offsetFrames, 0, 'voiceover starts at frame 0');

// Without page breaks the engine groups by its own length heuristics and three
// cues run together into one page. The break has to land on the first word of
// every cue after the first.
const overrides = captions.wordOverrides ?? {};
assert.equal(Object.keys(overrides).length, 1, 'one break for two cues');
assert.equal(overrides[4]?.forceBreak, true, 'break lands on the first word of cue 2');
assert.equal(overrides[0], undefined, 'the first cue needs no break');

// A single cue must not produce a leading break, which would show an empty page.
const single = buildCaptions(parseSrtCues('00:00:00,000 --> 00:00:01,000\n只有一句\n'));
assert.equal(single.wordOverrides, undefined, 'a single cue needs no overrides');

// Template choice is overridable and defaults to the one drawn in Smiley Sans.
assert.equal(buildCaptions(cues).template, 'deyi-card', 'default template is deyi-card');
assert.equal(buildCaptions(cues, { template: 'tiktok' }).template, 'tiktok', 'template override applies');
assert.equal(buildCaptions(cues, { enabled: false }).enabled, false, 'captions can be disabled');

// --- measured timing ------------------------------------------------------
//
// One cue, four characters, four seconds — but the speaker said the first three
// in half a second and then paused before the last. An estimate spreads that
// evenly and puts "利" at 3s; the measured version has to put it at 3.5s.

const uneven = parseSrtCues('00:00:00,000 --> 00:00:04,000\n关于复利\n');
const timing = {
  model: 'test',
  language: 'zh',
  durationMs: 4000,
  tokens: [
    { text: '关', start: 0, end: 200 },
    { text: '于', start: 200, end: 350 },
    { text: '复', start: 350, end: 500 },
    { text: '利', start: 3500, end: 4000 },
  ],
};

const estimated = wordsFromCues(uneven);
const measured = wordsFromCues(uneven, timing);
assert.deepEqual(measured.map((word) => word.text), ['关', '于', '复', '利'], 'measured timing keeps the subtitle text');
assert.equal(estimated[3]!.start, 3000, 'the estimate puts the last character at 3/4 of the cue');
assert.equal(measured[3]!.start, 3500, 'the measurement puts it where it was spoken');
assert.equal(measured[0]!.start, 0, 'the first character still starts with the cue');
assert.equal(measured[3]!.end, 4000, 'the last character still ends with the cue');
assert.equal(measured[2]!.end, 3500, 'the character before the pause holds the highlight through it');

// When the model's token count differs from the line's character count — it
// merges and splits differently, and punctuation rides along with a character —
// the tokens become a speech-density curve instead of a one-to-one mapping.
const merged = wordsFromCues(uneven, {
  model: 'test',
  language: 'zh',
  durationMs: 4000,
  tokens: [
    { text: '关于', start: 0, end: 200 },
    { text: '复', start: 200, end: 500 },
    { text: '利', start: 3500, end: 4000 },
  ],
});
assert.equal(merged.length, 4, 'unit count comes from the text, not the tokens');
assert.equal(merged[3]!.start, 3750, 'the density curve still lands late, near the real syllable');
assert.notEqual(merged[3]!.start, estimated[3]!.start, 'and still beats the flat estimate');

// Whatever the placement, the words must stay inside the cue and walk forward.
for (let index = 0; index < measured.length; index += 1) {
  const word = measured[index]!;
  assert.ok(word.start >= 0 && word.end <= 4000, `word ${index} stays inside the cue`);
  assert.ok(word.end > word.start, `word ${index} has positive length`);
  if (index > 0) assert.ok(word.start >= measured[index - 1]!.end, `word ${index} does not overlap the previous one`);
}

// A cue the model heard nothing in must fall back, not collapse to zero length.
const silent = wordsFromCues(uneven, { model: 'test', language: 'zh', durationMs: 0, tokens: [] });
assert.deepEqual(silent, estimated, 'an empty profile falls back to the estimate');

// Tokens from a neighbouring cue must not leak into this one.
const shifted = wordsFromCues(uneven, {
  model: 'test',
  language: 'zh',
  durationMs: 9000,
  tokens: [{ text: '别的', start: 6000, end: 9000 }],
});
assert.deepEqual(shifted, estimated, 'tokens outside the cue are ignored');

console.log('captions.verify: splitting, timing, page breaks and defaults OK');
