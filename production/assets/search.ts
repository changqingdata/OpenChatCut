// Search providers: public platforms with a query API.
//
// Both answer in their own shape, so each adapter normalises into MaterialItem
// and picks a file whose width is closest to the target without going under it.
// The pipeline always renders at 1080 wide, so shipping a 4K master would only
// slow the download down.
//
// Keys come from `.env.local`; a missing key makes the provider unavailable
// rather than throwing, so one unconfigured platform never blocks the others.

import { readFile } from 'node:fs/promises';
import type { MaterialItem, MaterialProvider, MaterialQuery, MaterialRole } from './types.ts';
import { MaterialError } from './types.ts';

const TARGET_WIDTH = 1080;

interface Keys {
  pexels?: string;
  pixabay?: string;
}

export async function readProviderKeys(envPath = '.env.local'): Promise<Keys> {
  let source: string;
  try {
    source = await readFile(envPath, 'utf8');
  } catch {
    return {};
  }
  const env: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match) env[match[1]!] = match[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return {
    ...(env.PEXELS_API_KEY ? { pexels: env.PEXELS_API_KEY } : {}),
    ...(env.PIXABAY_API_KEY ? { pixabay: env.PIXABAY_API_KEY } : {}),
  };
}

function orientation(aspect: MaterialQuery['aspect']): 'portrait' | 'landscape' | 'square' {
  if (aspect === '16:9') return 'landscape';
  if (aspect === '1:1') return 'square';
  return 'portrait';
}

/**
 * Pixabay has no orientation parameter, so a portrait request comes back mixed.
 * Keep only items whose shape matches, and fall back to the unfiltered list when
 * that leaves nothing — a landscape clip is still better than no result.
 */
function matchAspect<T extends { width: number; height: number }>(items: T[], aspect: MaterialQuery['aspect']): T[] {
  if (!aspect || aspect === '1:1') return items;
  const wantPortrait = aspect === '9:16';
  const matching = items.filter((item) => (wantPortrait ? item.height > item.width : item.width > item.height));
  return matching.length ? matching : items;
}

/** Closest width at or above the target; falls back to the largest available. */
function pickClosest<T extends { width: number }>(files: T[]): T | undefined {
  if (!files.length) return undefined;
  const sorted = [...files].sort((a, b) => a.width - b.width);
  return sorted.find((file) => file.width >= TARGET_WIDTH) ?? sorted[sorted.length - 1];
}

interface PexelsVideoFile {
  file_type: string;
  width: number;
  height: number;
  link: string;
  size?: number;
}

interface PexelsVideo {
  id: number;
  duration: number;
  url: string;
  image: string;
  user?: { name?: string };
  video_files: PexelsVideoFile[];
}

interface PexelsPhoto {
  id: number;
  url: string;
  photographer?: string;
  alt?: string;
  src: { original: string; large2x: string; large: string };
}

export class PexelsProvider implements MaterialProvider {
  readonly id = 'pexels';
  readonly label = 'Pexels';
  readonly roles: readonly MaterialRole[] = ['video', 'image'];

  #key: string | undefined;

  constructor(key?: string) {
    this.#key = key;
  }

