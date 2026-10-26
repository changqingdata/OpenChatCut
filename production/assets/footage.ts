// Choosing a clip for a shot.
//
// The model writes a search query, never a provider id — it cannot see the
// footage, so asking it to pick a specific clip would be a guess dressed up as
// a decision. This module turns the query into one concrete item with a rule
// that is deterministic: same query, same library, same clip.
//
// Reproducibility is the whole point. A storyboard is a document; re-rendering
// it next month must not silently swap every clip for a different one.

import { searchAll } from './registry.ts';
import type { MaterialItem, MaterialProvider } from './types.ts';

/** Target width for vertical delivery; picks prefer the nearest rendition. */
const TARGET_WIDTH = 1080;

export interface FootageRequest {
  query: string;
  /** How long the clip has to cover, in frames. */
  neededFrames: number;
  fps: number;
  /** `video` falls back to stills when no clip answers the query. */
  kind?: 'video' | 'image';
}

export interface FootagePick {
  item: MaterialItem;
  /** The best candidate is shorter than the shot — the caller must know. */
  short: boolean;
  /** Roles actually searched, in order, for the run log. */
  tried: string[];
}

function durationOf(item: MaterialItem): number {
  return item.durationSec ?? 0;
}

/**
 * Rank candidates for a shot.
 *
 * Order matters more than the score: a clip that covers the shot always beats a
 * prettier one that does not, because a short clip freezes on its last frame
 * mid-sentence. After that, the rendition closest to 1080 wide wins — Pexels
 * offers 640 through 4K and the master is often 40 MB for a four-second cut.
 */
function rank(items: readonly MaterialItem[], neededSec: number): MaterialItem[] {
  const scored = items.map((item, index) => {
    const covers = neededSec <= 0 || durationOf(item) >= neededSec;
    const width = item.width ?? 0;
    return {
      item,
      index,
      // 0 for a covering clip, 1 for a short one: the primary sort key.
      covers: covers ? 0 : 1,
      distance: width > 0 ? Math.abs(width - TARGET_WIDTH) : TARGET_WIDTH,
      // Longer is better among short clips; irrelevant among covering ones.
      shortfall: Math.max(0, neededSec - durationOf(item)),
    };
  });

  scored.sort((a, b) =>
    a.covers - b.covers
    || a.shortfall - b.shortfall
    || a.distance - b.distance
    // Tie-break on the provider's own order so the result is stable.
    || a.index - b.index);

  return scored.map((entry) => entry.item);
}

/**
 * Find one clip for a shot.
 *
 * Footage is searched before stills because motion reads as video and a still
 * reads as a slide. Stills are the fallback, not the default.
 */
export async function findFootage(
  providers: readonly MaterialProvider[],
  request: FootageRequest,
): Promise<FootagePick | null> {
  const neededSec = request.neededFrames / Math.max(1, request.fps);
  const roles: Array<'video' | 'image'> = request.kind === 'image'
    ? ['image', 'video']
    : ['video', 'image'];

  const tried: string[] = [];

  for (const role of roles) {
    tried.push(role);
    const outcome = await searchAll(providers, {
      role,
      query: request.query,
      aspect: '9:16',
      // A handful is enough to rank; more only widens the chance of a bad first
      // page winning on a tie-break.
      limit: 12,
    });
    if (!outcome.items.length) continue;

    const [best] = rank(outcome.items, role === 'video' ? neededSec : 0);
    if (!best) continue;

    return {
      item: best,
      short: role === 'video' && neededSec > 0 && durationOf(best) < neededSec,
      tried,
    };
  }

  return null;
}

/**
 * Where to start a clip inside its source.
 *
 * Stock footage routinely opens on a camera move that has not settled yet. A
 * small fixed skip gets past it, and the value is derived rather than random so
 * the same clip always yields the same in-point.
 */
export function chooseInFrame(item: MaterialItem, neededFrames: number, fps: number): number {
  const available = Math.round((item.durationSec ?? 0) * fps);
  if (available <= neededFrames) return 0;
  const headroom = available - neededFrames;
  return Math.min(headroom, Math.round(available * 0.08));
}
