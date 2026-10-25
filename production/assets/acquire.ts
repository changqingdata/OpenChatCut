// Bringing a remote material down to a local file.
//
// Nothing in the timeline ever points at a CDN or a provider URL: the project
// owns its media. So every acquired item is written to disk first and then
// imported into the pool, which is what makes a finished project work offline.
//
// This module only downloads. Registering the file as a project asset stays with
// the caller, because that step needs the project store.

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import type { MaterialItem } from './types.ts';
import { MaterialError } from './types.ts';

const DOWNLOAD_DIR = 'production/work/assets-download';

function extension(item: MaterialItem): string {
  const fromUrl = extname(new URL(item.downloadUrl).pathname).toLowerCase();
  if (fromUrl && fromUrl.length <= 6) return fromUrl;
  if (item.role === 'video') return '.mp4';
  if (item.role === 'image') return '.jpg';
  if (item.role === 'gif') return '.gif';
  if (item.role === 'icon') return '.svg';
  return '.mp3';
}

/** Keep the name filesystem-safe; the provider id already guarantees uniqueness. */
function safeName(item: MaterialItem): string {
  const label = item.label.replace(/[\\/:*?"<>|]/g, '-').slice(0, 40).trim();
  return `${item.provider}-${item.providerId}${label ? `-${label}` : ''}`;
}

export interface AcquiredFile {
  path: string;
  bytes: number;
  item: MaterialItem;
}

/**
 * Download one item to a local file.
 *
 * The byte count is checked against the index when the index knows it: a
 * truncated transfer would otherwise surface much later as a broken render.
 */
export async function acquireToFile(item: MaterialItem, dir = DOWNLOAD_DIR): Promise<AcquiredFile> {
  const target = resolve(join(dir, `${safeName(item)}${extension(item)}`));
  await mkdir(dirname(target), { recursive: true });

  let response: Response;
  try {
    response = await fetch(item.downloadUrl);
  } catch (error) {
    throw new MaterialError(`download failed for ${item.label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new MaterialError(`download failed for ${item.label}: HTTP ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  if (item.sizeBytes && buffer.byteLength !== item.sizeBytes) {
    throw new MaterialError(
      `download for ${item.label} is ${buffer.byteLength} bytes, the index says ${item.sizeBytes}`,
    );
  }
  if (!buffer.byteLength) throw new MaterialError(`download for ${item.label} was empty`);

  await writeFile(target, buffer);
  const info = await stat(target);
  return { path: target, bytes: info.size, item };
}