  async available(): Promise<boolean> {
    return Boolean(this.#key);
  }

  async search(query: MaterialQuery): Promise<MaterialItem[]> {
    if (!this.#key) throw new MaterialError('PEXELS_API_KEY is not set');
    const limit = query.limit ?? 12;
    const term = (query.query ?? '').trim();
    if (!term) throw new MaterialError('a stock search needs a query');

    const base = query.role === 'video'
      ? 'https://api.pexels.com/videos/search'
      : 'https://api.pexels.com/v1/search';
    const params = new URLSearchParams({
      query: term,
      per_page: String(limit),
      ...(query.role === 'video' ? {} : { orientation: orientation(query.aspect) }),
      ...(query.role === 'video' ? { orientation: orientation(query.aspect) } : {}),
    });

    const response = await fetch(`${base}?${params}`, { headers: { Authorization: this.#key } });
    if (!response.ok) throw new MaterialError(`Pexels returned ${response.status}`);
    const payload = await response.json() as { videos?: PexelsVideo[]; photos?: PexelsPhoto[] };

    if (query.role === 'video') {
      return (payload.videos ?? []).flatMap((video) => {
        const file = pickClosest((video.video_files ?? []).filter((candidate) => candidate.file_type === 'video/mp4'));
        if (!file) return [];
        return [{
          provider: this.id,
          providerId: String(video.id),
          role: 'video' as const,
          label: `pexels-${video.id}`,
          durationSec: video.duration,
          width: file.width,
          height: file.height,
          sizeBytes: file.size,
          thumbnailUrl: video.image,
          downloadUrl: file.link,
          licenseName: 'Pexels License',
          licenseUrl: 'https://www.pexels.com/license/',
          author: video.user?.name,
          sourceUrl: video.url,
        }];
      });
    }

    return (payload.photos ?? []).map((photo) => ({
      provider: this.id,
      providerId: String(photo.id),
      role: 'image' as const,
      label: photo.alt || `pexels-${photo.id}`,
      thumbnailUrl: photo.src.large,
      downloadUrl: photo.src.large2x || photo.src.original,
      licenseName: 'Pexels License',
      licenseUrl: 'https://www.pexels.com/license/',
      author: photo.photographer,
      sourceUrl: photo.url,
    }));
  }
}

interface PixabayVideoVariant {
  url: string;
  width: number;
  height: number;
  size: number;
}

interface PixabayVideoHit {
  id: number;
  duration: number;
  pageURL: string;
  tags: string;
  user: string;
  videos: Record<string, PixabayVideoVariant>;
}

interface PixabayPhotoHit {
  id: number;
  pageURL: string;
  tags: string;
  user: string;
  largeImageURL: string;
  webformatURL: string;
  imageWidth: number;
  imageHeight: number;
}

export class PixabayProvider implements MaterialProvider {
  readonly id = 'pixabay';
  readonly label = 'Pixabay';
  readonly roles: readonly MaterialRole[] = ['video', 'image'];

  #key: string | undefined;

  constructor(key?: string) {
    this.#key = key;
  }

  async available(): Promise<boolean> {
    return Boolean(this.#key);
  }

  async search(query: MaterialQuery): Promise<MaterialItem[]> {
    if (!this.#key) throw new MaterialError('PIXABAY_API_KEY is not set');
    const limit = Math.max(3, Math.min(50, query.limit ?? 12));
    const term = (query.query ?? '').trim();
    if (!term) throw new MaterialError('a stock search needs a query');

    const base = query.role === 'video'
      ? 'https://pixabay.com/api/videos/'
      : 'https://pixabay.com/api/';
    const params = new URLSearchParams({
      key: this.#key,
      q: term,
      per_page: String(limit),
      safesearch: 'true',
      ...(query.role === 'video' ? {} : { image_type: 'photo' }),
    });

    const response = await fetch(`${base}?${params}`);
    if (!response.ok) throw new MaterialError(`Pixabay returned ${response.status}`);
    const payload = await response.json() as { hits?: Array<PixabayVideoHit | PixabayPhotoHit> };
    const hits = payload.hits ?? [];

    if (query.role === 'video') {
      const videos = (hits as PixabayVideoHit[]).flatMap((hit) => {
        const variants = Object.values(hit.videos ?? {});
        const file = pickClosest(variants);
        if (!file) return [];
        return [{
          provider: this.id,
          providerId: String(hit.id),
          role: 'video' as const,
          label: hit.tags || `pixabay-${hit.id}`,
          durationSec: hit.duration,
          width: file.width,
          height: file.height,
          sizeBytes: file.size,
          downloadUrl: file.url,
          licenseName: 'Pixabay Content License',
          licenseUrl: 'https://pixabay.com/service/license-summary/',
          author: hit.user,
          sourceUrl: hit.pageURL,
        }];
      });
      return matchAspect(videos, query.aspect);
    }

    const photos = (hits as PixabayPhotoHit[]).map((hit) => ({
      provider: this.id,
      providerId: String(hit.id),
      role: 'image' as const,
      label: hit.tags || `pixabay-${hit.id}`,
      width: hit.imageWidth,
      height: hit.imageHeight,
      thumbnailUrl: hit.webformatURL,
      downloadUrl: hit.largeImageURL,
      licenseName: 'Pixabay Content License',
      licenseUrl: 'https://pixabay.com/service/license-summary/',
      author: hit.user,
      sourceUrl: hit.pageURL,
    }));
    return matchAspect(photos, query.aspect);
  }
}
