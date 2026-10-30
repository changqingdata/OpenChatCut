// `occ compile` — turn a Storyboard JSON into a timeline inside a saved project.
//
// The compiler is pure: this command owns the impure parts — reading the file,
// merging the result into the existing project, and committing. Assets, media
// folders, the design style and every other timeline are preserved; only the
// timeline the storyboard names is written.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CliError, UsageError } from '../errors.ts';
import { flagBoolean, flagText, rejectUnknownFlags, type CommandLine } from '../args.ts';
import { printJson, writeStdout } from '../output.ts';
import { resolveProject } from '../store.ts';
import { getStoredEntry, setStoredEntry } from '../../server/plugins/project-store.ts';
import { runProjectMigrations } from '../../src/persist/migrations/index.ts';
import { compile, CompileError, OVER_FOOTAGE_MUTED } from '../../src/pipeline/compile.ts';
import { storyboardHash } from '../../src/pipeline/storyboard-apply.ts';
import type { CompileAsset } from '../../src/pipeline/compile.ts';
import { checkParams, loadRecipeRegistry } from '../../production/recipes/load.ts';
import { buildCaptions } from '../../production/captions.ts';
import type { SpeechTiming } from '../../production/transcribe.ts';
import { parseSrtCues } from '../../production/srt.ts';
import type { ProjectDoc } from '../../src/editor/projectTypes.ts';
import type { Storyboard } from '../../src/pipeline/types.ts';
import { GLOBAL_FLAGS, projectReference, requireStoryboardLock } from './common.ts';

const FLAGS = [...GLOBAL_FLAGS, 'storyboard', 'timeline', 'replace', 'apply', 'json', 'allow-edited',
  'srt', 'timing', 'captions-template', 'captions-motion', 'captions-pacing', 'no-captions'] as const;

/**
 * The compiler's view of the asset pool.
 *
 * Only fields an underlay can use are copied across. Handing the compiler the
 * whole doc would let it start reasoning about project state, which is exactly
 * what keeps it testable.
 */
function poolAssets(doc: ProjectDoc): Map<string, CompileAsset> {
  const assets = new Map<string, CompileAsset>();
  for (const asset of doc.assets) {
    assets.set(asset.id, {
      id: asset.id,
      src: asset.src,
      kind: asset.kind,
      ...(asset.width ? { width: asset.width } : {}),
      ...(asset.height ? { height: asset.height } : {}),
      ...(asset.durationInFrames ? { durationInFrames: asset.durationInFrames } : {}),
      ...(asset.sourceFilename ? { sourceFilename: asset.sourceFilename } : {}),
      ...(asset.sourceRevision ? { sourceRevision: asset.sourceRevision } : {}),
    });
  }
  return assets;
}

async function readStoryboard(path: string): Promise<Storyboard> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new CliError(`cannot read storyboard: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliError(`storyboard is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('storyboard must be a JSON object');
  }
  return parsed as Storyboard;
}

