// Storyboard → one undoable batch of timeline edits.
//
// The CLI compiles a storyboard into a whole `ProjectDoc` because it owns the
// project from scratch. The app cannot do that: there is an open document with
// other timelines, a media pool, a selection and a history stack. So the same
// compiler output is re-expressed as actions — clear, create tracks, add assets,
// add items, set captions — and dispatched as ONE `batch`.
//
// That single batch is the point. `reducerHistory` pushes one snapshot per batch,
// so "apply this storyboard" is one undo, not twenty-five.
import type { ProjectDoc, Timeline, TrackId, TrackKind } from '../editor/types.ts';
import type { AtomicAction } from '../editor/reducerActions.ts';
import type { Tpl } from '../types.ts';
import type { CaptionPacing, CaptionMotionPreset, CaptionTemplate } from '../captions/types.ts';
import { compile } from './compile.ts';
import type { CompileAsset } from './compile.ts';
import type { CompileWarning } from './types.ts';
import { buildCaptions } from './captions.ts';
import type { CaptionCue } from './captions.ts';
import type { Storyboard } from './types.ts';
import { recipeRegistryFromTemplates } from './templates.ts';

export interface CaptionPlan {
  enabled?: boolean;
  template?: CaptionTemplate;
  pacing?: CaptionPacing;
  motion?: CaptionMotionPreset;
}

export interface ApplyStoryboardOptions {
  doc: ProjectDoc;
  storyboard: Storyboard;
  templates: readonly Tpl[];
  /** Target timeline. Defaults to the active one. */
  timelineId?: string;
  /** Replace the timeline's items instead of appending. Default true. */
  replace?: boolean;
  /** Caption overlay. `false` writes none. */
  captions?: CaptionPlan | false;
}

export interface ApplyStoryboardPlan {
  actions: AtomicAction[];
  warnings: CompileWarning[];
  /** Identity of the storyboard that was applied — cheap, not a signature. */
  hash: string;
  items: number;
  seconds: number;
  captions: number;
  tracks: { created: TrackId[]; reused: TrackId[] };
  /**
   * Shots that asked for footage and will not get any, because the clip is not
   * in this project's pool.
   *
   * The CLI resolves these with `footage resolve`; the app cannot fetch on its
   * own, so it reports them instead of quietly rendering a card where a clip was
   * meant to be. Each entry carries the query, which is what a caller needs to
   * search for one.
   */
  unresolved: Array<{ id: string; subject: string; query: string }>;
}

/**
 * A stable identity for a storyboard.
 *
 * FNV-1a twice with different offsets: 64 bits, synchronous, no crypto import.
 * This answers "is the timeline still the one this storyboard produced", which
 * needs collision resistance against typos, not against an attacker.
 */
export function storyboardHash(storyboard: Storyboard): string {
  const text = JSON.stringify(storyboard);
  const round = (offset: number): string => {
    let hash = offset;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  };
  return `${round(0x811c9dc5)}${round(0x9e3779b9)}`;
}

/** Captions straight from the storyboard: one cue per narrated shot. */
export function cuesFromStoryboard(storyboard: Storyboard, fps: number): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (const shot of storyboard.shots ?? []) {
    const text = String(shot.narration?.text ?? '').trim();
    if (!text) continue;
    const fromFrames = (frame: number) => Math.round((frame / fps) * 1000);
    const startMs = shot.narration?.startMs ?? fromFrames(shot.startFrame);
    const endMs = shot.narration?.endMs ?? fromFrames(shot.endFrame);
    cues.push({
      index: cues.length + 1,
      startMs,
      endMs: Math.max(endMs, startMs + 1),
      text,
    });
  }
  return cues;
}

const trackKindOf = (timeline: Timeline, id: string): TrackKind =>
  timeline.tracks?.[id]?.kind ?? (id.startsWith('A') ? 'audio' : 'video');

/**
 * Compile the storyboard, then express the result as actions.
 *
 * Nothing is dispatched here — the caller owns the store. That keeps the whole
 * decision testable in Node, which is where the assertions live.
 */
