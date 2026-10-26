// Verifies the footage policy: density, spacing, protection and the fallback
// that keeps a deselected shot from rendering on transparency.
//
//   npx tsx production/footage-policy.verify.ts

import assert from 'node:assert/strict';
import { DEFAULT_FOOTAGE_POLICY, applyFootagePolicy } from './footage-policy.ts';
import type { Shot, Storyboard } from './types.ts';

const META = {
  title: 'policy',
  runId: 'policy',
  aspect: '9:16' as const,
  width: 1080,
  height: 1920,
  fps: 30,
  language: 'zh',
};

/** A board of `count` three-second shots; `queryFor` decides who proposes footage. */
function board(count: number, queryFor: (index: number) => string | null, essentialFor: (index: number) => boolean = () => false): Storyboard {
  const shots: Shot[] = Array.from({ length: count }, (_, index) => {
    const query = queryFor(index);
    return {
      id: `S${String(index + 1).padStart(2, '0')}`,
      startFrame: index * 90,
      endFrame: (index + 1) * 90,
      narration: { text: '', startMs: index * 3000, endMs: (index + 1) * 3000 },
      intent: 'x',
      // An overlay, not a card: a full-frame visual would hide the footage.
      visual: { kind: 'mg' as const, recipe: 'r', params: {}, layout: { anchor: 'mc' as const, widthRatio: 0.9 } },
      ...(query ? { underlay: { query, ...(essentialFor(index) ? { essential: true } : {}) } } : {}),
    };
  });
  return { version: 1, meta: META, rhythm: { avgShotSec: 3, maxShotSec: 6, grammarChangeEverySec: 6, maxRepeatRecipe: 2, hookMaxSec: 3 }, shots };
}

// --- density --------------------------------------------------------------

const all = board(8, (index) => `clip ${index}`);
const policed = applyFootagePolicy(all);
assert.equal(policed.target, 3, 'eight shots at 0.34 asks for three clips');
assert.equal(policed.kept.length, 3, 'the ratio is met');
assert.deepEqual(policed.kept, ['S01', 'S03', 'S05'], 'clips land on every other shot from the top');
assert.equal(policed.storyboard.shots.at(-1)!.underlay?.selected, false, 'the closing shot is turned down');

// Spacing: no two chosen shots may be adjacent at minGapShots = 1.
const indexes = policed.kept.map((id) => Number(id.slice(1)));
for (let i = 1; i < indexes.length; i += 1) {
  assert.ok(indexes[i]! - indexes[i - 1]! > 1, 'clips are never adjacent');
}

// --- essentials -----------------------------------------------------------

// An essential shot is kept even when it sits next to another clip and the
// ratio is already met — the model saw something the arithmetic cannot.
const withEssential = board(8, (index) => `clip ${index}`, (index) => index === 6);
const essentialResult = applyFootagePolicy(withEssential);
assert.ok(essentialResult.kept.includes('S07'), 'an essential shot is always kept');
assert.ok(essentialResult.kept.length >= 3, 'essentials do not shrink the total below the ratio');

// --- eligibility: no concrete subject -------------------------------------

// `subject: "-"` is the same judgement as `low` reached another way: there is
// nothing to photograph. Selecting it anyway would put a clip on an abstraction.
const abstract = board(6, (index) => `clip ${index}`);
abstract.shots[0]!.underlay = { ...abstract.shots[0]!.underlay!, subject: '-' };
assert.ok(!applyFootagePolicy(abstract).kept.includes('S01'), 'a shot with no concrete subject never carries footage');

// --- eligibility ----------------------------------------------------------

// A shot too short to read stays a card, and is not counted as unproposed.
const shortBoard = board(4, (index) => `clip ${index}`);
shortBoard.shots[1]!.endFrame = shortBoard.shots[1]!.startFrame + 12;
const shortResult = applyFootagePolicy(shortBoard);
assert.ok(!shortResult.kept.includes('S02'), 'a 12-frame shot never carries footage');

// A shot that proposed nothing is reported, because the model was conservative
// and the ratio cannot be met by inventing a query.
const quiet = board(8, (index) => (index < 2 ? `clip ${index}` : null));
const quietResult = applyFootagePolicy(quiet);
// Five, not six: the closing shot is protected, so its silence is not a gap.
assert.equal(quietResult.unproposed.length, 5, 'shots without a query are listed');
assert.ok(quietResult.kept.length <= 2, 'the ratio cannot exceed what was proposed');

// --- the fallback that prevents a transparency render ---------------------

// The model was told to skip `background` on anything it expected footage for,
// so a deselected shot must be given one — otherwise the base lane is empty.
const noBackground = board(8, (index) => `clip ${index}`);
for (const shot of noBackground.shots) delete shot.background;
const fallback = applyFootagePolicy(noBackground);
for (const shot of fallback.storyboard.shots) {
  const kept = shot.underlay?.selected === true;
  if (kept) continue;
  assert.equal(shot.background, DEFAULT_FOOTAGE_POLICY.fallbackBackground, `${shot.id} gets a card colour`);
}

// A background the model did set is never overwritten.
const custom = board(8, (index) => `clip ${index}`);
custom.shots[1]!.background = '#123456';
assert.equal(
  applyFootagePolicy(custom).storyboard.shots[1]!.background,
  '#123456',
  'an authored background survives the policy',
);

// --- ratio 0 turns footage off entirely -----------------------------------

const none = applyFootagePolicy(board(8, (index) => `clip ${index}`), { ...DEFAULT_FOOTAGE_POLICY, targetRatio: 0 });
assert.equal(none.target, 1, 'a zero ratio still asks for the hook');
assert.deepEqual(none.kept, ['S01'], 'only the opening shot survives');

// --- determinism ----------------------------------------------------------

const a = applyFootagePolicy(board(9, (index) => `clip ${index}`));
const b = applyFootagePolicy(board(9, (index) => `clip ${index}`));
assert.deepEqual(a.kept, b.kept, 'the same board always picks the same shots');

// --- a full-frame visual never carries footage ----------------------------

// The clip would be hidden behind the card, and the scrim would only dim a
// picture nobody can see. The hook in particular tends to be a giant word.
const cardBoard = board(6, (index) => `clip ${index}`);
cardBoard.shots[0]!.visual = { kind: 'mg', recipe: 'big-word', params: {}, layout: { anchor: 'full', widthRatio: 1 } };
const cardResult = applyFootagePolicy(cardBoard);
assert.ok(!cardResult.kept.includes('S01'), 'a full-frame shot never carries footage');
assert.equal(cardResult.kept.length, 2, 'the ratio is still met from the remaining shots');

const solidBoard = board(6, (index) => `clip ${index}`);
solidBoard.shots[0]!.visual = { kind: 'solid', color: '#000', layout: { anchor: 'mc', widthRatio: 0.9 } };
assert.ok(!applyFootagePolicy(solidBoard).kept.includes('S01'), 'a solid is full-frame whatever its anchor says');

console.log('footage-policy.verify: density, spacing, essentials, eligibility, fallback and determinism OK');
