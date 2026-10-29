// `occ apply` — put a storyboard onto a timeline, ready to render.
//
// This is the middle point between "I have a script" and "I have a video": it
// resolves footage, compiles the three lanes, burns captions, and lays the
// voiceover, music and effects onto A1/A2/A3. It does not render — that is a
// separate, slow, deliberate step.
//
// Two things it does that `compile` alone does not:
//
// 1. **Density stays arithmetic.** Whoever wrote the storyboard, the footage
//    policy decides how many shots actually carry a clip. An agent that writes a
//    query on every shot would otherwise turn the pipeline into a stock-footage
//    montage, which is a decision this project has already made once and does
//    not want to make again per storyboard.
//
// 2. **Audio order is not negotiable.** `compile --replace` clears the timeline,
//    so voiceover, music and effects have to go on after it. Doing that by hand
//    is the single easiest way to lose a mix.
//
// The sub-steps run as child `occ` processes rather than in-process calls: each
// one prints its own JSON, and a nested call would corrupt this command's
// payload. The cost is about half a second per step.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { flagBoolean, flagText, rejectUnknownFlags, type CommandLine } from '../args.ts';
import { CliError, UsageError } from '../errors.ts';
import { printJson, writeStdout } from '../output.ts';
import { readProjectDoc, resolveProject } from '../store.ts';
import { GLOBAL_FLAGS, projectReference, requireStoryboardLock } from './common.ts';
import { applyFootagePolicy, DEFAULT_FOOTAGE_POLICY } from '../../production/footage-policy.ts';
import { writeLock } from '../../production/storyboard-lock.ts';
import type { Storyboard } from '../../production/types.ts';

const require = createRequire(import.meta.url);
const ffprobe = require('@ffprobe-installer/ffprobe').path as string;

const FLAGS = [...GLOBAL_FLAGS, 'storyboard', 'audio', 'srt', 'timing', 'timeline', 'replace',
  'no-footage', 'no-music', 'no-sfx', 'no-captions', 'captions-template', 'captions-motion',
  'captions-pacing', 'footage-ratio', 'music-category', 'music-volume', 'json', 'allow-edited'] as const;

const OCC = resolve('cli/occ.mjs');

/** Run an `occ` subcommand and return its JSON payload. */
function occ(args: string[]): unknown {
  const withJson = args.includes('--json') ? args : [...args, '--json'];
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, [OCC, ...withJson], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error as { stderr?: string; message?: string };
    const text = (detail.stderr ?? detail.message ?? '').trim();
    throw new CliError(`apply step failed: occ ${args[0]}\n${text.slice(-1200)}`);
  }
  const lines = stdout.split('\n');
  const start = lines.findIndex((line) => /^\s*[[{]/.test(line));
  if (start === -1) return { ok: true };
  try {
    return JSON.parse(lines.slice(start).join('\n'));
  } catch {
    return { ok: true };
  }
}

function audioSeconds(path: string): number {
  const out = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], {
    encoding: 'utf8',
  });
  const seconds = Number(out.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new CliError(`cannot read duration of ${path}`);
  return seconds;
}

async function readStoryboard(path: string): Promise<Storyboard> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Storyboard;
  } catch (error) {
    throw new CliError(`cannot read storyboard ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Sound effects, one per recipe, at its first appearance, three at most.
 *
 * A recipe may declare the effect it earns; placing it on every appearance of
 * every recipe turns a 259-shot video into a metronome. Placement is a pipeline
 * decision, so it lives here rather than in the recipe.
 */
async function placeSfx(storyboard: Storyboard, project: string, log: string[]): Promise<void> {
  const seen = new Set<string>();
  const plan: Array<{ recipe: string; startFrame: number; sfx: { category: string; query?: string; volume?: number } }> = [];
  for (const shot of storyboard.shots ?? []) {
    const recipeId = shot.visual?.kind === 'mg' ? shot.visual.recipe : undefined;
    if (!recipeId || seen.has(recipeId)) continue;
    seen.add(recipeId);
    let schema: { sfx?: { category: string; query?: string; volume?: number } };
    try {
      schema = JSON.parse(await readFile(`production/recipes/${recipeId}/schema.json`, 'utf8'));
    } catch {
      continue;
    }
    if (!schema.sfx) continue;
    plan.push({ recipe: recipeId, startFrame: shot.startFrame, sfx: schema.sfx });
    if (plan.length >= 3) break;
  }

  for (const entry of plan) {
    try {
      occ(['assets', 'place', project, '--role', 'sound_effect', '--category', entry.sfx.category,
        ...(entry.sfx.query ? ['--query', entry.sfx.query] : []),
        '--track', 'A3', '--from-frame', String(entry.startFrame),
        '--volume', String(entry.sfx.volume ?? 0.35)]);
      log.push(`sfx ${entry.recipe} @ ${entry.startFrame}`);
    } catch (error) {
      // A missing effect is a polish problem, not a reason to lose the mix.
      log.push(`sfx ${entry.recipe} skipped: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }
}

