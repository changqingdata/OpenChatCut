// Verifies the compiler contract: determinism, track assignment, layout math,
// and the warnings that keep a bad storyboard from reaching a project.
//
//   npx tsx production/compile.verify.ts

import assert from 'node:assert/strict';
import { compile, CompileError, type RecipeRegistry } from './compile.ts';
import { resolveRect, transformFromRect } from './layout.ts';
import { validateStoryboard } from './validate.ts';
import type { Storyboard } from './types.ts';

const META = {
  title: 'demo',
  runId: 'run-001',
  aspect: '9:16' as const,
  width: 1080,
  height: 1920,
  fps: 30,
  language: 'zh',
};

const RHYTHM = {
  avgShotSec: 4,
  maxShotSec: 8,
  grammarChangeEverySec: 6,
  maxRepeatRecipe: 2,
  hookMaxSec: 3,
};

function board(overrides: Partial<Storyboard> = {}): Storyboard {
  return {
    version: 1,
    meta: META,
    rhythm: RHYTHM,
    beats: [{ id: 'b1', role: 'hook', text: '开场', startMs: 0, endMs: 4000, shotIds: ['S01'] }],
    shots: [
      {
        id: 'S01',
        beatId: 'b1',
        startFrame: 0,
        endFrame: 120,
        narration: { text: '开场', startMs: 0, endMs: 4000 },
        intent: 'hook the viewer',
        visual: { kind: 'solid', color: '#101010', layout: { anchor: 'full', widthRatio: 1 } },
      },
    ],
    ...overrides,
  };
}

// --- validation -----------------------------------------------------------

assert.equal(validateStoryboard(board()).ok, true, 'baseline storyboard validates');

const bad = board();
bad.shots[0]!.endFrame = 0;
assert.equal(validateStoryboard(bad).ok, false, 'zero-length shot is rejected');

const noIntent = board();
noIntent.shots[0]!.intent = '   ';
assert.equal(validateStoryboard(noIntent).ok, false, 'missing intent is rejected');

const orphanBeat = board();
orphanBeat.shots[0]!.beatId = 'nope';
assert.equal(validateStoryboard(orphanBeat).ok, false, 'unknown beatId is rejected');

const tooLong = board();
tooLong.shots[0]!.endFrame = 400; // 13.3s at 30fps
const longResult = validateStoryboard(tooLong);
assert.equal(longResult.ok, true, 'over-long shot is a warning, not an error');
assert.ok(longResult.warnings.some((w) => w.code === 'shot-too-long'), 'over-long shot warns');

// --- layout math ----------------------------------------------------------

const rect = resolveRect({ anchor: 'bc', widthRatio: 0.9 }, 1080, 1920, 720, 420);
assert.equal(rect.width, 972, 'width follows widthRatio');
assert.equal(rect.height, 567, 'height keeps the natural aspect');
assert.equal(rect.x, 54, 'centred horizontally');
assert.equal(rect.y, 1305, 'bottom anchor clamped inside the safe inset');

const transform = transformFromRect(rect, 1080, 1920, { width: 720, height: 420 });
assert.equal(transform.scale, 0.9, 'scale is measured against the auto-fitted width, not the raw box');
assert.equal(transform.x, 0, 'horizontally centred means no x offset');
assert.equal(transform.y, 32.734, 'vertical offset is a percentage of canvas height');

const fullRect = resolveRect({ anchor: 'full', widthRatio: 1 }, 1080, 1920, 720, 420);
assert.deepEqual(fullRect, { x: 0, y: 0, width: 1080, height: 1920 }, 'full anchor fills the frame');

// Every anchor, pinned against the same canvas. Confirmed visually against
// rendered frames: the box lands where these numbers say, with the safe inset
// applied on the edge it is anchored to.
const ANCHOR_CASES: Array<[Parameters<typeof resolveRect>[0]['anchor'], number, number, number]> = [
  // anchor, expected x, expected y, expected width
  ['tl', 48, 48, 864],
  ['tc', 108, 48, 864],
  ['tr', 168, 48, 864],
  ['ml', 48, 708, 864],
  ['mc', 108, 708, 864],
  ['mr', 168, 708, 864],
  ['bl', 48, 1368, 864],
  ['bc', 108, 1368, 864],
  ['br', 168, 1368, 864],
];
for (const [anchor, expectedX, expectedY, expectedWidth] of ANCHOR_CASES) {
  const placed = resolveRect({ anchor, widthRatio: 0.8 }, 1080, 1920, 720, 420);
  assert.equal(placed.width, expectedWidth, `${anchor}: width follows widthRatio`);
  assert.ok(Math.abs(placed.x - expectedX) < 0.01, `${anchor}: x ${placed.x} != ${expectedX}`);
  assert.ok(Math.abs(placed.y - expectedY) < 0.01, `${anchor}: y ${placed.y} != ${expectedY}`);
}

