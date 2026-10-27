// Verifies the compiler contract: determinism, track assignment, layout math,
// and the warnings that keep a bad storyboard from reaching a project.
//
//   npx tsx production/compile.verify.ts

import assert from 'node:assert/strict';
import { compile, CompileError, type CompileAsset, type RecipeRegistry } from './compile.ts';
import { resolveRect, transformFromRect } from './layout.ts';
import { validateStoryboard } from './validate.ts';
import { SCRIM_STOPS, scrimStopsFor } from './scrim.ts';
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

// `widthRatio: 1` used to produce a box exactly as wide as the canvas, which was
// then clamped to x = 48 and overflowed the right edge by the same amount. The
// width is now capped by the space the insets leave, so both edges are honoured.
const tight = resolveRect({ anchor: 'br', widthRatio: 1, safeInset: 48 }, 1080, 1920, 900, 520);
assert.equal(tight.width, 984, 'a full-width request is capped by the insets');
assert.equal(tight.x, 48, 'and sits inside the left inset');
assert.equal(tight.x + tight.width, 1032, 'and stops inside the right one');

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
assert.equal(mg.track, 'V3', 'anchored visual lands on the graphics track');
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

// --- footage underlay -----------------------------------------------------

// A shot can carry footage below and graphics above. The three lanes are the
// contract: V1 picture, V2 scrim, V3 graphics.
const assets = new Map<string, CompileAsset>([
  ['asset-portrait', { id: 'asset-portrait', src: '/media/uploads/a.mp4', kind: 'video', width: 1080, height: 1920, durationInFrames: 300 }],
  ['asset-landscape', { id: 'asset-landscape', src: '/media/uploads/b.mp4', kind: 'video', width: 1920, height: 1080, durationInFrames: 300 }],
  ['asset-still', { id: 'asset-still', src: '/media/uploads/c.jpg', kind: 'image', width: 1080, height: 1920 }],
]);

const hybrid = board();
hybrid.shots = [{
  ...hybrid.shots[0]!,
  startFrame: 0,
  endFrame: 120,
  underlay: { assetId: 'asset-portrait', query: 'person typing' },
  visual: { kind: 'mg', recipe: 'stat-impact', params: { value: 1 }, layout: { anchor: 'tc', widthRatio: 0.8 } },
}];

const hybridItems = compile(hybrid, { recipes, assets }).timeline.items;
const footage = hybridItems.find((item) => item.id === 'it-f-S01');
const scrim = hybridItems.find((item) => item.id === 'it-scrim-S01');
const graphic = hybridItems.find((item) => item.id === 'it-S01');
assert.ok(footage && scrim && graphic, 'footage, scrim and graphic are all emitted');
assert.equal(footage.kind, 'video', 'footage becomes a video item');
assert.equal(footage.track, 'V1', 'footage owns the base lane');
assert.equal(footage.src, '/media/uploads/a.mp4', 'footage src comes from the pool');
assert.equal(footage.volume, 0, 'footage is muted: the mix is built from A1-A3');
assert.equal(scrim.track, 'V2', 'scrim sits between footage and graphics');
assert.equal(graphic.track, 'V3', 'graphics sit above the scrim');
assert.equal(footage.backgroundFill, undefined, 'portrait footage needs no blurred cover');

// Footage alone is a legitimate shot: no graphic, but still a scrim, because the
// burned-in captions need contrast against an unknown clip.
const footageOnly = board();
footageOnly.shots = [{ ...footageOnly.shots[0]!, startFrame: 0, endFrame: 120, visual: undefined, underlay: { assetId: 'asset-still' } }];
const onlyItems = compile(footageOnly, { assets, captions: { enabled: true } as never }).timeline.items;
assert.equal(onlyItems.length, 2, 'footage-only shot emits footage plus scrim');
assert.equal(onlyItems[0]!.kind, 'image', 'a still becomes an image item');
assert.equal(onlyItems[0]!.track, 'V1', 'a still also owns the base lane');

