// `occ start` — one call from "here is my voiceover" to "here is a draft you can
// look at".
//
// The pipeline could already do this in nine steps, and an agent could drive
// them. What it could not do is produce anything a person can *see* before the
// final render: the storyboard is JSON and the timeline is invisible. So the
// review step had nothing to review, and "look at it and tell me" turned into
// "render four minutes of video and then we will talk".
//
// This command is `make --no-render` plus a contact sheet: it creates the
// project, transcribes, writes the storyboard, applies it, and renders a handful
// of frames at shot midpoints. Everything after that is a decision — ship it, or
// change one shot.
//
// It deliberately does not render. The whole point is to stop before the
// expensive step and ask.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { flagBoolean, flagText, rejectUnknownFlags, type CommandLine } from '../args.ts';
import { CliError } from '../errors.ts';
import { printJson, writeStdout } from '../output.ts';
import { GLOBAL_FLAGS } from './common.ts';
import type { Storyboard } from '../../production/types.ts';

const FLAGS = [...GLOBAL_FLAGS, 'audio', 'srt', 'brief', 'name', 'size', 'generate', 'from',
  'storyboard', 'preview', 'preview-width', 'json'] as const;

const MAKE_VIDEO = resolve('production/make-video.mjs');

function occ(args: string[]): Record<string, unknown> {
  const withJson = args.includes('--json') ? args : [...args, '--json'];
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, ['cli/occ.mjs', ...withJson], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error as { stderr?: string; message?: string };
    throw new CliError(`start step failed: occ ${args[0]}\n${(detail.stderr ?? detail.message ?? '').trim().slice(-1200)}`);
  }
  const lines = stdout.split('\n');
  const at = lines.findIndex((line) => /^\s*[[{]/.test(line));
  if (at === -1) return {};
  try {
    return JSON.parse(lines.slice(at).join('\n')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Frames worth looking at.
 *
 * The midpoint of a shot is where the animation has landed and the layout is at
 * its most legible — a frame at the start shows an empty card mid-transition and
 * teaches the reviewer nothing.
 *
 * Which shots, though, is not a spacing problem. The first real run of this
 * command picked four evenly spaced shots and hit four card-only ones, so the
 * draft looked like a slide deck while a third of the timeline was footage. The
 * review copy has to contain at least one clip and one card, because that is the
 * question a reviewer is actually asking: is this a video or a deck?
 */
function previewFrames(shots: Storyboard['shots'], wanted: number): Array<{ id: string; frame: number }> {
  const ordered = [...(shots ?? [])].sort((a, b) => a.startFrame - b.startFrame);
  if (!ordered.length || wanted <= 0) return [];
  const count = Math.min(wanted, ordered.length);
  const picks = new Set<number>();
  const add = (index: number) => {
    if (index >= 0 && index < ordered.length && picks.size < count) picks.add(index);
  };

  add(0);
  if (count > 1) add(ordered.length - 1);
  if (count > 2) add(ordered.findIndex((shot) => shot.underlay?.selected === true));
  if (count > 3) add(ordered.findIndex((shot) => shot.underlay?.selected !== true));

  // Whatever is left, spread across the cut so the copy is not all from one end.
  for (let i = 0; i < count && picks.size < count; i += 1) {
    add(Math.round((i * (ordered.length - 1)) / Math.max(1, count - 1)));
  }
  for (let index = 0; index < ordered.length && picks.size < count; index += 1) add(index);

  return [...picks]
    .sort((a, b) => a - b)
    .map((index) => {
      const shot = ordered[index]!;
      return { id: shot.id, frame: Math.round((shot.startFrame + shot.endFrame) / 2) };
    });
}

export async function runStartCommand(commandLine: CommandLine, json: boolean): Promise<void> {
  rejectUnknownFlags(commandLine, FLAGS);

  const audio = flagText(commandLine, 'audio');
  const srt = flagText(commandLine, 'srt');
  const brief = flagText(commandLine, 'brief');
  const name = flagText(commandLine, 'name');
  const storyboardFlag = flagText(commandLine, 'storyboard');
  if (!audio?.trim()) throw new CliError('start needs --audio <voiceover>');
  if (!srt?.trim()) throw new CliError('start needs --srt <subtitles>');
  if (!name?.trim()) throw new CliError('start needs --name <project>');
  // A brief is only needed when the storyboard has to be written. Reusing one
  // that already exists does not need a description of itself.
  if (!brief?.trim() && !storyboardFlag && !flagText(commandLine, 'from')) {
    throw new CliError('start needs --brief (one line: what is this video about)');
  }

  const previewCount = Number(flagText(commandLine, 'preview') ?? 4);
  if (!Number.isFinite(previewCount) || previewCount < 0 || previewCount > 12) {
    throw new CliError('--preview expects 0..12');
  }
  const previewWidth = Number(flagText(commandLine, 'preview-width') ?? 640);

  // 1. Everything up to and including the timeline. `make` owns the order; this
  //    command must not re-implement it or the two will drift.
  const makeArgs = [
    '--audio', resolve(audio),
    '--srt', resolve(srt),
    '--name', name,
    '--no-render',
    '--json',
  ];
  if (brief) makeArgs.push('--brief', brief);
  if (flagText(commandLine, 'size')) makeArgs.push('--size', String(flagText(commandLine, 'size')));
  if (flagText(commandLine, 'from')) makeArgs.push('--from', resolve(String(flagText(commandLine, 'from'))));
  if (storyboardFlag) makeArgs.push('--storyboard', resolve(storyboardFlag));
  if (flagBoolean(commandLine, 'generate')) makeArgs.push('--generate');

  let made: Record<string, unknown>;
  try {
    const out = execFileSync(process.execPath, [MAKE_VIDEO, ...makeArgs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    const lines = out.split('\n');
    const at = lines.findIndex((line) => /^\s*[[{]/.test(line));
    made = JSON.parse(lines.slice(at).join('\n')) as Record<string, unknown>;
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    // `make` prints a JSON envelope even when it stops, and the reason is in it.
    const text = String(detail.stdout ?? '') + String(detail.stderr ?? '');
    const lines = text.split('\n');
    const at = lines.findIndex((line) => /^\s*[[{]/.test(line));
    if (at !== -1) {
      try {
        const payload = JSON.parse(lines.slice(at).join('\n')) as { error?: { message?: string } };
        throw new CliError(`start failed: ${payload.error?.message ?? 'the pipeline stopped'}\n${text.slice(-800)}`);
      } catch (parseError) {
        if (parseError instanceof CliError) throw parseError;
      }
    }
    throw new CliError(`start failed\n${text.trim().slice(-1200)}`);
  }

  const storyboardPath = String(made.storyboard ?? '');
  if (!storyboardPath) throw new CliError('start: the pipeline did not report a storyboard path');
  const storyboard = JSON.parse(await readFile(storyboardPath, 'utf8')) as Storyboard;

  // 2. The review copy. One still call for the whole batch — the per-call cost is
  //    the bundler, not the frame count.
  const picks = previewFrames(storyboard.shots, previewCount);
  const preview: Array<{ shot: string; frame: number; path: string }> = [];
  if (picks.length) {
    // Next to the run, not next to the storyboard: a storyboard handed in from
    // elsewhere should not scatter previews into that directory.
    const dir = resolve('production/work', name, 'preview');
    const stills = occ([
      'still', name, '--out', dir,
      '--frames', picks.map((pick) => pick.frame).join(','),
      '--width', String(previewWidth),
    ]) as { written?: Array<{ frame: number; path: string }> };
    for (const pick of picks) {
      const hit = (stills.written ?? []).find((entry) => entry.frame === pick.frame);
      if (hit) preview.push({ shot: pick.id, frame: pick.frame, path: hit.path });
    }
  }

  // 3. The judgement, in the same payload: findings plus the scorecard, so the
  //    reviewer sees "two cards repeat the line" next to the frames that show it.
  const checked = occ(['check', '--storyboard', storyboardPath]) as {
    findings?: unknown[];
    score?: unknown;
    stats?: unknown;
  };

  const payload = {
    ok: true,
    project: made.project,
    projectId: made.projectId,
    storyboard: storyboardPath,
    items: made.items,
    seconds: made.seconds,
    steps: made.steps,
    findings: checked.findings ?? [],
    score: checked.score ?? null,
    preview,
  };

  if (json) {
    printJson(payload);
    return;
  }
  writeStdout(`${payload.items} items · ${payload.seconds}s · ${storyboard.shots.length} shots`);
  for (const line of (made.steps as string[]) ?? []) writeStdout(`  ${line}`);
  const findings = (checked.findings as Array<{ severity: string; message: string }>) ?? [];
  for (const finding of findings) writeStdout(`  ${finding.severity}: ${finding.message}`);
  if (preview.length) {
    writeStdout('\npreview:');
    for (const entry of preview) writeStdout(`  ${entry.shot} @ ${entry.frame}  ${entry.path}`);
  }
  writeStdout('\nsatisfied → occ render --out <abs.mp4>');
  writeStdout('one shot off → occ revise <storyboard> --ops ops.json, then occ apply + occ still');
}
