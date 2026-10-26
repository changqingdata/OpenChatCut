// Verifies every QC rule fires on the shape it exists for, and stays quiet on a
// clean board. A rule that cannot be shown to fire is a rule that will never
// help.
//
//   npx tsx production/qc.verify.ts

import assert from 'node:assert/strict';
import { formatFindings, runQc } from './qc.ts';
import type { RecipeSchema } from './recipes/load.ts';
import type { Shot, Storyboard } from './types.ts';

const META = {
  title: 'qc',
  runId: 'qc',
  aspect: '9:16' as const,
  width: 1080,
  height: 1920,
  fps: 30,
  language: 'zh',
};

type Anchor = 'tl' | 'tc' | 'tr' | 'ml' | 'mc' | 'mr' | 'bl' | 'bc' | 'br' | 'full';

interface ShotSpec {
  recipe?: string;
  anchor?: Anchor;
  seconds?: number;
  footage?: string | boolean;
  assetId?: string;
  params?: Record<string, unknown>;
  /** Frames of nothing before this shot. */
  gapBefore?: number;
}

function shot(index: number, startFrame: number, spec: ShotSpec = {}): Shot {
  const seconds = spec.seconds ?? 3;
  const frames = Math.round(seconds * 30);
  const anchor = spec.anchor ?? 'mc';
  const footage = spec.footage;
  return {
    id: `S${String(index + 1).padStart(2, '0')}`,
    startFrame,
    endFrame: startFrame + frames,
    narration: { text: '', startMs: startFrame * 33, endMs: (startFrame + frames) * 33 },
    intent: 'x',
    ...(footage
      ? {
        underlay: {
          query: typeof footage === 'string' ? footage : `clip ${index}`,
          ...(spec.assetId ? { assetId: spec.assetId } : {}),
          selected: true,
        },
      }
      : { background: '#0B0B0C' }),
    visual: {
      kind: 'mg' as const,
      recipe: spec.recipe ?? 'keyword-punch',
      params: spec.params ?? {},
      layout: { anchor, widthRatio: 0.85 },
    },
  };
}

/** Shots back to back, so durations decide the timeline. */
function board(specs: ShotSpec[]): Storyboard {
  let cursor = 0;
  const shots = specs.map((spec, index) => {
    cursor += spec.gapBefore ?? 0;
    const built = shot(index, cursor, spec);
    cursor = built.endFrame;
    return built;
  });
  return {
    version: 1,
    meta: META,
    rhythm: { avgShotSec: 3, maxShotSec: 6, grammarChangeEverySec: 6, maxRepeatRecipe: 2, hookMaxSec: 3 },
    shots,
  };
}

function codes(storyboard: Storyboard, options = {}): string[] {
  return runQc(storyboard, options).findings.map((finding) => finding.code);
}

// --- clean board ----------------------------------------------------------

// Four different recipes, no footage adjacency, even pacing: nothing to say.
const clean = board([
  { recipe: 'keyword-punch' },
  { recipe: 'number-count' },
  { recipe: 'list-reveal' },
  { recipe: 'compare-stack' },
]);
const cleanReport = runQc(clean);
assert.equal(cleanReport.ok, true, 'a clean board passes');
assert.deepEqual(cleanReport.findings.map((f) => f.code), [], 'a clean board raises nothing');
assert.equal(cleanReport.stats.shots, 4, 'stats count the shots');
assert.equal(cleanReport.stats.distinctRecipes, 4, 'stats count the vocabulary');

// --- coverage -------------------------------------------------------------

// A hole renders as a black frame. It is the only error-level rule.
const gapped = board([{ seconds: 3 }, { seconds: 3, gapBefore: 20 }]);
const gapReport = runQc(gapped);
assert.equal(gapReport.ok, false, 'a gap fails the report');
assert.ok(gapReport.findings.some((f) => f.code === 'frame-gap' && f.severity === 'error'), 'the gap is an error');

// --- pacing ---------------------------------------------------------------

assert.ok(codes(board([{ seconds: 0.5 }, { recipe: 'number-count' }])).includes('shot-too-short'), 'a half-second shot is flagged');

