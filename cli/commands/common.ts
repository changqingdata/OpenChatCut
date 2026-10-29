// Shared plumbing for the command modules: project selection and flag checking.
import { flagText, GLOBAL_FLAGS, type CommandLine } from '../args.ts';
import { CliError, UsageError } from '../errors.ts';
import { inspectLock, type LockInspection } from '../../production/storyboard-lock.ts';

export { GLOBAL_FLAGS };

/**
 * Refuse a storyboard whose bytes changed after the pipeline wrote it.
 *
 * `unlocked` is legal — a hand-authored storyboard was never generated, so
 * there is nothing to compare against. `edited` is not: a hand-edit skips the
 * validator and QC, and the timeline it produces has no validator of its own.
 *
 * `--allow-edited` stays available for a file that was authored by hand and
 * locked by accident. It is not a way to skip QC — the validator still runs.
 */
export function requireStoryboardLock(file: string, allowEdited: boolean): LockInspection {
  const inspection = inspectLock(file);
  if (inspection.state !== 'edited' || allowEdited) return inspection;
  throw new CliError(
    `generated storyboard was modified outside the pipeline: ${file}`,
    {
      code: 'storyboard-edited',
      step: 'storyboard-lock',
      hint: 'edit it with `occ revise` (it validates and re-locks), or pass --allow-edited for a file that was authored by hand',
    },
  );
}

/** A command's own view of the line: positionals after its own name. */
export function subLine(commandLine: CommandLine, positionals: readonly string[]): CommandLine {
  return { positionals, flags: commandLine.flags };
}

/** `<project>` positional wins over `--project`; both may be omitted (newest project). */
export function projectReference(commandLine: CommandLine, index = 0): string | undefined {
  return commandLine.positionals[index] ?? flagText(commandLine, 'project');
}

export function requirePositional(commandLine: CommandLine, index: number, label: string): string {
  const value = commandLine.positionals[index];
  if (value === undefined || !value.trim()) {
    throw new UsageError(`missing ${label}`);
  }
  return value;
}

/** `1920x1080` / `1080p` / `2160p` → [width, height]. */
export function parseSize(input: string): [number, number] {
  const shorthand = /^(\d{3,4})p$/i.exec(input.trim());
  if (shorthand) {
    const height = Number(shorthand[1]);
    const width = Math.round((height * 16) / 9 / 2) * 2;
    return [width, height];
  }
  const pair = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec(input.trim());
  if (!pair) throw new UsageError(`--size expects WIDTHxHEIGHT (for example 1920x1080), got "${input}"`);
  return [Number(pair[1]), Number(pair[2])];
}

export function positiveInteger(input: string, flag: string): number {
  const value = Number(input);
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`--${flag} expects a positive integer, got "${input}"`);
  }
  return value;
}

/** Frames are the editor's unit, seconds are a human's: accept `240`, `240f`, or `4s`. */
export function parseFrames(input: string, fps: number, flag: string): number {
  const text = input.trim().toLowerCase();
  const seconds = /^([0-9]*\.?[0-9]+)s$/.exec(text);
  if (seconds) return Math.round(Number(seconds[1]) * fps);
  const frames = /^([0-9]+)f?$/.exec(text);
  if (frames) return Number(frames[1]);
  throw new UsageError(`--${flag} expects frames (240) or seconds (4s), got "${input}"`);
}
