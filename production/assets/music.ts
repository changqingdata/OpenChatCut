// Choosing the background track.
//
// The index carries a mood category per track (快乐庆祝, 伤感悲伤, 震撼史诗…),
// which is the one piece of metadata that is actually filled in — bpm and mood
// fields exist but are empty on every entry. So selection is: the model names a
// category from the list, and this picks the best-fitting track inside it.
//
// Fit means "long enough". A 25-second video needs a track of at least 25
// seconds; anything shorter ends before the video does, and looping it would
// introduce a seam nobody asked for.

import type { MaterialItem, MaterialProvider } from './types.ts';

export interface MusicPickOptions {
  category: string;
  /** Video length; the track should cover it. */
  minDurationSec: number;
  /** Optional free text to narrow within the category. */
  query?: string;
  limit?: number;
}

export interface MusicPick {
  item: MaterialItem;
  /** True when no track covered the video and the longest one was taken. */
  short: boolean;
}

/**
 * Pick one track from a category.
 *
 * Among tracks that cover the video, the shortest one wins: a 190-second track
 * under a 25-second video wastes 165 seconds of download for no benefit.
 */
export async function pickMusic(
  providers: readonly MaterialProvider[],
  options: MusicPickOptions,
): Promise<MusicPick | null> {
  const catalog = providers.find((provider) => provider.id === 'private-audio');
  if (!catalog || !(await catalog.available())) return null;

  const items = await catalog.search({
    role: 'music',
    category: options.category,
    ...(options.query ? { query: options.query } : {}),
    limit: options.limit ?? 24,
  });
  if (!items.length) return null;

  const covering = items
    .filter((item) => (item.durationSec ?? 0) >= options.minDurationSec)
    .sort((a, b) => (a.durationSec ?? 0) - (b.durationSec ?? 0));

  if (covering.length) return { item: covering[0]!, short: false };

  const longest = [...items].sort((a, b) => (b.durationSec ?? 0) - (a.durationSec ?? 0))[0]!;
  return { item: longest, short: true };
}

/** Mood categories the library actually has, for the generation prompt. */
export async function musicCategories(providers: readonly MaterialProvider[]): Promise<string[]> {
  const catalog = providers.find((provider) => provider.categories);
  if (!catalog?.categories || !(await catalog.available())) return [];
  return catalog.categories('music');
}
