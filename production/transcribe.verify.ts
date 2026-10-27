// Verifies the parts of `occ transcribe` that can be checked without a model:
// the whisper.cpp JSON reader and the path resolution. The binary itself is
// exercised by running the command; this file keeps the parsing rules honest so
// a change to them cannot silently produce a broken timing profile.
//
//   npx tsx production/transcribe.verify.ts

import assert from 'node:assert/strict';
import { installedWhisperModels, tokensFromWhisperJson, whisperBinary, whisperModelPath, WHISPER_MODELS } from './transcribe.ts';

// --- token extraction -----------------------------------------------------
//
// whisper.cpp emits one token per character for Chinese, with `offsets` in
// milliseconds. `-ojf` also emits special tokens that carry timings but no
// speech; a caption highlight must never land on one.

const json = {
  result: { language: 'zh' },
  transcription: [
    {
      offsets: { from: 0, to: 1000 },
      text: '关于复利',
      tokens: [
        { text: '[_BEG_]', offsets: { from: 0, to: 0 } },
        { text: ' 关', offsets: { from: 0, to: 200 } },
        { text: '于', offsets: { from: 200, to: 350 } },
        { text: '[_TT_120]', offsets: { from: 350, to: 360 } },
        { text: '复', offsets: { from: 360, to: 500 } },
        { text: '利', offsets: { from: 500, to: 1000 } },
      ],
    },
  ],
};

const tokens = tokensFromWhisperJson(json);
assert.deepEqual(tokens.map((token) => token.text), ['关', '于', '复', '利'], 'special tokens are dropped');
assert.deepEqual(tokens.map((token) => token.start), [0, 200, 360, 500], 'offsets are carried through');
assert.equal(tokens[0]!.text, '关', 'leading whitespace is trimmed off a token');
assert.equal(tokens[3]!.end, 1000, 'the last token keeps its end');

// A zero-length token cannot place a highlight.
assert.deepEqual(
  tokensFromWhisperJson({ transcription: [{ tokens: [{ text: '啊', offsets: { from: 100, to: 100 } }] }] }),
  [],
  'zero-length tokens are dropped',
);

// Overlapping tokens would make the list non-monotonic, which a consumer walks
// as a timeline. They are clamped rather than dropped: dropping loses a syllable.
const clamped = tokensFromWhisperJson({
  transcription: [{ tokens: [
    { text: 'a', offsets: { from: 100, to: 200 } },
    { text: 'b', offsets: { from: 150, to: 300 } },
    { text: 'c', offsets: { from: 400, to: 500 } },
  ] }],
});
assert.deepEqual(clamped.map((token) => token.text), ['a', 'b', 'c'], 'an overlapping token is kept');
assert.equal(clamped[1]!.start, 200, 'its start is clamped to the previous end');
assert.equal(clamped[1]!.end, 300, 'its end is untouched');
assert.ok(clamped[1]!.start >= clamped[0]!.end, 'the timeline stays walkable');

// A token fully swallowed by the previous one has nothing left to place.
assert.deepEqual(
  tokensFromWhisperJson({
    transcription: [{ tokens: [
      { text: 'a', offsets: { from: 100, to: 500 } },
      { text: 'b', offsets: { from: 120, to: 300 } },
    ] }],
  }).map((token) => token.text),
  ['a'],
  'a fully overlapped token is dropped',
);

// Missing or malformed offsets must not produce NaN timings.
assert.deepEqual(
  tokensFromWhisperJson({ transcription: [{ tokens: [{ text: 'x' }, { text: 'y', offsets: { from: 0 } }] }] }),
  [],
  'tokens without both offsets are dropped',
);
assert.deepEqual(tokensFromWhisperJson({}), [], 'an empty document yields nothing');
assert.deepEqual(tokensFromWhisperJson({ transcription: [] }), [], 'no segments yields nothing');

// --- paths ----------------------------------------------------------------

assert.ok(whisperModelPath('base').endsWith(`ggml${process.platform === 'win32' ? '\\' : '/'}ggml-base-q5_1.bin`), 'model path uses the app cache layout');
assert.equal(Object.keys(WHISPER_MODELS).length, 5, 'every catalogue tier is known');
assert.throws(() => whisperModelPath('huge' as never), /unknown whisper model/, 'an unknown tier is rejected');

// The binary is looked up per platform; a missing build must be null, not a throw.
const binary = whisperBinary(process.cwd());
assert.ok(binary === null || binary.endsWith('.exe') || binary.endsWith('whisper-cli'), 'binary lookup returns a path or null');
assert.ok(Array.isArray(installedWhisperModels()), 'installed models is always a list');

console.log('transcribe.verify: token extraction, clamping and paths OK');
