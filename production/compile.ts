// Storyboard → ProjectDoc.
//
// Pure function: no network, no filesystem, no rendering, no clock. Same input
// always yields byte-identical output, which is what makes "regenerate shot 7"
// cheap and testable.
//
// The compiler owns track assignment, id allocation, and layout resolution. It
// does not own creative decisions — those live in the storyboard.

import type { ProjectDoc } from '../src/editor/projectTypes.ts';
import type { Timeline } from '../src/editor/timelineTypes.ts';
import type { TimelineItem } from '../src/editor/clipTypes.ts';
import type { CaptionsData } from '../src/captions/types.ts';
import { CURRENT_PROJECT_VERSION } from '../shared/project-version.ts';
import { resolveRect, transformFromRect } from './layout.ts';
import type { ResolveOptions } from './layout.ts';
import { buildScrimItem, scrimStopsFor } from './scrim.ts';
import { validateStoryboard } from './validate.ts';
import type { Anchor, CompileWarning, LayoutSpec, Shot, Storyboard, VisualSpec } from './types.ts';

export interface Recipe {
  id: string;
  /** Remotion component source, inlined into the item. */
  code: string;
  /** Natural design box; placement scales this onto the canvas. */
  box: { width: number; height: number };
  defaultProps?: Record<string, unknown>;
}

export type RecipeRegistry = ReadonlyMap<string, Recipe>;

/**
 * The slice of a pool asset the compiler needs.
 *
 * Compile is pure, so it never reads the pool itself — the caller hands over the
 * assets a storyboard references. Passing the whole doc would invite the
 * compiler to start making placement decisions from project state.
 */
export interface CompileAsset {
  id: string;
  src: string;
  /** Pool kind; anything that is not an image or gif renders as video. */
  kind: string;
  width?: number;
  height?: number;
  durationInFrames?: number;
  sourceFilename?: string;
  sourceRevision?: string;
}

export interface CompileOptions {
  recipes?: RecipeRegistry;
  /** Pool assets referenced by shot underlays, keyed by id. */
  assets?: ReadonlyMap<string, CompileAsset>;
  /** Timeline id to emit. Defaults to `tl-main`. */
  timelineId?: string;
  /** Caption overlay. Built from the subtitle file by the caller. */
  captions?: CaptionsData;
}

export interface CompileResult {
  doc: ProjectDoc;
  timeline: Timeline;
  warnings: CompileWarning[];
}

/**
 * Three video lanes, because a shot can have three things stacked in it.
 *
 *   V3  graphics   always — recipes and text
 *   V2  scrim      only over footage: a dark wash that keeps white type readable
 *   V1  base       footage, or a solid card
 *
 * Graphics always go to V3 rather than V2. If a scrim shared V2 with them the
 * two would fight for the same lane, and a shot that gained footage later would
 * silently change which lane its recipe was on.
 */
const BASE_TRACK = 'V1';
const SCRIM_TRACK = 'V2';
const OVERLAY_TRACK = 'V3';
const TRACK_ORDER = ['V3', 'V2', 'V1', 'A1', 'A2'] as const;

/**
 * Share of the canvas the burned-in captions occupy.
 *
 * Measured against the caption renderer, which places text at 8% from the bottom
 * with a 4.2% font — the band plus breathing room comes to about 16%. Bottom
 * anchors are held above it, or the graphic and the subtitle print over each
 * other.
 */
const CAPTION_BAND_RATIO = 0.16;

/**
 * Secondary text colour when the shot sits on footage.
 *
 * Recipes are designed against a near-black card, so their `muted` grey reads as
 * quiet. Over a sunrise clip the same grey lands on a near-white pixel and
 * disappears — the wash cannot fix it, because a 0.46 scrim over 240 still
 * leaves the area brighter than the text. Over footage, secondary text has to be
 * light and rely on weight rather than value for its hierarchy.
 */
export const OVER_FOOTAGE_MUTED = '#D6D1C7';

export class CompileError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`storyboard rejected:\n  - ${errors.join('\n  - ')}`);
    this.name = 'CompileError';
    this.errors = errors;
  }
}

