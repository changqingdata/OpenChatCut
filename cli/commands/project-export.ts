// `occ project export` — the bridge between the two stores.
//
// The app keeps projects in IndexedDB; the CLI keeps them in the server store.
// That is fine while each side works alone, and it is a wall the moment you want
// to look at a CLI-built cut in the editor: the project simply is not there.
//
// The app already imports a package format (`openchatcut-project@2`, NDJSON:
// a manifest line, then per-media start/chunk/end lines). The dashboard has an
// Import button and the format has an importer — what was missing was a producer.
// This is it, written against the same constant the importer validates, so the
// two cannot drift apart.
import { createWriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve as resolvePath } from 'node:path';
import { CliError } from '../errors.ts';
import { printJson, writeStdout } from '../output.ts';
import { profileReport } from '../profile.ts';
import { readProjectDoc, resolveProject } from '../store.ts';
import { PROJECT_STREAM_FORMAT, collectUploadSrcs } from '../../src/persist/projectTransfer.ts';
import { sanitizePortableProjectDoc } from '../../src/persist/portableProject.ts';

const MEDIA_PREFIX = '/media/uploads/';
/** Same ceiling the importer enforces per entry; a bigger file is reported, not silently dropped. */
const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
/** Base64 per line. The importer concatenates chunks, so the size only affects memory. */
const CHUNK_BYTES = 512 * 1024;

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

export interface ExportProjectResult {
  file: string;
  project: string;
  projectId: string;
  mediaTotal: number;
  mediaExported: number;
  mediaMissing: string[];
  bytes: number;
}

export async function exportProject(projectName: string, outFile: string): Promise<ExportProjectResult> {
  const project = await resolveProject(projectName);
  if (!project) throw new CliError(`no project matching "${projectName}"`);
  const doc = await readProjectDoc(project.id);

  // Strip machine-specific paths first: a package is meant to be opened
  // somewhere else, and a dangling absolute path is worse than no path.
  const portable = sanitizePortableProjectDoc(doc);
  const srcs = collectUploadSrcs(portable);
  const { mediaDir } = await profileReport();

  const out = resolvePath(outFile);
  const stream = createWriteStream(out, { encoding: 'utf8' });
  const write = (value: unknown) => new Promise<void>((done, fail) => {
    stream.write(`${JSON.stringify(value)}\n`, (error) => (error ? fail(error) : done()));
  });

  try {
    await write({
      format: PROJECT_STREAM_FORMAT,
      type: 'manifest',
      name: project.name,
      exportedAt: new Date().toISOString(),
      doc: portable,
    });

    const missing: string[] = [];
    let exported = 0;
    for (const src of srcs) {
      const name = src.slice(MEDIA_PREFIX.length);
      const path = join(mediaDir, name);
      let bytes: Buffer;
      try {
        const info = await stat(path);
        if (info.size <= 0 || info.size > MAX_MEDIA_BYTES) {
          missing.push(src);
          continue;
        }
        bytes = await readFile(path);
      } catch {
        missing.push(src);
        continue;
      }

      const asset = portable.assets.find((candidate) => candidate.src === src);
      await write({
        type: 'media-start',
        src,
        name,
        mime: MIME[extname(name).toLowerCase()] ?? 'application/octet-stream',
        bytes: bytes.length,
        ...(asset?.sourceRevision ? { sourceRevision: asset.sourceRevision } : {}),
        ...(typeof asset?.sourceSize === 'number' ? { sourceSize: asset.sourceSize } : {}),
        ...(typeof asset?.sourceModifiedAt === 'number' ? { sourceModifiedAt: asset.sourceModifiedAt } : {}),
      });
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        await write({ type: 'media-chunk', data: bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64') });
      }
      await write({ type: 'media-end', src });
      exported += 1;
    }

    await new Promise<void>((done) => stream.end(done));
    const size = (await stat(out)).size;
    return {
      file: out,
      project: project.name,
      projectId: project.id,
      mediaTotal: srcs.length,
      mediaExported: exported,
      mediaMissing: missing,
      bytes: size,
    };
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

export async function runProjectExport(projectName: string, outFile: string, json: boolean): Promise<void> {
  const result = await exportProject(projectName, outFile);
  if (json) {
    printJson(result);
    return;
  }
  writeStdout(`exported ${result.project} → ${result.file}`);
  writeStdout(`  ${(result.bytes / 1024 / 1024).toFixed(1)} MB · ${result.mediaExported}/${result.mediaTotal} media file(s)`);
  if (result.mediaMissing.length) {
    writeStdout(`  ${result.mediaMissing.length} missing (the import will list them):`);
    for (const src of result.mediaMissing.slice(0, 5)) writeStdout(`    ${src}`);
  }
  writeStdout('  open the app → My Projects → Import Project');
}
