// Make a referenced upload real on disk.
//
// `import_asset` on a local path does not copy bytes: it writes
// `<uploads>/.references/<name>.json` pointing at the original file. That works
// for the HTTP media route, which resolves references, and for audio, which the
// export pipeline fetches over HTTP.
//
// It does not work for video or images. The renderer serves those from the
// static bundle, whose `media/uploads` is a symlink to the upload directory, and
// a JSON pointer is not a media file — the request 404s and the still comes out
// blank. So footage has to be hard-linked (same volume, free) or copied
// (different volume) into the upload directory under its stored name.
//
// The app's own imports from the desktop do the same thing by a different route;
// the CLI needs it explicitly because nothing in the headless path does it.

import { copyFile, link, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type MaterializeResult = 'present' | 'linked' | 'copied';

/**
 * Ensure `uploads/<storedName>` is a real file with the same bytes as `sourcePath`.
 *
 * Idempotent: a second call for the same clip costs one `existsSync`.
 */
export async function materializeUpload(
  uploadsDir: string,
  storedName: string,
  sourcePath: string,
): Promise<MaterializeResult> {
  const target = join(uploadsDir, storedName);
  if (existsSync(target)) return 'present';

  await mkdir(uploadsDir, { recursive: true });
  try {
    await link(sourcePath, target);
    return 'linked';
  } catch {
    // Different volume, or a filesystem without hard links.
    await copyFile(sourcePath, target);
    return 'copied';
  }
}