function isFullFrame(visual: VisualSpec): boolean {
  if (visual.kind === 'text' || visual.kind === 'solid') return true;
  return 'layout' in visual && visual.layout.anchor === 'full';
}

/**
 * Vertical centring for shots whose picture *is* the graphic.
 *
 * On footage a top anchor is composition: the clip fills the frame and the type
 * finds a quiet corner. On a flat card there is no clip, so a top anchor leaves
 * the rest of the frame empty — `keyword-punch` at `tc` puts a 530px block at the
 * top of a 1920px frame and leaves 70% of it blank, which reads as unfinished
 * rather than as negative space.
 *
 * So a card is centred vertically, and only vertically: `tl` becomes `ml`, `bc`
 * becomes `mc`. The horizontal choice is still composition — a list reads better
 * hanging on the left — and it survives.
 */
function cardAnchor(anchor: Anchor): Anchor {
  if (anchor === 'full') return anchor;
  // The anchor reads row-then-column: `tc` is top-centre, `bl` is bottom-left.
  // So the first character is the one that has to become `m`.
  if (anchor[0] === 'm') return anchor;
  return `m${anchor[1]}` as Anchor;
}

function cardLayout(layout: LayoutSpec, hasFootage: boolean): LayoutSpec {
  return hasFootage ? layout : { ...layout, anchor: cardAnchor(layout.anchor) };
}

function trackFor(visual: VisualSpec, hasBackground = false, hasUnderlay = false): string {
  // Graphics always sit on the top lane: footage below, scrim between them.
  if (hasUnderlay || hasBackground) return OVERLAY_TRACK;
  // A card with nothing under it still needs its own lane when it fills the
  // frame — a full-frame solid on V1 would be the base layer itself.
  if (visual.kind === 'text') return OVERLAY_TRACK;
  return isFullFrame(visual) ? BASE_TRACK : OVERLAY_TRACK;
}

function emptyRegistry(): RecipeRegistry {
  return new Map();
}

/**
 * Footage item for one shot.
 *
 * Two details are not obvious:
 *
 * - The clip is muted. A stock clip carries its own ambience, which fights the
 *   voiceover and the music bed; the mix is built from A1–A3, not from V1.
 * - Landscape footage in a portrait canvas is letterboxed, because the renderer
 *   fits media with `contain` and only applies transforms to motion graphics.
 *   `backgroundFill` paints a blurred cover copy behind it, which reads as a
 *   deliberate treatment instead of a mistake. Portrait footage needs neither.
 */
function buildUnderlay(
  shot: Shot,
  assets: ReadonlyMap<string, CompileAsset>,
  canvas: { width: number; height: number },
  warnings: CompileWarning[],
): TimelineItem | null {
  const underlay = shot.underlay;
  if (!underlay) return null;

  // The footage policy turned this shot down. Its query stays on the record so
  // raising the density later costs a recompile, not another model call.
  if (underlay.selected === false) return null;

  if (!underlay.assetId) {
    warnings.push({
      shotId: shot.id,
      code: 'underlay-unresolved',
      message: `${shot.id}: footage "${underlay.query ?? ''}" has no asset yet`,
    });
    return null;
  }

  const asset = assets.get(underlay.assetId);
  if (!asset) {
    warnings.push({
      shotId: shot.id,
      code: 'asset-missing',
      message: `${shot.id}: footage asset ${underlay.assetId} is not in the project pool`,
    });
    return null;
  }

  const durationInFrames = shot.endFrame - shot.startFrame;
  const available = asset.durationInFrames ?? 0;

  // A clip shorter than its shot freezes on the last frame. Say so; the resolver
  // can re-pick, but the compiler must not hide it.
  if (available > 0 && available < durationInFrames) {
    warnings.push({
      shotId: shot.id,
      code: 'shot-too-long',
      message: `${shot.id}: footage is ${available} frames but the shot needs ${durationInFrames}`,
    });
  }

  const requestedIn = underlay.srcInFrame ?? 0;
  const maxIn = available > 0 ? Math.max(0, available - durationInFrames) : requestedIn;
  const srcInFrame = Math.min(requestedIn, maxIn);

  const width = asset.width ?? canvas.width;
  const height = asset.height ?? canvas.height;
  const portrait = height >= width;

  return {
    id: `it-f-${shot.id}`,
    kind: asset.kind === 'image' ? 'image' : asset.kind === 'gif' ? 'gif' : 'video',
    track: BASE_TRACK,
    startFrame: shot.startFrame,
    durationInFrames,
    name: `${shot.id} footage`,
    src: asset.src,
    sourceAssetId: asset.id,
    ...(asset.sourceFilename ? { sourceFilename: asset.sourceFilename } : {}),
    ...(asset.sourceRevision ? { sourceRevision: asset.sourceRevision } : {}),
    width,
    height,
    volume: 0,
    ...(srcInFrame > 0 ? { srcInFrame } : {}),
    ...(underlay.backgroundFill ?? !portrait
      ? { backgroundFill: true, backgroundFillStrength: 70 }
      : {}),
  };
}