export function planApplyStoryboard(options: ApplyStoryboardOptions): ApplyStoryboardPlan {
  const { doc, storyboard, templates } = options;
  const timeline = doc.timelines.find((entry) => entry.id === (options.timelineId ?? doc.activeTimelineId))
    ?? doc.timelines[0];
  if (!timeline) throw new Error('apply_storyboard: the project has no timeline');

  const fps = timeline.fps || 30;
  const cues = cuesFromStoryboard(storyboard, fps);
  const captions = options.captions === false
    ? undefined
    : buildCaptions(cues, {
      enabled: options.captions?.enabled ?? true,
      ...(options.captions?.template ? { template: options.captions.template } : {}),
      ...(options.captions?.pacing ? { pacing: options.captions.pacing } : {}),
      ...(options.captions?.motion ? { motion: options.captions.motion } : {}),
    });

  // The compiler is pure: it only sees the pool assets the storyboard names.
  const pool = new Map<string, CompileAsset>();
  for (const asset of doc.assets) {
    pool.set(asset.id, {
      id: asset.id,
      src: asset.src,
      kind: asset.kind,
      ...(asset.width !== undefined ? { width: asset.width } : {}),
      ...(asset.height !== undefined ? { height: asset.height } : {}),
      ...(asset.durationInFrames !== undefined ? { durationInFrames: asset.durationInFrames } : {}),
      ...(asset.sourceFilename ? { sourceFilename: asset.sourceFilename } : {}),
      ...(asset.sourceRevision ? { sourceRevision: asset.sourceRevision } : {}),
    });
  }

  // Before compiling, so the report can name shots whose clip is missing from
  // *this* project's pool — an id copied from another project is dangling here.
  const unresolved = (storyboard.shots ?? [])
    .filter((shot) => shot.underlay?.query && shot.underlay.selected !== false)
    .filter((shot) => !shot.underlay?.assetId || !pool.has(shot.underlay.assetId))
    .map((shot) => ({
      id: shot.id,
      subject: String(shot.underlay?.subject ?? ''),
      query: String(shot.underlay?.query ?? ''),
    }));

  const compiled = compile(storyboard, {
    recipes: recipeRegistryFromTemplates(templates),
    assets: pool,
    timelineId: timeline.id,
    ...(captions ? { captions } : {}),
    // The brand belongs to the project, so the compiler reads it from there —
    // the same way the CLI does. One style, one place.
    ...(doc.designStyle ? { style: doc.designStyle } : {}),
  });

  const actions: AtomicAction[] = [];
  const replace = options.replace !== false;
  if (replace) actions.push({ type: 'clear' });

  // Tracks first: `add` drops an item whose track is locked, and a track the
  // timeline never had has no flags at all. Reuse by id when the kind agrees,
  // otherwise take the next free id so an existing V1 keeps its own meaning.
  //
  // Only lanes an item actually lands on: the compiler declares the whole
  // V1–V3 / A1–A3 stack even when a board uses two of them, and creating six
  // empty lanes for a two-lane clip is noise the user has to clean up.
  const remap = new Map<string, TrackId>();
  const created: TrackId[] = [];
  const reused: TrackId[] = [];
  const taken = new Set(Object.keys(timeline.tracks ?? {}));
  const used = new Set(compiled.timeline.items.map((item) => item.track));
  const order = (compiled.timeline.trackOrder ?? []).filter((id) => used.has(id));
  // Back to front: `track.create` with order 0 inserts a video lane at the top,
  // so creating V1 before V3 reproduces the compiler's stack (V3 above V1)
  // instead of inverting it.
  for (const id of [...order].reverse()) {
    const kind = trackKindOf(compiled.timeline, id);
    const existing = timeline.tracks?.[id];
    if (existing && existing.kind === kind && !existing.locked) {
      remap.set(id, id);
      reused.push(id);
      continue;
    }
    let target = id;
    let suffix = 2;
    while (taken.has(target)) target = `${id}-${suffix++}`;
    taken.add(target);
    remap.set(id, target);
    created.push(target);
    actions.push({ type: 'track.create', track: { id: target, kind, name: target } });
  }

  // Pool first, so an item never references an asset the document lacks.
  const known = new Set(doc.assets.map((asset) => asset.id));
  for (const asset of compiled.doc.assets) {
    if (known.has(asset.id)) continue;
    known.add(asset.id);
    actions.push({ type: 'addAsset', asset });
  }

  let items = 0;
  for (const item of compiled.timeline.items) {
    const { startFrame, ...rest } = item;
    actions.push({
      type: 'add',
      item: { ...rest, track: remap.get(item.track) ?? item.track },
      startFrame,
    });
    items += 1;
  }

  if (captions) actions.push({ type: 'setCaptions', captions });
  actions.push({ type: 'storyboard.set', storyboard, appliedHash: storyboardHash(storyboard) });

  return {
    actions,
    warnings: compiled.warnings,
    hash: storyboardHash(storyboard),
    items,
    seconds: Number((compiled.timeline.items.reduce(
      (end, item) => Math.max(end, item.startFrame + item.durationInFrames), 0,
    ) / fps).toFixed(2)),
    captions: cues.length,
    tracks: { created, reused },
    unresolved,
  };
}
