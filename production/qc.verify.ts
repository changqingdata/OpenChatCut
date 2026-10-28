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
  /** Declared widthRatio; defaults to 0.85. */
  ratio?: number;
  /** Frames of nothing before this shot. */
  gapBefore?: number;
  /** What is being said under this shot — the caption's text. */
  narration?: string;
  /** Fade this shot in, as a section change. */
  fade?: boolean;
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
    narration: { text: spec.narration ?? '', startMs: startFrame * 33, endMs: (startFrame + frames) * 33 },
    ...(spec.fade ? { transitionIn: { type: 'fade' as const, durationInFrames: 12 } } : {}),
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
      layout: { anchor, widthRatio: spec.ratio ?? 0.85 },
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

// --- footage floor --------------------------------------------------------

// Ten cards and no clips is a slide deck. The pipeline cannot invent a subject,
// so the only useful thing it can do is say so loudly enough for the agent to
// go back and fix the brief.
const allCards = board([
  { recipe: 'keyword-punch' }, { recipe: 'number-count' }, { recipe: 'list-reveal' },
  { recipe: 'compare-stack' }, { recipe: 'bar-compare' }, { recipe: 'line-chart' },
]);
assert.ok(codes(allCards).includes('footage-scarce'), 'a card-only cut is flagged');
const someFootage = board([
  { recipe: 'keyword-punch', footage: 'clock' }, { recipe: 'number-count' },
  { recipe: 'list-reveal' }, { recipe: 'compare-stack', footage: 'hourglass' },
  { recipe: 'bar-compare' }, { recipe: 'line-chart' },
]);
assert.ok(!codes(someFootage).includes('footage-scarce'), 'two clips in six clears the floor');

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

// The same recipe at three different anchors is three different pictures; only
// the recipe id would call this a repeat and push the model to invent a new
// recipe instead of moving the one it has.
const sameRecipeDifferentPlace = board([
  { recipe: 'keyword-punch', anchor: 'tc' },
  { recipe: 'keyword-punch', anchor: 'ml' },
  { recipe: 'keyword-punch', anchor: 'bc' },
]);
assert.ok(!codes(sameRecipeDifferentPlace).includes('recipe-repeat'),
  'the same recipe at different anchors is not a repeat');

const sameRecipeSamePlace = board([
  { recipe: 'keyword-punch', anchor: 'mc' },
  { recipe: 'keyword-punch', anchor: 'mc' },
  { recipe: 'keyword-punch', anchor: 'mc' },
]);
assert.ok(codes(sameRecipeSamePlace).includes('recipe-repeat'),
  'the same recipe in the same place still is');

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

// A narrow card hanging left on a solid background leaves half the frame
// empty — the shape that reads as an unfinished slide.
const narrowLeft = board(Array.from({ length: 4 }, () => ({ anchor: 'ml' as const, ratio: 0.5 })));
assert.ok(codes(narrowLeft).includes('solid-offcentre'), 'narrow left card on a solid background warns');

// The same layout behind footage is a deliberate composition, not a defect.
const narrowLeftOverFootage = board(Array.from({ length: 4 }, () => ({ anchor: 'ml' as const, ratio: 0.5, footage: true })));
assert.ok(!codes(narrowLeftOverFootage).includes('solid-offcentre'), 'footage makes the same layout intentional');

// Widening the card fills the row, so the anchor stops mattering.
const wideLeft = board(Array.from({ length: 4 }, () => ({ anchor: 'ml' as const, ratio: 0.9 })));
assert.ok(!codes(wideLeft).includes('solid-offcentre'), 'a wide left card is fine');

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

// --- footage relevance ----------------------------------------------------

// A clip the model itself rated low is worse than a card: the viewer notices the
// mismatch immediately and stops trusting the picture.
const lowConfidence = board([{ footage: 'hourglass sand', assetId: 'clip-x' }]);
lowConfidence.shots[0]!.underlay = { ...lowConfidence.shots[0]!.underlay!, selected: true, confidence: 'low' };
assert.ok(codes(lowConfidence).includes('footage-low-confidence'), 'a low-rated clip that survived is flagged');

const rated = board([
  { footage: 'a', assetId: 'clip-a' },
  { recipe: 'number-count' },
  { recipe: 'list-reveal', footage: 'c', assetId: 'clip-c' },
]);
rated.shots[0]!.underlay = { ...rated.shots[0]!.underlay!, confidence: 'high' };
rated.shots[2]!.underlay = { ...rated.shots[2]!.underlay!, confidence: 'low' };
const ratedReport = runQc(rated);
assert.deepEqual(ratedReport.stats.footageConfidence, { high: 1, medium: 0, low: 1 }, 'confidence is counted');
assert.equal(ratedReport.stats.footageRelevance, 0.5, 'relevance is high+medium over all rated');