/**
 * Resolve one shot into a timeline item.
 *
 * Returns `null` when the visual cannot be built yet (unknown recipe, media not
 * in the pool). The caller records a warning; dropping the shot silently would
 * hide a production defect.
 */
function buildItem(
  shot: Shot,
  storyboard: Storyboard,
  recipes: RecipeRegistry,
  warnings: CompileWarning[],
  layoutOptions: ResolveOptions,
): TimelineItem | null {
  const visual = shot.visual;
  if (!visual) return null;

  const onFootage = Boolean(shot.underlay) && shot.underlay?.selected !== false;
  const { width, height } = storyboard.meta;
  const durationInFrames = shot.endFrame - shot.startFrame;
  const base = {
    id: `it-${shot.id}`,
    track: trackFor(visual, Boolean(shot.background), Boolean(shot.underlay)),
    startFrame: shot.startFrame,
    durationInFrames,
    name: shot.id,
  } satisfies Pick<TimelineItem, 'id' | 'track' | 'startFrame' | 'durationInFrames' | 'name'>;

  if (visual.kind === 'mg') {
    const recipe = recipes.get(visual.recipe);
    if (!recipe) {
      warnings.push({
        shotId: shot.id,
        code: 'asset-missing',
        message: `${shot.id}: recipe "${visual.recipe}" is not registered`,
      });
      return null;
    }
    const rect = resolveRect(cardLayout(visual.layout, onFootage), width, height, recipe.box.width, recipe.box.height, layoutOptions);
    return {
      ...base,
      kind: 'motion-graphic',
      code: recipe.code,
      // The footage correction comes last: it is a legibility rule, not a
      // preference, and a storyboard that has been through the CLI already
      // carries every schema default.
      props: {
        ...recipe.defaultProps,
        ...visual.params,
        ...(onFootage ? { muted: OVER_FOOTAGE_MUTED } : {}),
      },
      width: recipe.box.width,
      height: recipe.box.height,
      transform: transformFromRect(rect, width, height, recipe.box),
    };
  }

  if (visual.kind === 'mg-code') {
    const rect = resolveRect(cardLayout(visual.layout, onFootage), width, height, visual.box.width, visual.box.height, layoutOptions);
    return {
      ...base,
      kind: 'motion-graphic',
      code: visual.code,
      props: visual.props ?? {},
      width: visual.box.width,
      height: visual.box.height,
      transform: transformFromRect(rect, width, height, visual.box),
    };
  }

  if (visual.kind === 'text') {
    if (visual.layout.anchor !== 'full') {
      warnings.push({
        shotId: shot.id,
        code: 'unsupported-visual',
        message: `${shot.id}: text shots render full-frame; anchor "${visual.layout.anchor}" is ignored (use align)`,
      });
    }
    return {
      ...base,
      kind: 'text',
      width,
      height,
      props: {
        text: visual.text,
        fontSize: visual.fontSize ?? 96,
        color: visual.color ?? '#ffffff',
        fontWeight: visual.fontWeight ?? 700,
        align: visual.align ?? 'center',
      },
    };
  }

  if (visual.kind === 'solid') {
    return {
      ...base,
      kind: 'solid',
      width,
      height,
      props: { color: visual.color },
    };
  }

  warnings.push({
    shotId: shot.id,
    code: 'unsupported-visual',
    message: `${shot.id}: unknown visual kind — footage belongs in shot.underlay, not in visual`,
  });
  return null;
}