// Landscape footage in a portrait canvas is letterboxed by the renderer, so the
// compiler asks for the blurred cover treatment instead of shipping black bars.
const wide = board();
wide.shots = [{ ...wide.shots[0]!, startFrame: 0, endFrame: 120, visual: undefined, underlay: { assetId: 'asset-landscape' } }];
const wideItem = compile(wide, { assets }).timeline.items[0]!;
assert.equal(wideItem.backgroundFill, true, 'landscape footage gets a blurred cover');

// An unresolved query must not pass silently: the run would lose every real shot.
const unresolved = board();
unresolved.shots = [{ ...unresolved.shots[0]!, startFrame: 0, endFrame: 120, visual: undefined, underlay: { query: 'office' } }];
const unresolvedResult = compile(unresolved);
assert.equal(unresolvedResult.timeline.items.length, 0, 'unresolved footage emits nothing');
assert.ok(
  unresolvedResult.warnings.some((w) => w.code === 'underlay-unresolved'),
  'unresolved footage warns',
);

// A resolved id that is not in the pool is a different failure: the reference is
// stale, and the message has to say which id.
const dangling = board();
dangling.shots = [{ ...dangling.shots[0]!, startFrame: 0, endFrame: 120, visual: undefined, underlay: { assetId: 'gone' } }];
assert.ok(
  compile(dangling, { assets }).warnings.some((w) => w.code === 'asset-missing'),
  'a stale asset id warns',
);

// srcInFrame is clamped so a long clip never runs past its own end.
const trimmed = board();
trimmed.shots = [{
  ...trimmed.shots[0]!,
  startFrame: 0,
  endFrame: 120,
  underlay: { assetId: 'asset-portrait', srcInFrame: 5000 },
}];
const trimmedItem = compile(trimmed, { assets }).timeline.items.find((item) => item.id === 'it-f-S01')!;
assert.equal(trimmedItem.srcInFrame, 180, 'srcInFrame is clamped to what the clip can spare');

// --- captions reserve the bottom band -------------------------------------

// A `bc` recipe used to land on top of the burned-in subtitle: the layout had no
// idea the band existed. With captions on, the rect has to stop above it.
//
// The shot carries footage because a card now centres vertically, which would
// make the band irrelevant — and `bc` over footage is exactly the case that
// broke.
const bcBoard = board();
bcBoard.shots = [{
  ...bcBoard.shots[0]!,
  startFrame: 0,
  endFrame: 120,
  underlay: { assetId: 'asset-portrait' },
  visual: { kind: 'mg', recipe: 'stat-impact', params: { value: 1 }, layout: { anchor: 'bc', widthRatio: 0.9 } },
}];

const bare = compile(bcBoard, { recipes, assets }).timeline.items.find((item) => item.id === 'it-S01')!;
const withCaptions = compile(bcBoard, { recipes, assets, captions: { enabled: true } as never })
  .timeline.items.find((item) => item.id === 'it-S01')!;
assert.ok(
  (withCaptions.transform?.y ?? 0) < (bare.transform?.y ?? 0),
  'captions push a bottom-anchored visual upward',
);

// The reserved band is 16% of the canvas: a 1920-tall frame keeps 307px clear.
const band = 1920 * 0.16;
const rectWithCaptions = resolveRect(
  { anchor: 'bc', widthRatio: 0.9 }, 1080, 1920, 720, 420, { bottomInset: band },
);
assert.ok(
  rectWithCaptions.y + rectWithCaptions.height <= 1920 - band - 48 + 0.001,
  'the box bottom clears the caption band and the inset',
);

// A tall middle box is pushed up rather than clipped by the band.
const tallMiddle = resolveRect({ anchor: 'mc', widthRatio: 0.9 }, 1080, 1920, 720, 1200, { bottomInset: band });
assert.ok(tallMiddle.y >= 48, 'a tall box still respects the top inset');

// --- the wash is a gradient, not a flat block -----------------------------

// `solid` can paint only one colour, so the wash is a motion graphic sized to
// the canvas: no transform needed, and it scales with the frame.
const washBoard = board();
washBoard.shots = [{
  ...washBoard.shots[0]!,
  startFrame: 0,
  endFrame: 120,
  visual: undefined,
  underlay: { assetId: 'asset-portrait' },
}];
const wash = compile(washBoard, { assets, captions: { enabled: true } as never })
  .timeline.items.find((item) => item.id === 'it-scrim-S01')!;