// A subject of "-" means the sentence names nothing photographable. Rating the
// clip above `low` contradicts that, and the pair is only useful if it agrees.
const contradictory = board([{ footage: 'hourglass sand' }]);
contradictory.shots[0]!.underlay = { ...contradictory.shots[0]!.underlay!, confidence: 'medium', subject: '-' };
const contradictionReport = runQc(contradictory);
assert.ok(contradictionReport.findings.some((f) => f.code === 'footage-subject-mismatch'),
  'no subject but a confident rating is flagged');
assert.equal(contradictionReport.stats.abstractShots, 1, 'abstract shots are counted');

const honest = board([{ footage: 'hourglass sand' }]);
honest.shots[0]!.underlay = { ...honest.shots[0]!.underlay!, confidence: 'low', subject: '-' };
assert.ok(!codes(honest).includes('footage-subject-mismatch'), 'a consistent pair passes');

// --- rhythm ---------------------------------------------------------------

// Five shots of the same length read as a metronome, even when each one is fine.
const metronome = board(Array.from({ length: 5 }, (_, i) => ({ recipe: `r${i}` })));
assert.ok(codes(metronome).includes('rhythm-flat'), 'five equal shots are flagged');

// Varied lengths are the point: same shot count, different durations.
const varied = board([
  { recipe: 'a', seconds: 2.0 }, { recipe: 'b', seconds: 3.8 }, { recipe: 'c', seconds: 2.2 },
  { recipe: 'd', seconds: 4.0 }, { recipe: 'e', seconds: 5.5 },
]);
assert.ok(!codes(varied).includes('rhythm-flat'), 'varied lengths pass');

// --- transitions ----------------------------------------------------------

const hardCuts = board(Array.from({ length: 10 }, (_, i) => ({ recipe: `r${i}`, seconds: 2 + (i % 3) })));
assert.ok(codes(hardCuts).includes('no-transition'), 'ten hard cuts are noted');

const withFade = board(Array.from({ length: 10 }, (_, i) => ({ recipe: `r${i}`, seconds: 2 + (i % 3) })));
withFade.shots[4] = { ...withFade.shots[4]!, transitionIn: { type: 'fade', durationInFrames: 12 } };
assert.ok(!codes(withFade).includes('no-transition'), 'one fade clears the note');
assert.equal(runQc(withFade).stats.transitions, 1, 'transitions are counted');

// A fade on every cut is the other failure, and the one that actually shipped:
// two of six storyboards had one, because the output shape showed the field on
// the example shot and the model copied the shape.
const allFades = board(Array.from({ length: 9 }, (_, i) => ({ recipe: `r${i}`, seconds: 2 + (i % 3), fade: true })));
assert.ok(codes(allFades).includes('transition-overuse'), 'a fade on every cut is flagged');
const threeFades = board(Array.from({ length: 9 }, (_, i) => ({ recipe: `r${i}`, seconds: 2 + (i % 3), fade: i < 3 })));
assert.ok(!codes(threeFades).includes('transition-overuse'), 'three fades in nine shots is fine');

// --- card echoes the caption ----------------------------------------------

// A quote card that repeats the spoken line makes the viewer read the same
// sentence twice at two speeds. A keyword card is the intended overlap.
const echoing = board([
  {
    recipe: 'quote-card',
    params: { text: '重要的不是一次做多少，而是能不能坚持去做' },
    narration: '重要的不是一次做多少，而是能不能坚持去做',
  },
  { recipe: 'number-count' },
  { recipe: 'list-reveal' },
  { recipe: 'compare-stack' },
]);
assert.ok(codes(echoing).includes('text-echoes-caption'), 'a card that repeats the line is noted');
const keyword = board([
  { recipe: 'keyword-punch', params: { text: '时间' }, narration: '时间才是真正的燃料' },
  { recipe: 'number-count' },
  { recipe: 'list-reveal' },
  { recipe: 'compare-stack' },
]);
assert.ok(!codes(keyword).includes('text-echoes-caption'), 'a two-character keyword is not an echo');

// --- formatting -----------------------------------------------------------

const lines = formatFindings(runQc(gapped));
assert.ok(lines[0]!.startsWith('ERROR'), 'errors sort first');
assert.ok(lines.some((line) => line.includes('frame-gap')), 'the code appears in the line');

console.log('qc.verify: coverage, pacing, vocabulary, footage, layout, text and formatting OK');
