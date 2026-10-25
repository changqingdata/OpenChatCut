// External material — the shape every provider answers with.
//
// Two kinds of provider produce these, and the rest of the pipeline does not
// care which one a result came from:
//
//   catalog  a private library with an index and files on a CDN (our own BGM
//            and sound effects). Search is a local filter over the index.
//   search   a public platform with a query API (Pexels, Pixabay). Search is a
//            network call.
//
// Everything a shot needs to place a clip is here; everything a published video
// needs for attribution is here too.

export type MaterialRole = 'music' | 'sound_effect' | 'image' | 'video' | 'gif' | 'icon';

export interface MaterialItem {
  provider: string;
  /** Stable id inside the provider — the basis for dedupe and caching. */
  providerId: string;
  role: MaterialRole;
  label: string;
  category?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  sizeBytes?: number;
  thumbnailUrl?: string;
  /** Direct URL of the file to download. */
  downloadUrl: string;
  /** Attribution — required before anything can be published. */
  licenseName?: string;
  licenseUrl?: string;
  author?: string;
  sourceUrl?: string;
}

export interface MaterialQuery {
  role: MaterialRole;
  /** Free text. Catalog providers match it against label and category. */
  query?: string;
  /** Catalog only: restrict to one category (mood for music, kind for SFX). */
  category?: string;
  limit?: number;
  /** Preferred shape for video/image results. */
  aspect?: '9:16' | '16:9' | '1:1';
}

export interface MaterialProvider {
  readonly id: string;
  readonly label: string;
  readonly roles: readonly MaterialRole[];
  /** False when the key or the index is missing — callers skip it silently. */
  available(): Promise<boolean>;
  search(query: MaterialQuery): Promise<MaterialItem[]>;
}

export class MaterialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaterialError';
  }
}
