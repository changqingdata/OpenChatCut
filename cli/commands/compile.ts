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
import { compile, CompileError } from '../../production/compile.ts';
import type { CompileAsset } from '../../production/compile.ts';
import { checkParams, loadRecipeRegistry } from '../../production/recipes/load.ts';
import { buildCaptions } from '../../production/captions.ts';
import { parseSrtCues } from '../../production/srt.ts';
import type { ProjectDoc } from '../../src/editor/projectTypes.ts';
import type { Storyboard } from '../../production/types.ts';
import { GLOBAL_FLAGS, projectReference } from './common.ts';

const FLAGS = [...GLOBAL_FLAGS, 'storyboard', 'timeline', 'replace', 'apply', 'json',
  'srt', 'captions-template', 'captions-motion', 'no-captions'] as const;

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
  const storyboard = await readStoryboard(resolve(storyboardFlag));

  const { registry, schemas } = await loadRecipeRegistry(resolve('production/recipes'));

  // Captions come from the subtitle file, not the storyboard: the storyboard
  // decides picture, the subtitle file knows what was actually said.
  let captions;
  const srtFlag = flagText(commandLine, 'srt');
  if (srtFlag && !flagBoolean(commandLine, 'no-captions')) {
    const cues = parseSrtCues(await readFile(resolve(srtFlag), 'utf8'));
    if (!cues.length) throw new CliError(`no cues parsed from ${srtFlag}`);
    captions = buildCaptions(cues, {
      ...(flagText(commandLine, 'captions-template')
        ? { template: flagText(commandLine, 'captions-template') as never }
        : {}),
      ...(flagText(commandLine, 'captions-motion')
        ? { motion: flagText(commandLine, 'captions-motion') as never }
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
    const checked = checkParams(schema, visual.params ?? {});
    if (!checked.ok) {
      for (const error of checked.errors) paramErrors.push(`${shot.id}: ${error}`);
    } else {
      visual.params = checked.value;
    }
  }
  if (paramErrors.length) {
    throw new CliError(`storyboard rejected:\n  - ${paramErrors.join('\n  - ')}`);
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
    );
  }

  // Keep every timeline the storyboard does not name; replace or append ours.
  const timelines = existing
    ? current.timelines.map((candidate) => (candidate.id === timeline.id ? timeline : candidate))
    : [...current.timelines, { ...timeline, order: current.timelines.length }];

  const next = { ...current, timelines, activeTimelineId: timeline.id };
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
