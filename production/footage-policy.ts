// How much of a video is real footage.
//
// The model is good at one half of this and bad at the other. It knows what a
// sentence is *about*, so it can write a search query for almost any shot. It
// has no idea how much footage a video should have, and it will happily put a
// clip on every shot if asked, or on none if warned about clichés.
//
// So the split is: the model proposes a query per shot and marks the ones it
// considers essential; this module decides which of those become footage.
// Density is arithmetic — a ratio, a gap, a floor — and arithmetic belongs in
// code, not in a prompt.
//
// Everything here is deterministic and runs before any download, so a density
// change costs a recompile rather than another model call.

import type { Shot, Storyboard } from './types.ts';

export interface FootagePolicy {
  /** Share of shots that should carry footage. */
  targetRatio: number;
  /** Graphic-only shots required between two footage shots. 1 = never adjacent. */
  minGapShots: number;
  /** A clip shorter than this flashes; the shot stays a card instead. */
  minFrames: number;
  /** The closing shot reads better as a card than as a clip. */
  protectLast: boolean;
  /**
   * Colour a deselected shot falls back to.
   *
   * The model was told to skip `background` on shots it expected to fill with
   * footage. Once the policy takes that footage away the base lane would be
   * empty, and an empty base renders on a transparency checkerboard.
   */
  fallbackBackground: string;
}

export const DEFAULT_FOOTAGE_POLICY: FootagePolicy = {
  targetRatio: 0.34,
  minGapShots: 1,
  minFrames: 36,
  protectLast: true,
  fallbackBackground: '#0B0B0C',
};

export interface FootagePolicyResult {
  storyboard: Storyboard;
  /** Shots that will carry footage, in order. */
  kept: string[];
  /** Shots that proposed a query and were turned down. */
  dropped: string[];
  /** How many shots the ratio asked for. */
  target: number;
  /** Shots that had no query at all — the model was too conservative. */
  unproposed: string[];
  /** Shots whose proposed clip was rated too weak to use. */
  lowConfidence: string[];
}

function durationOf(shot: Shot): number {
  return shot.endFrame - shot.startFrame;
}

/**
 * Decide which shots carry footage.
 *
 * Order of decisions, most specific first:
 *
 * 1. A shot the model marked essential is always kept — it saw something in the
 *    sentence that the ratio cannot.
 * 2. A shot with no query, or one too short to read, is never kept.
 * 3. The rest are filled in playback order, skipping any shot within `minGapShots`
 *    of one already chosen, until the ratio is met.
 *
 * Filling in order rather than by score is deliberate: footage every few seconds
 * is what makes a video breathe, and a score would cluster the best-sounding
 * queries together at the start.
 */
export function applyFootagePolicy(
  storyboard: Storyboard,
  policy: FootagePolicy = DEFAULT_FOOTAGE_POLICY,
): FootagePolicyResult {
  const shots = [...storyboard.shots].sort((a, b) => a.startFrame - b.startFrame);
  const lastIndex = shots.length - 1;

  const eligible = (shot: Shot, index: number): boolean => {
    if (!shot.underlay?.query?.trim()) return false;
    if (durationOf(shot) < policy.minFrames) return false;
    if (policy.protectLast && index === lastIndex) return false;
    // The model said there is no honest clip for this line. A wrong clip is worse
    // than a card: the viewer notices immediately, and stops trusting the picture.
    if (shot.underlay?.confidence === 'low') return false;
    // A full-frame visual paints its own card across the whole canvas, so a clip
    // underneath it is never seen. Downloading one would be waste, and the scrim
    // would only dim a picture nobody can look at.
    //
    // `solid` and `text` are full-frame regardless of their anchor, and a recipe
    // that fills the canvas is caught by `anchor: 'full'`. A recipe whose box is
    // the whole canvas but whose anchor is not full would slip through — that is
    // a recipe-authoring mistake, and QC's job rather than the policy's.
    const visual = shot.visual;
    if (visual) {
      if (visual.kind === 'solid' || visual.kind === 'text') return false;
      if ('layout' in visual && visual.layout.anchor === 'full') return false;
    }
    return true;
  };

  const unproposed = shots
    .filter((shot, index) => !shot.underlay?.query?.trim() && !(policy.protectLast && index === lastIndex))
    .map((shot) => shot.id);
  // Shots that proposed a clip but rated it low: the ratio cannot be met by
  // selecting them, so the caller needs to know why it fell short.
  const lowConfidence = shots
    .filter((shot) => shot.underlay?.query?.trim() && shot.underlay?.confidence === 'low')
    .map((shot) => shot.id);

  const target = Math.max(
    1,
    Math.min(
      Math.round(shots.length * policy.targetRatio),
      shots.filter((shot, index) => eligible(shot, index)).length,
    ),
  );

  const chosen = new Set<number>();

  // Essentials first, so the ratio never displaces them.
  shots.forEach((shot, index) => {
    if (shot.underlay?.essential && eligible(shot, index)) chosen.add(index);
  });

  const gapOk = (index: number): boolean => {
    for (let offset = 1; offset <= policy.minGapShots; offset += 1) {
      if (chosen.has(index - offset) || chosen.has(index + offset)) return false;
    }
    return true;
  };

  // Fill in playback order. The hook is tried first even when the ratio is
  // already met, because an opening card is the single strongest signal that a
  // video is a slide deck.
  const fillOrder = [0, ...shots.map((_, index) => index).filter((index) => index !== 0)];
  for (const index of fillOrder) {
    if (chosen.size >= target) break;
    const shot = shots[index];
    if (!shot || !eligible(shot, index)) continue;
    if (chosen.has(index) || !gapOk(index)) continue;
    chosen.add(index);
  }

  const kept: string[] = [];
  const dropped: string[] = [];

  const nextShots = shots.map((shot, index) => {
    const underlay = shot.underlay;
    if (!underlay?.query?.trim()) return shot;

    const keep = chosen.has(index);
    if (keep) kept.push(shot.id);
    else dropped.push(shot.id);

    return {
      ...shot,
      underlay: { ...underlay, selected: keep },
      // A deselected shot needs its own colour, since the model was told to
      // leave `background` off anything it expected footage for.
      ...(keep || shot.background ? {} : { background: policy.fallbackBackground }),
    };
  });

  return {
    storyboard: { ...storyboard, shots: nextShots },
    kept,
    dropped,
    target,
    unproposed,
    lowConfidence,
  };
}