export function compile(storyboard: Storyboard, options: CompileOptions = {}): CompileResult {
  const validation = validateStoryboard(storyboard);
  if (!validation.ok) throw new CompileError(validation.errors);

  const warnings: CompileWarning[] = [...validation.warnings];
  const recipes = options.recipes ?? emptyRegistry();
  const timelineId = options.timelineId ?? 'tl-main';
  const { meta } = storyboard;

  const items: TimelineItem[] = [];
  const assets = options.assets ?? new Map<string, CompileAsset>();
  // Bottom anchors and tall middle boxes must clear the caption band.
  const layoutOptions = options.captions?.enabled
    ? { bottomInset: Math.round(meta.height * CAPTION_BAND_RATIO) }
    : {};
  for (const shot of [...storyboard.shots].sort((a, b) => a.startFrame - b.startFrame)) {
    const footage = buildUnderlay(shot, assets, meta, warnings);

    // Footage is the background when present, so a solid would only hide it.
    if (shot.background && !footage) {
      items.push({
        id: `it-bg-${shot.id}`,
        kind: 'solid',
        track: BASE_TRACK,
        startFrame: shot.startFrame,
        durationInFrames: shot.endFrame - shot.startFrame,
        name: `${shot.id} bg`,
        width: meta.width,
        height: meta.height,
        props: { color: shot.background },
      });
    }
    if (footage) {
      items.push(footage);
      // Only worth washing when something will be drawn over the footage.
      const needsScrim = Boolean(shot.visual) || Boolean(options.captions?.enabled);
      if (needsScrim) items.push(buildScrimItem(shot, meta, SCRIM_TRACK, scrimStopsFor(meta)));
    }
    // Nothing behind the graphics means the canvas shows through — the render
    // comes out on a transparency checkerboard. A shot needs a card colour or
    // footage; relying on the previous shot's picture does not work, items do
    // not span.
    if (!footage && !shot.background) {
      warnings.push({
        shotId: shot.id,
        code: 'empty-base',
        message: `${shot.id}: nothing behind the graphics — the canvas would render on transparency`,
      });
    }

    const item = buildItem(shot, storyboard, recipes, warnings, layoutOptions);
    if (item) items.push(item);
  }

  // The voiceover is the timing authority, so it goes on the anchor track that
  // music later ducks under.
  if (storyboard.audio) {
    items.push({
      id: 'it-voice',
      kind: 'audio',
      track: 'A1',
      startFrame: 0,
      durationInFrames: storyboard.audio.durationFrames,
      name: 'voiceover',
      src: storyboard.audio.src,
      sourceAssetId: storyboard.audio.assetId,
      volume: storyboard.audio.volume ?? 1,
    });
  }

  if (items.length === 0) {
    warnings.push({ code: 'empty-timeline', message: 'no shot could be compiled into an item' });
  }

  const timeline: Timeline = {
    id: timelineId,
    name: meta.title || 'Main',
    order: 0,
    fps: meta.fps,
    width: meta.width,
    height: meta.height,
    items,
    trackOrder: [...TRACK_ORDER],
    ...(options.captions ? { captions: options.captions } : {}),
    tracks: {
      V3: { kind: 'video', name: 'Graphics' },
      V2: { kind: 'video', name: 'Scrim' },
      V1: { kind: 'video', name: 'Base' },
      A1: { kind: 'audio', name: 'Voice' },
      A2: { kind: 'audio', name: 'Music' },
    },
    selectedId: null,
  };

  const doc: ProjectDoc = {
    version: CURRENT_PROJECT_VERSION,
    assets: [],
    mediaFolders: [],
    timelines: [timeline],
    activeTimelineId: timelineId,
  };

  return { doc, timeline, warnings };
}