export async function runCompileCommand(commandLine: CommandLine, json: boolean): Promise<void> {
  rejectUnknownFlags(commandLine, FLAGS);

  const storyboardFlag = flagText(commandLine, 'storyboard');
  if (!storyboardFlag?.trim()) throw new UsageError('compile needs --storyboard <file.json>');
  const apply = flagBoolean(commandLine, 'apply');
  const replace = flagBoolean(commandLine, 'replace');

  const project = await resolveProject(projectReference(commandLine));
  const storyboardFile = resolve(storyboardFlag);
  // Before anything is read: a generated storyboard that changed on disk is an
  // edit that never met the validator. Refusing here is what makes `revise` the
  // only sanctioned way to touch a storyboard.
  requireStoryboardLock(storyboardFile, flagBoolean(commandLine, 'allow-edited'));
  const storyboard = await readStoryboard(storyboardFile);

  const { registry, schemas } = await loadRecipeRegistry(resolve('production/recipes'));

  // Captions come from the subtitle file, not the storyboard: the storyboard
  // decides picture, the subtitle file knows what was actually said.
  let captions;
  const srtFlag = flagText(commandLine, 'srt');
  if (srtFlag && !flagBoolean(commandLine, 'no-captions')) {
    const cues = parseSrtCues(await readFile(resolve(srtFlag), 'utf8'));
    if (!cues.length) throw new CliError(`no cues parsed from ${srtFlag}`);
    // Word-level timing from `occ transcribe`. Optional: without it the caption
    // builder falls back to spreading each cue by character count.
    const timingFlag = flagText(commandLine, 'timing');
    let timing;
    if (timingFlag?.trim()) {
      try {
        timing = JSON.parse(await readFile(resolve(timingFlag), 'utf8')) as SpeechTiming;
      } catch (error) {
        throw new CliError(`cannot read --timing ${timingFlag}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!Array.isArray(timing?.tokens) || !timing.tokens.length) {
        throw new CliError(`--timing ${timingFlag} contains no tokens`, {
          code: 'timing-empty',
          step: 'compile',
          hint: 're-run occ transcribe on the same audio; an empty profile means the model heard nothing',
        });
      }
    }
    captions = buildCaptions(cues, {
      ...(timing ? { timing } : {}),
      ...(flagText(commandLine, 'captions-template')
        ? { template: flagText(commandLine, 'captions-template') as never }
        : {}),
      ...(flagText(commandLine, 'captions-motion')
        ? { motion: flagText(commandLine, 'captions-motion') as never }
        : {}),
      // 'word' shows one unit per page, so the measured timing is what decides
      // when each character appears. 'phrase' (the default) still uses the word
      // timings, but only to place page boundaries.
      ...(flagText(commandLine, 'captions-pacing')
        ? { pacing: flagText(commandLine, 'captions-pacing') as never }
        : {}),
    });
  }

  // Validate every `mg` shot's params before compiling: a typo should fail here
  // with the field name, not render as a silent default.
  const paramErrors: string[] = [];
  for (const shot of storyboard.shots ?? []) {
    const visual = shot.visual;
    if (visual?.kind !== 'mg') continue;
    const schema = schemas.get(visual.recipe);
    if (!schema) {
      paramErrors.push(`${shot.id}: unknown recipe "${visual.recipe}" (have: ${[...schemas.keys()].join(', ') || 'none'})`);
      continue;
    }
    // A generated storyboard already carries every schema default, so the
    // footage correction has to be applied last rather than seeded. It is a
    // legibility rule, not a taste: over footage, secondary text must be light
    // whatever the storyboard says.
    const onFootage = Boolean(shot.underlay) && shot.underlay?.selected !== false;
    const seeded = onFootage
      ? { ...(visual.params ?? {}), muted: OVER_FOOTAGE_MUTED }
      : (visual.params ?? {});

    const checked = checkParams(schema, seeded);
    if (!checked.ok) {
      for (const error of checked.errors) paramErrors.push(`${shot.id}: ${error}`);
    } else {
      visual.params = checked.value;
    }
  }
  if (paramErrors.length) {
    throw new CliError(`storyboard rejected:\n  - ${paramErrors.join('\n  - ')}`, {
      code: 'params-invalid',
      step: 'compile',
      hint: 'fix the named fields — each recipe schema lists every limit',
    });
  }

  // Read the project before compiling: the compiler is pure, so it needs the
  // pool handed to it in order to turn an underlay's assetId into a media item.
  const key = `project:${project.id}`;
  const entry = await getStoredEntry(key);
  if (!entry.found) throw new CliError(`Project ${project.name} has no stored document.`);
  const migrated = runProjectMigrations(entry.value);
  if (!migrated) throw new CliError(`Project ${project.name} has an unreadable document.`);
  const currentDoc = migrated.doc;

  let compiled;
  try {
    compiled = compile(storyboard, {
      recipes: registry,
      assets: poolAssets(currentDoc),
      ...(captions ? { captions } : {}),
      ...(flagText(commandLine, 'timeline') ? { timelineId: flagText(commandLine, 'timeline')! } : {}),
    });
  } catch (error) {
    if (error instanceof CompileError) {
      throw new CliError(`storyboard rejected:\n  - ${error.errors.join('\n  - ')}`);
    }
    throw error;
  }

  const { timeline, warnings } = compiled;

  if (!apply) {
    const summary = {
      projectId: project.id,
      timelineId: timeline.id,
      items: timeline.items.length,
      durationFrames: timeline.items.reduce(
        (end, item) => Math.max(end, item.startFrame + item.durationInFrames), 0),
      fps: timeline.fps,
      size: `${timeline.width}x${timeline.height}`,
      warnings,
      applied: false,
    };
    if (json) printJson(summary);
    else {
      writeStdout(`plan: ${timeline.items.length} items, ${summary.durationFrames} frames @ ${timeline.fps}fps → timeline ${timeline.id}`);
      for (const warning of warnings) writeStdout(`  warning: ${warning.message}`);
      writeStdout('dry run — pass --apply to write');
    }
    return;
  }

  // NOTE: written through the plain store entry rather than
  // `withSerializedProjectStore`. The lock wrapper needs the host's store
  // initialisation and never settles in the CLI process; a single-shot command
  // run by hand does not need cross-process serialisation. Replace with the
  // locked path once the CLI grows a long-running mode.
  const current = currentDoc;
  const existing = current.timelines.find((candidate) => candidate.id === timeline.id);
  if (existing && !replace) {
    throw new CliError(
      `timeline ${timeline.id} already exists — pass --replace to overwrite it, or --timeline <id> to write elsewhere`,
      {
        code: 'timeline-exists',
        step: 'compile',
        hint: 'add --replace; it rewrites the whole timeline, so audio and music have to be re-added after it',
      },
    );
  }

  // Keep every timeline the storyboard does not name; replace or append ours.
  const timelines = existing
    ? current.timelines.map((candidate) => (candidate.id === timeline.id ? timeline : candidate))
    : [...current.timelines, { ...timeline, order: current.timelines.length }];

  // The storyboard travels with the project, exactly as the app's
  // `apply_storyboard` does. A project that cannot answer "which board produced
  // this timeline" cannot be edited shot by shot later.
  const next = {
    ...current,
    timelines,
    activeTimelineId: timeline.id,
    storyboard,
    storyboardAppliedHash: storyboardHash(storyboard),
  };
  await setStoredEntry(key, next);
  const result = { replaced: Boolean(existing), timelineCount: timelines.length };

  const summary = {
    projectId: project.id,
    timelineId: timeline.id,
    items: timeline.items.length,
    replaced: result.replaced,
    timelineCount: result.timelineCount,
    warnings,
    applied: true,
  };
  if (json) printJson(summary);
  else {
    writeStdout(
      `${result.replaced ? 'replaced' : 'added'} timeline ${timeline.id}: `
      + `${timeline.items.length} items (project now has ${result.timelineCount})`,
    );
    for (const warning of warnings) writeStdout(`  warning: ${warning.message}`);
  }
}
