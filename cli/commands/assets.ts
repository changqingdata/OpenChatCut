// `occ assets` — find external material and put it on a timeline.
//
// Two verbs, because the two halves fail differently:
//
//   search   reads indexes and APIs; no project needed, safe to run anywhere
//   place    downloads, imports into the pool, and places a clip; needs a project
//
// `place` exists so the orchestration script does not have to reimplement the
// chain. It picks a track by length, downloads it, imports it, then adds the
// clip — four steps that must agree on the same file.
import { CliError, UsageError } from '../errors.ts';
import { flagText, rejectUnknownFlags, type CommandLine } from '../args.ts';
import { printJson, writeStdout } from '../output.ts';
import { basename } from 'node:path';
import { readProjectDoc, resolveProject } from '../store.ts';
import { runToolSession } from '../session.ts';
import { createProviders, searchAll } from '../../production/assets/registry.ts';
import { acquireToFile } from '../../production/assets/acquire.ts';
import { pickMusic } from '../../production/assets/music.ts';
import type { MaterialItem, MaterialRole } from '../../production/assets/types.ts';
import { GLOBAL_FLAGS, projectReference, subLine } from './common.ts';

const ROLES: readonly MaterialRole[] = ['music', 'sound_effect', 'image', 'video', 'gif', 'icon'];

const FLAGS = [...GLOBAL_FLAGS, 'role', 'query', 'category', 'limit', 'json',
  'min-duration', 'volume', 'track', 'from-frame', 'duration-frames'] as const;

function readRole(commandLine: CommandLine): MaterialRole {
  const value = flagText(commandLine, 'role');
  if (!value) throw new UsageError(`--role is required (${ROLES.join(' | ')})`);
  if (!ROLES.includes(value as MaterialRole)) {
    throw new UsageError(`--role must be one of ${ROLES.join(', ')}`);
  }
  return value as MaterialRole;
}

function describe(item: MaterialItem): string {
  const bits = [item.provider, item.providerId];
  if (item.category) bits.push(item.category);
  if (item.durationSec) bits.push(`${Math.round(item.durationSec)}s`);
  if (item.width) bits.push(`${item.width}x${item.height}`);
  return `${bits.join(' · ')} — ${item.label}`;
}

async function searchCommand(commandLine: CommandLine, json: boolean): Promise<void> {
  const role = readRole(commandLine);
  const providers = await createProviders();
  const outcome = await searchAll(providers, {
    role,
    ...(flagText(commandLine, 'query') ? { query: flagText(commandLine, 'query')! } : {}),
    ...(flagText(commandLine, 'category') ? { category: flagText(commandLine, 'category')! } : {}),
    limit: Number(flagText(commandLine, 'limit') ?? 10),
  });

  if (json) {
    printJson(outcome);
    return;
  }
  if (!outcome.items.length) writeStdout('no results');
  for (const item of outcome.items) writeStdout(`  ${describe(item)}`);
  if (outcome.skipped.length) writeStdout(`  skipped (no key): ${outcome.skipped.join(', ')}`);
  for (const failure of outcome.failures) writeStdout(`  failed: ${failure.provider} — ${failure.error}`);
}

