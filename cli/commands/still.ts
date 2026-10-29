// `occ still` — render still frames of a saved project to image files.
//
// Same composition the Player and the export use, so a still is real evidence of
// what the timeline produces at that frame. The frames come back as base64 JPEG
// from the shared Remotion pipeline; this command only writes them to disk.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CliError, UsageError } from '../errors.ts';
import { flagText, rejectUnknownFlags, type CommandLine } from '../args.ts';
import { printJson, writeStdout } from '../output.ts';
import { readProjectDoc, resolveProject } from '../store.ts';
import { setUploadsDirProvider, renderTimelineStills } from '../../server/plugins/export-rendering.ts';
import { uploadDir } from '../../server/media-dir.ts';
import { GLOBAL_FLAGS, parseFrames, projectReference } from './common.ts';

const FLAGS = [...GLOBAL_FLAGS, 'out', 'frames', 'seconds', 'timeline', 'json', 'width'] as const;

function frameList(commandLine: CommandLine, fps: number): number[] {
  const framesFlag = flagText(commandLine, 'frames');
  const secondsFlag = flagText(commandLine, 'seconds');
  if (framesFlag && secondsFlag) throw new UsageError('pass --frames or --seconds, not both');

  if (secondsFlag) {
    const values = secondsFlag.split(',').map((part) => Number(part.trim()));
    if (values.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new UsageError('--seconds expects comma-separated non-negative numbers');
    }
    return values.map((value) => Math.round(value * fps));
  }

  if (!framesFlag) throw new UsageError('still needs --frames 0,60,120 or --seconds 0,2,4');
  return framesFlag.split(',').map((part) => parseFrames(part.trim(), fps, 'frames'));
}

export async function runStillCommand(commandLine: CommandLine, json: boolean): Promise<void> {
  rejectUnknownFlags(commandLine, FLAGS);
  // The CLI does not mount exportPlugin, which normally wires the active library
  // into Remotion. Same provider the render command uses.
  setUploadsDirProvider(uploadDir);

  const outFlag = flagText(commandLine, 'out');
  if (!outFlag?.trim()) throw new UsageError('still needs --out <dir>');
  const outDir = resolve(outFlag);

  const project = await resolveProject(projectReference(commandLine));
  const doc = await readProjectDoc(project.id);
  const timelineId = flagText(commandLine, 'timeline') ?? doc.activeTimelineId;
  const timeline = doc.timelines.find((candidate) => candidate.id === timelineId);
  if (!timeline) {
    throw new CliError(`Project ${project.name} has no timeline ${timelineId}.\n${
      doc.timelines.map((candidate) => `  ${candidate.id}  ${candidate.name}`).join('\n')}`);
  }

  const frames = frameList(commandLine, timeline.fps);
  if (!frames.length) throw new UsageError('--frames resolved to nothing');

  await mkdir(outDir, { recursive: true });

  // The default is sized for a caller that cannot see images: 480-640px keeps a
  // batch cheap. An agent that *can* look needs the type to be legible — a
  // caption overlap is invisible at 480. `--width` is that caller's dial; the
  // renderer never upscales past the composition.
  const widthFlag = flagText(commandLine, 'width');
  const width = widthFlag ? Number(widthFlag) : undefined;
  if (widthFlag && (!Number.isFinite(width) || (width as number) <= 0)) {
    throw new UsageError(`--width expects a positive number, got "${widthFlag}"`);
  }

  let stills;
  try {
    stills = await renderTimelineStills({
      state: { ...timeline, assets: doc.assets },
      project: doc,
      timelineId: timeline.id,
      frames,
      ...(width ? { width } : {}),
    });
  } catch (error) {
    throw new CliError(`still render failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const written: Array<{ frame: number; path: string; bytes: number }> = [];
  for (const still of stills) {
    const buffer = Buffer.from(still.base64, 'base64');
    const path = join(outDir, `frame-${String(still.frame).padStart(6, '0')}.jpg`);
    await writeFile(path, buffer);
    written.push({ frame: still.frame, path, bytes: buffer.byteLength });
  }

  if (json) {
    printJson({
      projectId: project.id,
      timelineId: timeline.id,
      fps: timeline.fps,
      requested: frames,
      written,
    });
    return;
  }
  for (const entry of written) {
    writeStdout(`frame ${entry.frame} → ${entry.path} (${Math.round(entry.bytes / 1024)} KB)`);
  }
}