assert.ok(wash, 'footage with captions gets a wash');
assert.equal(wash.kind, 'motion-graphic', 'the wash is a motion graphic so it can hold a gradient');
assert.equal(wash.track, 'V2', 'the wash sits above the footage');
assert.equal(wash.width, 1080, 'the wash is sized to the canvas');
assert.equal(wash.height, 1920, 'the wash is sized to the canvas');
assert.ok(wash.code?.includes('linear-gradient'), 'the wash is a gradient');
assert.ok((wash.props?.bottom ?? 0) > (wash.props?.mid ?? 1), 'the caption band is the darkest stop');

// --- a card is centred vertically -----------------------------------------

// On footage a top anchor is composition. On a flat card it leaves the frame
// empty: keyword-punch at `tc` is a 530px block at the top of a 1920px frame,
// with 70% of the picture blank.
const cardTop = board();
cardTop.shots = [{
  ...cardTop.shots[0]!,
  startFrame: 0,
  endFrame: 120,
  background: '#0B0B0C',
  visual: { kind: 'mg', recipe: 'stat-impact', params: { value: 1 }, layout: { anchor: 'tc', widthRatio: 0.85 } },
}];
const cardItem = compile(cardTop, { recipes }).timeline.items.find((item) => item.id === 'it-S01')!;
assert.equal(cardItem.transform?.y, 0, 'a card ignores a top anchor and centres vertically');

// The horizontal choice survives: a list still hangs on the left.
const cardLeft = board();
cardLeft.shots = [{
  ...cardLeft.shots[0]!,
  startFrame: 0,
  endFrame: 120,
  background: '#0B0B0C',
  visual: { kind: 'mg', recipe: 'stat-impact', params: { value: 1 }, layout: { anchor: 'tl', widthRatio: 0.85 } },
}];
const leftItem = compile(cardLeft, { recipes }).timeline.items.find((item) => item.id === 'it-S01')!;
assert.equal(leftItem.transform?.y, 0, 'a card centres vertically');
assert.ok((leftItem.transform?.x ?? 0) < 0, 'but keeps its left alignment');

// Footage keeps the anchor it was given — that is where the composition lives.
const footageTop = board();
footageTop.shots = [{
  ...footageTop.shots[0]!,
  startFrame: 0,
  endFrame: 120,
  visual: undefined,
  underlay: { assetId: 'asset-portrait' },
}];
const footageTopWithVisual = board();
footageTopWithVisual.shots = [{
  ...footageTopWithVisual.shots[0]!,
  startFrame: 0,
  endFrame: 120,
  underlay: { assetId: 'asset-portrait' },
  visual: { kind: 'mg', recipe: 'stat-impact', params: { value: 1 }, layout: { anchor: 'tc', widthRatio: 0.85 } },
}];
const overFootage = compile(footageTopWithVisual, { recipes, assets })
  .timeline.items.find((item) => item.id === 'it-S01')!;
assert.ok((overFootage.transform?.y ?? 0) < -20, 'over footage a top anchor stays at the top');
assert.ok(compile(footageTop, { assets }).timeline.items.length > 0, 'footage alone still compiles');

// --- a wide canvas shrinks the box by height, not by width -----------------

// `widthRatio` is a share of the width, which breaks on 16:9: 0.85 of 1920 is
// 1632px, and a 900×520 recipe at that width is 943px tall — taller than the 811
// a 1080px frame leaves after the caption band and the insets. The width is
// capped by the height available, so the graphic keeps its margins.
const wideFrame = resolveRect(
  { anchor: 'mc', widthRatio: 0.85 }, 1920, 1080, 900, 520,
  { bottomInset: Math.round(1080 * 0.16) },
);
const availableHeight = 1080 - Math.round(1080 * 0.16) - 96;
assert.equal(Math.round(wideFrame.height), availableHeight, 'the box uses the height that is left');
assert.ok(wideFrame.width < 1920 * 0.85, 'and is narrower than widthRatio alone would ask for');
assert.ok(wideFrame.x >= 48, 'so it keeps its left margin');
assert.ok(wideFrame.x + wideFrame.width <= 1920 - 48 + 0.001, 'and its right one');

