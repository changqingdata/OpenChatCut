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
import { CURRENT_PROJECT_VERSION } from '../shared/project-version.ts';
import { resolveRect, transformFromRect } from './layout.ts';
import { validateStoryboard } from './validate.ts';
import type { CompileWarning, Shot, Storyboard, VisualSpec } from './types.ts';

export interface Recipe {
  id: string;
  /** Remotion component source, inlined into the item. */
  code: string;
  /** Natural design box; placement scales this onto the canvas. */
  box: { width: number; height: number };
  defaultProps?: Record<string, unknown>;
}

export type RecipeRegistry = ReadonlyMap<string, Recipe>;

export interface CompileOptions {
  recipes?: RecipeRegistry;
  /** Timeline id to emit. Defaults to `tl-main`. */
  timelineId?: string;
}

export interface CompileResult {
  doc: ProjectDoc;
  timeline: Timeline;
  warnings: CompileWarning[];
}

/** Overlays sit above the base layer; full-frame visuals own the base track. */
const BASE_TRACK = 'V1';
const OVERLAY_TRACK = 'V2';
const TRACK_ORDER = ['V2', 'V1', 'A1', 'A2'] as const;

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

function trackFor(visual: VisualSpec, hasBackground = false): string {
  // A shot with its own background puts the visual on top of it.
  if (hasBackground) return OVERLAY_TRACK;
  // Authored text is a full-frame layer in the editor; keep it on the overlay
  // track so it never displaces footage placed underneath.
  if (visual.kind === 'text') return OVERLAY_TRACK;
  return isFullFrame(visual) ? BASE_TRACK : OVERLAY_TRACK;
}

function emptyRegistry(): RecipeRegistry {
  return new Map();
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
): TimelineItem | null {
  const { width, height } = storyboard.meta;
  const durationInFrames = shot.endFrame - shot.startFrame;
  const base = {
    id: `it-${shot.id}`,
    track: trackFor(shot.visual, Boolean(shot.background)),
    startFrame: shot.startFrame,
    durationInFrames,
    name: shot.id,
  } satisfies Pick<TimelineItem, 'id' | 'track' | 'startFrame' | 'durationInFrames' | 'name'>;

  const visual = shot.visual;

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
    const rect = resolveRect(visual.layout, width, height, recipe.box.width, recipe.box.height);
    return {
      ...base,
      kind: 'motion-graphic',
      code: recipe.code,
      props: { ...recipe.defaultProps, ...visual.params },
      width: recipe.box.width,
      height: recipe.box.height,
      transform: transformFromRect(rect, width, height, recipe.box),
    };
  }

  if (visual.kind === 'mg-code') {
    const rect = resolveRect(visual.layout, width, height, visual.box.width, visual.box.height);
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

  // `asset` needs a resolved media URL from the project pool; not wired yet.
  warnings.push({
    shotId: shot.id,
    code: 'unsupported-visual',
    message: `${shot.id}: visual kind "asset" needs a project asset and is not implemented yet`,
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
  for (const shot of [...storyboard.shots].sort((a, b) => a.startFrame - b.startFrame)) {
    // Backgrounds are separate items so a recipe stays a pure overlay and the
    // same recipe can sit on footage or on a flat card.
    if (shot.background) {
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
    const item = buildItem(shot, storyboard, recipes, warnings);
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
    tracks: {
      V2: { kind: 'video', name: 'Overlay' },
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