async function placeCommand(commandLine: CommandLine, json: boolean): Promise<void> {
  const role = readRole(commandLine);
  const project = await resolveProject(projectReference(commandLine));
  const providers = await createProviders();

  const fromFrame = Number(flagText(commandLine, 'from-frame') ?? 0);
  const durationFlag = flagText(commandLine, 'duration-frames');
  const minDurationSec = Number(flagText(commandLine, 'min-duration') ?? 0);

  let item: MaterialItem | null = null;
  let note = '';

  if (role === 'music') {
    const category = flagText(commandLine, 'category');
    if (!category) throw new UsageError('music needs --category');
    const pick = await pickMusic(providers, {
      category,
      minDurationSec,
      ...(flagText(commandLine, 'query') ? { query: flagText(commandLine, 'query')! } : {}),
    });
    if (!pick) throw new CliError(`no track found in category "${category}"`);
    item = pick.item;
    if (pick.short) note = `the longest track in "${category}" is shorter than the video`;
  } else {
    const outcome = await searchAll(providers, {
      role,
      ...(flagText(commandLine, 'query') ? { query: flagText(commandLine, 'query')! } : {}),
      ...(flagText(commandLine, 'category') ? { category: flagText(commandLine, 'category')! } : {}),
      limit: 1,
    });
    item = outcome.items[0] ?? null;
    if (!item) throw new CliError(`no ${role} result for "${flagText(commandLine, 'query') ?? ''}"`);
  }

  const file = await acquireToFile(item);

  const imported = await runToolSession(project.id, [{
    tool: 'import_asset',
    args: { path: file.path },
  }], { apply: true, summary: `import ${item.provider} ${role}` });

  const importResult = (imported.executions[0]?.result ?? {}) as {
    imported?: Array<{ id: string; name: string }>;
  };
  let assetId = importResult.imported?.[0]?.id;

  // Re-placing the same file imports nothing and reports a duplicate instead of
  // returning an id, so fall back to the pool entry with that filename.
  if (!assetId) {
    const doc = await readProjectDoc(project.id);
    const wanted = basename(file.path);
    const existing = doc.assets.find(
      (asset) => asset.sourceFilename === wanted || asset.name === wanted,
    );
    assetId = existing?.id;
  }
  if (!assetId) throw new CliError(`import did not return an asset id: ${JSON.stringify(importResult).slice(0, 300)}`);

  const track = flagText(commandLine, 'track') ?? (role === 'music' ? 'A2' : 'A1');
  const volume = Number(flagText(commandLine, 'volume') ?? (role === 'music' ? 0.14 : 0.8));

  // `adds` takes no volume — level and fades are update fields, so the clip has
  // to exist before it can be set. One extra commit is the cost of that split.
  const placed = await runToolSession(project.id, [{
    tool: 'edit_item',
    args: {
      adds: [{
        type: 'audio',
        assetId,
        track,
        fromFrame,
        ...(durationFlag ? { durationInFrames: Number(durationFlag) } : {}),
      }],
    },
  }], { apply: true, summary: `place ${role} on ${track}` });

  const placedResult = (placed.executions[0]?.result ?? {}) as {
    results?: Array<{ placed?: { itemId: string; durationInFrames: number } }>;
  };
  const clip = placedResult.results?.[0]?.placed;

  if (clip?.itemId && (volume !== 1 || role === 'music')) {
    await runToolSession(project.id, [{
      tool: 'edit_item',
      args: {
        updates: [{
          type: 'audio',
          itemId: clip.itemId,
          volume,
          // A hard start under a voice is jarring; a short ramp fixes it.
          fadeInSeconds: role === 'music' ? 0.8 : 0,
          fadeOutSeconds: role === 'music' ? 1.2 : 0,
        }],
      },
    }], { apply: true, summary: `set ${role} level` });
  }

  const summary = {
    projectId: project.id,
    role,
    provider: item.provider,
    label: item.label,
    category: item.category,
    track,
    assetId,
    itemId: clip?.itemId,
    durationInFrames: clip?.durationInFrames,
    downloadedBytes: file.bytes,
    note,
  };
  if (json) printJson(summary);
  else {
    writeStdout(`placed ${describe(item)} on ${track} (${clip?.durationInFrames ?? '?'} frames)`);
    if (note) writeStdout(`  note: ${note}`);
  }
}

export async function runAssetsCommand(commandLine: CommandLine, json: boolean): Promise<void> {
  const action = commandLine.positionals[0];
  const rest = subLine(commandLine, commandLine.positionals.slice(1));
  rejectUnknownFlags(rest, FLAGS);

  if (action === 'search') return searchCommand(rest, json);
  if (action === 'place') return placeCommand(rest, json);
  throw new UsageError('usage: occ assets <search|place> --role <role> …');
}
