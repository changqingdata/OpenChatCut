// Verifies the generation contract: SRT parsing, prompt content, JSON
// extraction, and the validation that gates a model's output.
//
//   npx tsx production/generate.verify.ts

import assert from 'node:assert/strict';
import { parseSrtCues } from './srt.ts';
import { buildStoryboardPrompt, checkStoryboard, extractJson, repairPrompt } from './generate.ts';
import type { RecipeSchema } from './recipes/load.ts';

// --- SRT --------------------------------------------------------------

const SRT = `1
00:00:00,100 --> 00:00:01,033
关于复利

2
00:00:01,033 --> 00:00:03,066
有一个流传很广的说法

3
00:00:03,233 --> 00:00:05,600
假设你每天进步1%
`;

const cues = parseSrtCues(SRT);
assert.equal(cues.length, 3, 'parses every cue');
assert.equal(cues[0]!.startMs, 100, 'milliseconds parsed');
assert.equal(cues[2]!.endMs, 5600, 'end timestamp parsed');
assert.equal(cues[1]!.text, '有一个流传很广的说法', 'text kept verbatim');

// Index lines are optional in the wild; a bare block still parses.
const bare = parseSrtCues('00:00:01,000 --> 00:00:02,500\n只有时间码\n');
assert.equal(bare.length, 1, 'cue without an index line still parses');

// Broken timing is skipped rather than producing a zero-length cue.
assert.equal(parseSrtCues('1\n00:00:05,000 --> 00:00:02,000\n倒着的时间\n').length, 0, 'reversed timing is dropped');

// --- prompt -----------------------------------------------------------

const catalog = new Map<string, RecipeSchema>([
  ['keyword-punch', {
    id: 'keyword-punch',
    name: '关键词冲击',
    intent: '把关键词砸在画面上',
    box: { width: 900, height: 520 },
    params: {
      text: { type: 'string', required: true, maxChars: 6 },
      label: { type: 'string', maxChars: 10, default: '' },
      ink: { type: 'color', default: '#F2EFE9' },
    },
  }],
]);

const prompt = buildStoryboardPrompt({
  cues,
  brief: '讲复利',
  width: 1080,
  height: 1920,
  fps: 30,
  aspect: '9:16',
  language: 'zh',
  catalog,
});

assert.ok(prompt.user.includes('讲复利'), 'brief reaches the prompt');
assert.ok(prompt.user.includes('keyword-punch'), 'recipe ids reach the prompt');
assert.ok(prompt.user.includes('maxChars=6'), 'param constraints reach the prompt');
assert.ok(prompt.user.includes('关于复利'), 'cue text reaches the prompt');
assert.ok(prompt.user.includes('总时长约 5.6 秒'), 'duration is derived from the last cue');
assert.ok(prompt.user.includes('5.60'), 'cue timestamps are formatted');
// Colour and font params are noise for a director; they must not be listed.
assert.ok(!prompt.user.includes('- ink:'), 'presentation params are omitted from the catalog');

// --- JSON extraction --------------------------------------------------

assert.deepEqual(extractJson('{"a":1}'), { a: 1 }, 'bare JSON');
assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 }, 'fenced JSON');
assert.deepEqual(extractJson('好的，这是分镜：\n{"a":1}\n希望有用'), { a: 1 }, 'JSON padded with prose');
assert.throws(() => extractJson('没有 JSON'), /no JSON object/, 'missing JSON throws');

// --- validation -------------------------------------------------------

function shot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'S01',
    beatId: 'b1',
    startFrame: 0,
    endFrame: 90,
    narration: { text: '关于复利', startMs: 0, endMs: 3000 },
    intent: '点题',
    visual: {
      kind: 'mg',
      recipe: 'keyword-punch',
      params: { text: '复利' },
      layout: { anchor: 'full', widthRatio: 1 },
    },
    ...overrides,
  };
}

function board(shots: unknown[], extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    meta: {
      title: 't', runId: 'r', aspect: '9:16',
      width: 1080, height: 1920, fps: 30, language: 'zh',
    },
    rhythm: { avgShotSec: 3, maxShotSec: 8, grammarChangeEverySec: 6, maxRepeatRecipe: 2, hookMaxSec: 3 },
    beats: [{ id: 'b1', role: 'hook', text: '点题', startMs: 0, endMs: 3000, shotIds: ['S01'] }],
    shots,
    ...extra,
  };
}

const good = checkStoryboard(board([shot()]), catalog);
assert.equal(good.ok, true, 'valid storyboard passes');
assert.deepEqual(good.storyboard?.shots[0]?.visual, {
  kind: 'mg',
  recipe: 'keyword-punch',
  params: { text: '复利', label: '', ink: '#F2EFE9' },
  layout: { anchor: 'full', widthRatio: 1 },
}, 'schema defaults are merged into the params');

const unknownRecipe = checkStoryboard(board([shot({
  visual: { kind: 'mg', recipe: 'nope', params: {}, layout: { anchor: 'full', widthRatio: 1 } },
})]), catalog);
assert.equal(unknownRecipe.ok, false, 'unknown recipe is rejected');
assert.ok(unknownRecipe.errors.some((error) => error.includes('unknown recipe')), 'error names the problem');

const tooLong = checkStoryboard(board([shot({
  visual: { kind: 'mg', recipe: 'keyword-punch', params: { text: '七个字的超长关键词' }, layout: { anchor: 'full', widthRatio: 1 } },
})]), catalog);
assert.equal(tooLong.ok, false, 'over-long param is rejected');
assert.ok(tooLong.errors.some((error) => error.includes('maxChars') || error.includes('over the 6 limit')), 'error names the limit');

const noIntent = checkStoryboard(board([shot({ intent: '' })]), catalog);
assert.equal(noIntent.ok, false, 'missing intent is rejected');

// Structural problems must surface too, not just param problems.
const gap = checkStoryboard(board([shot({ startFrame: 100 })]), catalog);
assert.equal(gap.ok, false, 'a timeline that starts late is rejected');

// The repair prompt has to carry the actual errors, or the retry is blind.
const repair = repairPrompt(['S01: "label" is 11 chars, over the 10 limit']);
assert.ok(repair.includes('S01'), 'repair prompt names the shot');
assert.ok(repair.includes('over the 10 limit'), 'repair prompt carries the constraint');

console.log('generate.verify: srt, prompt, json extraction, validation and repair OK');