// Five cuts inside six seconds. Each shot is legal; the sequence stutters.
const burst = board([{ seconds: 1.3 }, { seconds: 1.3, recipe: 'number-count' }, { seconds: 1.3, recipe: 'list-reveal' },
  { seconds: 1.3, recipe: 'compare-stack' }, { seconds: 1.3, recipe: 'quote-card' }]);
assert.ok(codes(burst).includes('cut-burst'), 'five cuts in 6.5s is a burst');

// --- vocabulary -----------------------------------------------------------

assert.ok(codes(board([{ recipe: 'keyword-punch' }, { recipe: 'keyword-punch' }, { recipe: 'keyword-punch' }]))
  .includes('recipe-repeat'), 'three in a row of one recipe is flagged');

const dominant = board(Array.from({ length: 8 }, (_, i) => ({ recipe: i < 5 ? 'keyword-punch' : `r${i}` })));
assert.ok(codes(dominant).includes('recipe-dominance'), 'one recipe over 45% is flagged');

assert.ok(codes(board(Array.from({ length: 8 }, () => ({ recipe: 'keyword-punch' }))))
  .includes('recipe-variety'), 'a thin vocabulary is noted');

// --- footage --------------------------------------------------------------

const adjacent = board([
  { footage: 'a' },
  { recipe: 'number-count', footage: 'b' },
]);
assert.ok(codes(adjacent).includes('footage-adjacent'), 'two footage shots in a row is flagged');

const reused = board([
  { footage: 'a', assetId: 'clip-1' },
  { recipe: 'number-count' },
  { recipe: 'list-reveal', footage: 'c', assetId: 'clip-1' },
]);
assert.ok(codes(reused).includes('footage-duplicate-clip'), 'the same clip twice is flagged');

const repeatedQuery = board([
  { footage: 'hourglass sand' },
  { recipe: 'number-count' },
  { recipe: 'list-reveal', footage: 'hourglass sand' },
]);
const queryFindings = runQc(repeatedQuery).findings;
assert.ok(queryFindings.some((f) => f.code === 'footage-duplicate-query' && f.severity === 'note'),
  'the same search twice is noted, not warned');

// --- layout ---------------------------------------------------------------

const bottomCards = board(Array.from({ length: 4 }, () => ({ anchor: 'bc' as const })));
const layoutReport = runQc(bottomCards, { captions: true });
assert.ok(layoutReport.findings.some((f) => f.code === 'anchor-under-captions'), 'bottom anchors over captions are noted');

// Without captions a bottom anchor is legitimate.
assert.ok(!codes(bottomCards).includes('anchor-under-captions'), 'no captions, no collision');

// --- text -----------------------------------------------------------------

const schemas = new Map<string, RecipeSchema>([[
  'keyword-punch',
  {
    id: 'keyword-punch',
    name: 'Keyword',
    box: { width: 900, height: 520 },
    params: { text: { type: 'string', maxChars: 10 }, tail: { type: 'string', maxChars: 18 } },
  },
]]);

// 9 of 10 characters: one edit from being rejected.
const nearLimit = board([{ recipe: 'keyword-punch', params: { text: '复利效应确实很大啊', tail: '每天进步百分之一' } }]);
const textReport = runQc(nearLimit, { schemas });
assert.ok(textReport.findings.some((f) => f.code === 'text-near-limit'), 'text close to its limit is noted');
assert.ok(
  textReport.findings.filter((f) => f.code === 'text-near-limit').every((f) => f.severity === 'note'),
  'it is a note, not a defect',
);

// A short limit is a design constraint, not a risk: big-word-fill wants exactly
// one or two characters, so sitting at its limit is the point.
const shortLimit = new Map<string, RecipeSchema>([['big-word-fill', {
  id: 'big-word-fill', name: 'Big', box: { width: 1080, height: 1920 },
  params: { text: { type: 'string', maxChars: 2 } },
}]]);
assert.ok(!codes(board([{ recipe: 'big-word-fill', params: { text: '复利' } }]), { schemas: shortLimit })
  .includes('text-near-limit'), 'a two-character design is not a text overrun');

// --- formatting -----------------------------------------------------------

const lines = formatFindings(runQc(gapped));
assert.ok(lines[0]!.startsWith('ERROR'), 'errors sort first');
assert.ok(lines.some((line) => line.includes('frame-gap')), 'the code appears in the line');

console.log('qc.verify: coverage, pacing, vocabulary, footage, layout, text and formatting OK');
