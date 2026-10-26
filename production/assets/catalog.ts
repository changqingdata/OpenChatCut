// Catalog provider: a private library that ships an index plus files on a CDN.
//
// The two libraries here use different index shapes — music lives in
// `remote_index.json` under `roles.music.items[]` and carries a `cdn_path`,
// sound effects live in `manifest.json` as `items[]` with a `relative_path` —
// but both are `preset-audio-*-v2`, so one normaliser covers them.
//
// The CDN base never appears in the repository: it comes from `.env.local`, so a
// clone of this code cannot reach the library.

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { loadPipelineConfig } from '../config.ts';
import { dirname, resolve } from 'node:path';
import type { MaterialItem, MaterialProvider, MaterialQuery, MaterialRole } from './types.ts';
import { MaterialError } from './types.ts';

const CACHE_DIR = 'production/work/assets-cache';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface CatalogEnv {
  cdnBase: string;
  musicIndexUrl: string;
  sfxManifestUrl: string;
}

/** Read the private-library endpoints. Returns null when unconfigured. */
export async function readCatalogEnv(envPath = '.env.local'): Promise<CatalogEnv | null> {
  const { values: env } = await loadPipelineConfig(envPath);
  const cdnBase = (env.PRESET_CDN_BASE ?? '').replace(/\/$/, '');
  if (!cdnBase) return null;
  return {
    cdnBase,
    musicIndexUrl: env.PRESET_MUSIC_INDEX_URL || `${cdnBase}/remote_index.json`,
    sfxManifestUrl: env.PRESET_SFX_MANIFEST_URL || `${cdnBase}/manifest.json`,
  };
}

interface RawEntry {
  id?: string;
  label?: string;
  category?: string;
  duration?: number;
  size_bytes?: number;
  cdn_path?: string;
  relative_path?: string;
  filename?: string;
}

/** Both index shapes reduce to this. */
interface CatalogEntry {
  id: string;
  label: string;
  category: string;
  durationSec: number;
  sizeBytes: number;
  path: string;
}

function normalise(payload: unknown, role: MaterialRole): CatalogEntry[] {
  const root = payload as { roles?: Record<string, { items?: RawEntry[] }>; items?: RawEntry[] };
  const raw: RawEntry[] = root.roles?.[role]?.items ?? root.items ?? [];
  const entries: CatalogEntry[] = [];

  for (const entry of raw) {
    const path = entry.cdn_path ?? entry.relative_path;
    if (!path || !entry.id) continue;
    entries.push({
      id: entry.id,
      label: entry.label || entry.filename || entry.id,
      category: entry.category || '',
      durationSec: Number(entry.duration) || 0,
      sizeBytes: Number(entry.size_bytes) || 0,
      path,
    });
  }
  return entries;
}

/** Download an index, reusing a fresh local copy. Keeps repeat runs offline. */
async function loadIndex(url: string, cacheName: string, role: MaterialRole): Promise<CatalogEntry[]> {
  const cachePath = resolve(CACHE_DIR, cacheName);
  try {
    const info = await stat(cachePath);
    if (Date.now() - info.mtimeMs < CACHE_TTL_MS) {
      return normalise(JSON.parse(await readFile(cachePath, 'utf8')), role);
    }
  } catch {
    // No usable cache — fall through to the network.
  }

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new MaterialError(`cannot reach the library index: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new MaterialError(`library index returned ${response.status}`);
  const text = await response.text();

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new MaterialError('library index is not valid JSON');
  }

  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, text, 'utf8');
  return normalise(payload, role);
}

/** Chinese category and file names have to be percent-encoded for the CDN. */
function encodePath(path: string): string {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function matches(entry: CatalogEntry, query: MaterialQuery): boolean {
  if (query.category && entry.category !== query.category) return false;
  const needle = query.query?.trim().toLowerCase();
  if (!needle) return true;
  return `${entry.label} ${entry.category}`.toLowerCase().includes(needle);
}

function toItem(providerId: string, entry: CatalogEntry, role: MaterialRole, cdnBase: string, prefix: string): MaterialItem {
  return {
    provider: providerId,
    providerId: entry.id,
    role,
    label: entry.label,
    category: entry.category,
    durationSec: entry.durationSec,
    sizeBytes: entry.sizeBytes,
    downloadUrl: `${cdnBase}/${prefix}${encodePath(entry.path)}`,
    licenseName: 'Private library',
  };
}

/**
 * Music and sound effects from the private CDN.
 *
 * One provider rather than two: they share the env, the cache and the shape, and
 * a caller asking for "music" never wants the sound-effect half.
 */
export class PrivateAudioCatalog implements MaterialProvider {
  readonly id = 'private-audio';
  readonly label = '私有音频库';
  readonly roles: readonly MaterialRole[] = ['music', 'sound_effect'];

  #env: CatalogEnv | null | undefined;

  async available(): Promise<boolean> {
    return (await this.#config()) !== null;
  }

  async #config(): Promise<CatalogEnv | null> {
    if (this.#env === undefined) this.#env = await readCatalogEnv();
    return this.#env;
  }

  /** Categories, so a caller can offer the mood list without loading everything. */
  async categories(role: MaterialRole): Promise<string[]> {
    const entries = await this.#entries(role);
    return [...new Set(entries.map((entry) => entry.category).filter(Boolean))].sort();
  }

  async #entries(role: MaterialRole): Promise<CatalogEntry[]> {
    const env = await this.#config();
    if (!env) throw new MaterialError('private audio library is not configured (PRESET_CDN_BASE)');
    if (role === 'music') return loadIndex(env.musicIndexUrl, 'music-index.json', 'music');
    if (role === 'sound_effect') return loadIndex(env.sfxManifestUrl, 'sfx-manifest.json', 'sound_effect');
    throw new MaterialError(`the private library has no "${role}" role`);
  }

  async search(query: MaterialQuery): Promise<MaterialItem[]> {
    const env = await this.#config();
    if (!env) throw new MaterialError('private audio library is not configured (PRESET_CDN_BASE)');

    const entries = (await this.#entries(query.role)).filter((entry) => matches(entry, query));
    const limit = query.limit ?? 20;
    const prefix = query.role === 'sound_effect' ? 'sound_effects/' : '';

    return entries
      .slice(0, limit)
      .map((entry) => toItem(this.id, entry, query.role, env.cdnBase, prefix));
  }
}