// On a portrait canvas the height cap never binds.
const tallFrame = resolveRect({ anchor: 'mc', widthRatio: 0.85 }, 1080, 1920, 900, 520, { bottomInset: 307 });
assert.equal(Math.round(tallFrame.width), Math.round(1080 * 0.85), 'a portrait canvas is unchanged');

// --- the wash flattens on a wide frame ------------------------------------

// The gradient assumes the type lives at the top and the captions at the bottom,
// leaving a quiet centre. On 16:9 the graphic is a band across the centre, so the
// middle is the text zone and the wash there has to be stronger.
const portraitStops = scrimStopsFor({ width: 1080, height: 1920 });
const wideStops = scrimStopsFor({ width: 1920, height: 1080 });
assert.equal(portraitStops.mid, SCRIM_STOPS.mid, 'portrait keeps the gradient');
assert.ok(wideStops.mid > portraitStops.mid, 'a wide frame washes its centre harder');
assert.ok(wideStops.top - wideStops.mid < portraitStops.top - portraitStops.mid, 'and is flatter overall');

// --- transitions ----------------------------------------------------------

// A fade has to be applied on both sides of the cut, and only to the graphic
// layer. Fading the background too left the canvas transparent mid-dissolve —
// the checkerboard showed through for the length of the fade.
const fadeBoard = board();
fadeBoard.shots = [
  {
    ...fadeBoard.shots[0]!,
    id: 'S01', startFrame: 0, endFrame: 120, background: '#0B0B0C',
    visual: { kind: 'mg', recipe: 'stat-impact', params: { value: 1 }, layout: { anchor: 'mc', widthRatio: 0.9 } },
  },
  {
    ...fadeBoard.shots[0]!,
    id: 'S02', startFrame: 120, endFrame: 240, background: '#0B0B0C',
    visual: { kind: 'mg', recipe: 'stat-impact', params: { value: 2 }, layout: { anchor: 'mc', widthRatio: 0.9 } },
    transitionIn: { type: 'fade', durationInFrames: 12 },
  },
];
const faded = compile(fadeBoard, { recipes }).timeline.items;
const outgoing = faded.find((item) => item.id === 'it-S01')!;
const incoming = faded.find((item) => item.id === 'it-S02')!;
const outgoingBg = faded.find((item) => item.id === 'it-bg-S01')!;
const incomingBg = faded.find((item) => item.id === 'it-bg-S02')!;
assert.equal(outgoing.fadeOutFrames, 12, 'the outgoing graphic fades out');
assert.equal(incoming.fadeInFrames, 12, 'the incoming graphic fades in');
assert.equal(outgoingBg.fadeOutFrames, undefined, 'the outgoing background stays opaque');
assert.equal(incomingBg.fadeInFrames, undefined, 'the incoming background stays opaque');

// Footage is content, not background: a fade into a footage shot must dissolve
// the clip too, or it pops in while its overlays are still arriving.
const fadeIntoFootage = board();
fadeIntoFootage.shots = [{
  ...fadeIntoFootage.shots[0]!,
  id: 'S01', startFrame: 0, endFrame: 120,
  underlay: { assetId: 'asset-portrait' },
  transitionIn: { type: 'fade', durationInFrames: 12 },
}];
const clip = compile(fadeIntoFootage, { assets }).timeline.items.find((item) => item.id === 'it-f-S01')!;
assert.equal(clip.fadeInFrames, 12, 'footage fades with the shot');

// No transition means no fades at all: a hard cut is the default.
const hard = compile(board(), { recipes }).timeline.items;
assert.ok(hard.every((item) => item.fadeInFrames === undefined && item.fadeOutFrames === undefined), 'a hard cut adds no fades');

console.log('compile.verify: determinism, layout, tracks, recipes, footage, captions, transitions and rejection OK');