export async function runApplyCommand(commandLine: CommandLine, json: boolean): Promise<void> {
  rejectUnknownFlags(commandLine, FLAGS);

  const storyboardFlag = flagText(commandLine, 'storyboard');
  const audioFlag = flagText(commandLine, 'audio');
  if (!storyboardFlag?.trim()) throw new UsageError('apply needs --storyboard <file.json>');
  if (!audioFlag?.trim()) throw new UsageError('apply needs --audio <voiceover.mp3>');

  const projectName = projectReference(commandLine);
  const project = await resolveProject(projectName);
  const doc = await readProjectDoc(project.id);
  const timelineId = flagText(commandLine, 'timeline') ?? doc.activeTimelineId;
  const timeline = doc.timelines.find((candidate) => candidate.id === timelineId);
  if (!timeline) throw new CliError(`project ${project.name} has no timeline ${timelineId}`);
  if (Number(timeline.fps) !== 30) {
    throw new CliError(`project ${project.name} runs at ${timeline.fps}fps — the pipeline is fixed at 30fps`);
  }

  const file = resolve(storyboardFlag);
  requireStoryboardLock(file, flagBoolean(commandLine, 'allow-edited'));
  const storyboard = await readStoryboard(file);

  // `apply` replaces the timeline, so writing into a project that already has
  // work must be asked for. The old orchestrator had the same guard; losing it
  // would let one call quietly delete a cut somebody had been editing.
  if ((timeline.items ?? []).length > 0 && !flagBoolean(commandLine, 'replace')) {
    throw new CliError(
      `project ${project.name} already has ${(timeline.items ?? []).length} items — pass --replace to rewrite the timeline`,
      {
        code: 'timeline-exists',
        step: 'apply',
        hint: '--replace rewrites the whole timeline, so audio and music are re-added afterwards',
      },
    );
  }

  // The storyboard's canvas and the timeline's must agree: every anchor and the
  // caption band are computed against it, and `compile --replace` writes the
  // storyboard's size onto the timeline.
  if (storyboard.meta?.width !== timeline.width || storyboard.meta?.height !== timeline.height) {
    throw new CliError(
      `storyboard is ${storyboard.meta?.width}x${storyboard.meta?.height} but project ${project.name} is ${timeline.width}x${timeline.height}`,
      {
        code: 'canvas-mismatch',
        step: 'apply',
        hint: 'write the storyboard for the project it will be applied to; --replace would otherwise resize the timeline',
      },
    );
  }

  const steps: string[] = [];
  const noFootage = flagBoolean(commandLine, 'no-footage');

  // 1. Density. Applied here, not trusted from the file: a storyboard that puts
  //    a query on every shot is asking for a montage, and that is not a decision
  //    a per-storyboard author gets to make.
  if (!noFootage) {
    const ratioFlag = flagText(commandLine, 'footage-ratio');
    const ratio = ratioFlag ? Number(ratioFlag) : DEFAULT_FOOTAGE_POLICY.targetRatio;
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      throw new UsageError(`--footage-ratio expects 0..1, got "${ratioFlag}"`);
    }
    const policed = applyFootagePolicy(storyboard, { ...DEFAULT_FOOTAGE_POLICY, targetRatio: ratio });
    const before = JSON.stringify(storyboard);
    const after = JSON.stringify(policed.storyboard);
    if (before !== after) {
      await writeFile(file, `${JSON.stringify(policed.storyboard, null, 2)}\n`, 'utf8');
      writeLock(file, { action: 'apply' });
      steps.push(`density: ${policed.kept.length}/${policed.target} kept`);
    } else {
      steps.push(`density: unchanged (${policed.kept.length}/${policed.target})`);
    }
  }

  // 2. Footage. "Resolved" means the id exists in *this* project's pool: an id
  //    copied from another project is dangling here, and `footage resolve`
  //    re-imports it rather than leaving a shot with a clip nobody can find.
  const current = await readStoryboard(file);
  const poolIds = new Set(doc.assets.map((asset) => asset.id));
  const unresolved = (current.shots ?? []).filter((shot) => {
    const underlay = shot.underlay;
    if (!underlay?.query || underlay.selected === false) return false;
    return !underlay.assetId || !poolIds.has(underlay.assetId);
  });
  if (!noFootage && unresolved.length) {
    occ(['footage', 'resolve', project.name, '--storyboard', file, '--out', file]);
    steps.push(`footage: ${unresolved.length} shot(s) resolved`);
  } else if (!noFootage) {
    steps.push('footage: nothing to resolve');
  }

  // 3. Compile. `--replace` clears the timeline, which is why every audio step
  //    below has to come after it.
  const srtFlag = flagText(commandLine, 'srt');
  const timingFlag = flagText(commandLine, 'timing');
  occ([
    'compile', project.name, '--storyboard', file, '--timeline', timelineId, '--replace', '--apply',
    ...(srtFlag && !flagBoolean(commandLine, 'no-captions') ? ['--srt', resolve(srtFlag)] : []),
    ...(timingFlag ? ['--timing', resolve(timingFlag)] : []),
    ...(flagText(commandLine, 'captions-template') ? ['--captions-template', String(flagText(commandLine, 'captions-template'))] : []),
    ...(flagText(commandLine, 'captions-motion') ? ['--captions-motion', String(flagText(commandLine, 'captions-motion'))] : []),
    ...(flagText(commandLine, 'captions-pacing') ? ['--captions-pacing', String(flagText(commandLine, 'captions-pacing'))] : []),
  ]);
  steps.push('compiled onto the timeline');

  // 4. Voiceover on A1. Imported through the same pool the app uses, so the
  //    project is self-contained and a later render needs no source path.
  const audioPath = resolve(audioFlag);
  const seconds = audioSeconds(audioPath);
  const durationFrames = Math.round(seconds * 30);
  const imported = occ(['tools', 'call', 'import_asset', '--project', project.name,
    '--args', JSON.stringify({ path: audioPath }), '--apply']) as {
    ops?: Array<{ result?: { imported?: Array<{ id: string }> } }>;
  };
  let assetId = imported.ops?.[0]?.result?.imported?.[0]?.id;
  if (!assetId) {
    // A re-run imports nothing and reports a duplicate; fall back to the pool.
    const pool = occ(['media', 'list', '--project', project.name]) as {
      assets?: Array<{ id: string; sourceFilename?: string; name?: string }>;
    };
    const base = audioPath.split(/[\\/]/).pop();
    assetId = (pool.assets ?? []).find((entry) => entry.sourceFilename === base || entry.name === base)?.id;
  }
  if (!assetId) throw new CliError('could not import the voiceover into the project pool');
  occ(['tools', 'call', 'edit_item', '--project', project.name, '--args', JSON.stringify({
    adds: [{ type: 'audio', assetId, track: 'A1', fromFrame: 0, durationInFrames: durationFrames }],
  }), '--apply']);
  steps.push(`voiceover: ${durationFrames} frames on A1`);

  // 5. Music, by the mood the storyboard named. The bed is chained from tracks
  //    in that mood because the library is songs, not loops.
  const finalStoryboard = await readStoryboard(file);
  const category = flagText(commandLine, 'music-category') ?? finalStoryboard.music?.category;
  if (!flagBoolean(commandLine, 'no-music') && category) {
    occ(['assets', 'place', project.name, '--role', 'music', '--category', String(category),
      '--min-duration', String(Math.ceil(seconds)), '--duration-frames', String(durationFrames),
      '--loop', '--volume', String(flagText(commandLine, 'music-volume') ?? 0.14)]);
    steps.push(`music: ${category}`);
  } else {
    steps.push('music: none');
  }

  // 6. Effects.
  if (!flagBoolean(commandLine, 'no-sfx')) {
    const before = steps.length;
    await placeSfx(finalStoryboard, project.name, steps);
    if (steps.length === before) steps.push('sfx: none declared');
  }

  const after = await readProjectDoc(project.id);
  const afterTimeline = after.timelines.find((candidate) => candidate.id === timelineId);
  const payload = {
    ok: true,
    project: project.name,
    projectId: project.id,
    timelineId,
    items: afterTimeline?.items.length ?? 0,
    storyboard: file,
    seconds: Number(seconds.toFixed(2)),
    steps,
  };

  if (json) {
    printJson(payload);
    return;
  }
  writeStdout(`${payload.items} items on ${timelineId} · ${payload.seconds}s`);
  for (const step of steps) writeStdout(`  ${step}`);
  writeStdout('next: occ still (look at it) or occ render --out <abs.mp4>');
}