// The edge cases that make the clamp meaningful: a wide box cannot honour both
// insets, so it must stay inside the left one rather than overflow.
const tight = resolveRect({ anchor: 'br', widthRatio: 1, safeInset: 48 }, 1080, 1920, 900, 520);
assert.equal(tight.x, 48, 'a full-width box falls back to the left inset');
assert.equal(tight.width, 1080, 'a full-width box keeps the canvas width');

// --- compile --------------------------------------------------------------

const result = compile(board());
assert.equal(result.timeline.items.length, 1, 'one shot yields one item');
assert.equal(result.doc.activeTimelineId, 'tl-main', 'default timeline id');
assert.equal(result.doc.version, 3, 'project version follows CURRENT_PROJECT_VERSION');
assert.equal(result.timeline.fps, 30, 'fps carried from meta');
assert.equal(result.timeline.width, 1080, 'canvas width carried from meta');

const solid = result.timeline.items[0]!;
assert.equal(solid.kind, 'solid', 'solid visual becomes a solid item');
assert.equal(solid.track, 'V1', 'full-frame visual lands on the base track');
assert.equal(solid.id, 'it-S01', 'item id derives from the shot id');
assert.equal(solid.durationInFrames, 120, 'duration comes from the frame range');
assert.equal(solid.props?.color, '#101010', 'colour reaches the item props');

// Determinism: the same storyboard must serialise identically every time.
assert.equal(
  JSON.stringify(compile(board()).doc),
  JSON.stringify(compile(board()).doc),
  'compile is deterministic',
);

// --- recipes --------------------------------------------------------------

const recipes: RecipeRegistry = new Map([
  ['stat-impact', {
    id: 'stat-impact',
    code: 'const Component = ({ item }) => <div>{item.props.label}</div>;',
    box: { width: 720, height: 420 },
    defaultProps: { unit: '%', accent: '#ff5a1f' },
  }],
]);

const withRecipe = board();
withRecipe.shots[0]!.visual = {
  kind: 'mg',
  recipe: 'stat-impact',
  params: { value: 37, label: '复购率提升' },
  layout: { anchor: 'bc', widthRatio: 0.9 },
};

const mg = compile(withRecipe, { recipes }).timeline.items[0]!;
assert.equal(mg.kind, 'motion-graphic', 'mg visual becomes a motion-graphic item');
assert.ok(mg.code?.includes('Component'), 'recipe code is inlined into the item');
assert.equal(mg.props?.unit, '%', 'recipe defaults survive');
assert.equal(mg.props?.value, 37, 'shot params override defaults');
assert.equal(mg.track, 'V2', 'anchored visual lands on the overlay track');
assert.equal(mg.width, 720, 'natural box width kept on the item');
assert.equal(mg.transform?.scale, 0.9, 'placement scale derived from the rect and the fitted box');

const missingRecipe = compile(withRecipe);
assert.equal(missingRecipe.timeline.items.length, 0, 'unknown recipe produces no item');
assert.ok(
  missingRecipe.warnings.some((w) => w.code === 'asset-missing'),
  'unknown recipe warns instead of failing silently',
);
assert.ok(
  missingRecipe.warnings.some((w) => w.code === 'empty-timeline'),
  'empty result is reported',
);

// --- rejection ------------------------------------------------------------

assert.throws(
  () => compile(bad),
  (error: unknown) => error instanceof CompileError && error.errors.length > 0,
  'invalid storyboard throws CompileError',
);

// --- ordering -------------------------------------------------------------

const outOfOrder = board();
outOfOrder.shots = [
  { ...outOfOrder.shots[0]!, id: 'S02', startFrame: 120, endFrame: 240 },
  { ...outOfOrder.shots[0]!, id: 'S01', startFrame: 0, endFrame: 120 },
];
const sorted = compile(outOfOrder).timeline.items;
assert.deepEqual(sorted.map((item) => item.id), ['it-S01', 'it-S02'], 'items are ordered by start frame');

console.log('compile.verify: determinism, layout, tracks, recipes and rejection OK');
