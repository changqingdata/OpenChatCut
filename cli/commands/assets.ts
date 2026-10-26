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
import { flagBoolean, flagText, rejectUnknownFlags, type CommandLine } from '../args.ts';
import { printJson, writeStdout } from '../output.ts';
import { basename } from 'node:path';
import { readProjectDoc, resolveProject } from '../store.ts';
import { resolveTrackId } from '../../src/editor/timelineTypes.ts';
import { runToolSession } from '../session.ts';
import { createProviders, searchAll } from '../../production/assets/registry.ts';
import { acquireToFile } from '../../production/assets/acquire.ts';
import { pickMusic, pickMusicBed } from '../../production/assets/music.ts';
import type { MaterialItem, MaterialRole } from '../../production/assets/types.ts';
import { GLOBAL_FLAGS, projectReference, subLine } from './common.ts';

const ROLES: readonly MaterialRole[] = ['music', 'sound_effect', 'image', 'video', 'gif', 'icon'];

const FLAGS = [...GLOBAL_FLAGS, 'role', 'query', 'category', 'limit', 'json',
  'min-duration', 'volume', 'track', 'from-frame', 'duration-frames', 'loop'] as const;

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

  const loop = flagBoolean(commandLine, 'loop');
  const doc = await readProjectDoc(project.id);
  const fps = doc.timelines.find((t) => t.id === doc.activeTimelineId)?.fps ?? 30;

  let picks: MaterialItem[] = [];
  let note = '';

  if (role === 'music') {
    const category = flagText(commandLine, 'category');
    if (!category) throw new UsageError('music needs --category');
    const query = flagText(commandLine, 'query');

    // A long cut cannot be scored by one song: the library is a set of tracks,
    // not loops, and the longest is around 145s. `--loop` walks the same mood and
    // chains tracks end to end, so no single loop point repeats.
    if (loop && durationFlag) {
      const bed = await pickMusicBed(providers, {
        category,
        durationSec: Number(durationFlag) / fps,
        ...(query ? { query } : {}),
      });
      if (!bed) throw new CliError(`no track found in category "${category}"`);
      picks = bed.items;
      note = bed.short
        ? `every track in "${category}" together covers ${Math.round(bed.coveredSec)}s of ${Math.round(Number(durationFlag) / fps)}s`
        : `${picks.length} track(s) from "${category}" cover the cut`;
    } else {
      const pick = await pickMusic(providers, {
        category,
        minDurationSec,
        ...(query ? { query } : {}),
      });
      if (!pick) throw new CliError(`no track found in category "${category}"`);
      picks = [pick.item];
      if (pick.short) note = `the longest track in "${category}" is shorter than the video`;
    }
  } else {
    const outcome = await searchAll(providers, {
      role,
      ...(flagText(commandLine, 'query') ? { query: flagText(commandLine, 'query')! } : {}),
      ...(flagText(commandLine, 'category') ? { category: flagText(commandLine, 'category')! } : {}),
      limit: 1,
    });
    const item = outcome.items[0];
    if (!item) throw new CliError(`no ${role} result for "${flagText(commandLine, 'query') ?? ''}"`);
    picks = [item];
  }

  /** Import one downloaded file and return its pool id. */
  async function importFile(item: MaterialItem, path: string): Promise<string> {
    const imported = await runToolSession(project.id, [{
      tool: 'import_asset',
      args: { path },
    }], { apply: true, summary: `import ${item.provider} ${role}` });

    const result = (imported.executions[0]?.result ?? {}) as { imported?: Array<{ id: string }> };
    const id = result.imported?.[0]?.id;
    if (id) return id;

    // Re-placing the same file imports nothing and reports a duplicate instead of
    // returning an id, so fall back to the pool entry with that filename.
    const pool = await readProjectDoc(project.id);
    const wanted = basename(path);
    const existing = pool.assets.find(
      (asset) => asset.sourceFilename === wanted || asset.name === wanted,
    );
    if (!existing) throw new CliError(`import did not return an asset id: ${JSON.stringify(result).slice(0, 300)}`);
    return existing.id;
  }

  // Chain the tracks end to end. A single track keeps the old behaviour exactly:
  // one placement, at `--from-frame`, optionally cut to `--duration-frames`.
  const limit = durationFlag ? Number(durationFlag) : undefined;
  const placements: Array<{ assetId: string; fromFrame: number; durationInFrames?: number }> = [];
  let cursor = fromFrame;
  let downloadedBytes = 0;

  for (const item of picks) {
    const file = await acquireToFile(item);
    downloadedBytes += file.bytes;
    const assetId = await importFile(item, file.path);

    const pool = await readProjectDoc(project.id);
    const natural = pool.assets.find((asset) => asset.id === assetId)?.durationInFrames
      ?? Math.round((item.durationSec ?? 0) * fps);

    if (limit === undefined) {
      placements.push({ assetId, fromFrame: cursor });
      cursor += natural;
      continue;
    }

    const remaining = limit - (cursor - fromFrame);
    if (remaining <= 0) break;
    placements.push({ assetId, fromFrame: cursor, durationInFrames: Math.min(natural, remaining) });
    cursor += Math.min(natural, remaining);
  }

  if (!placements.length) throw new CliError('nothing to place');

  let track = flagText(commandLine, 'track') ?? (role === 'music' ? 'A2' : 'A1');

  // `edit_item` resolves an alias only against tracks that already exist, and
  // silently falls back to the default audio track when it does not — a third
  // audio track for sound effects therefore has to be created before use, or
  // every effect lands on the voiceover and gets pushed past the end.
  {
    const doc = await readProjectDoc(project.id);
    const timeline = doc.timelines.find((candidate) => candidate.id === doc.activeTimelineId);
    const kind = /^V/i.test(track) ? 'video' as const : 'audio' as const;
    if (timeline && !resolveTrackId(timeline, track, kind)) {
      const created = await runToolSession(project.id, [{
        tool: 'edit_track',
        args: { action: 'create', json: JSON.stringify({ trackType: kind, name: track }) },
      }], { apply: true, summary: `create ${track}` });
      const made = (created.executions[0]?.result ?? {}) as {
        created?: Array<{ id: string; alias: string }>;
      };
      const newTrack = made.created?.[0];
      if (newTrack?.id) {
        console.log(`created track ${newTrack.alias} (${newTrack.id})`);
        track = newTrack.id;
      }
    }
  }
  const volume = Number(flagText(commandLine, 'volume') ?? (role === 'music' ? 0.14 : 0.8));

  // `adds` takes no volume — level and fades are update fields, so the clip has
  // to exist before it can be set. One extra commit is the cost of that split.
  const placed = await runToolSession(project.id, [{
    tool: 'edit_item',
    args: {
      adds: placements.map((placement) => ({
        type: 'audio' as const,
        assetId: placement.assetId,
        track,
        fromFrame: placement.fromFrame,
        ...(placement.durationInFrames !== undefined ? { durationInFrames: placement.durationInFrames } : {}),
      })),
    },
  }], { apply: true, summary: `place ${role} on ${track}` });

  const placedResult = (placed.executions[0]?.result ?? {}) as {
    results?: Array<{ placed?: { itemId: string; durationInFrames: number } }>;
  };
  const clips = (placedResult.results ?? []).map((entry) => entry.placed).filter(Boolean) as Array<{ itemId: string; durationInFrames: number }>;
  const clip = clips[0];

  if (clips.length && (volume !== 1 || role === 'music')) {
    await runToolSession(project.id, [{
      tool: 'edit_item',
      args: {
        updates: clips.map((entry, index) => ({
          type: 'audio' as const,
          itemId: entry.itemId,
          volume,
          // A hard start under a voice is jarring; a short ramp fixes it. Only the
          // first track fades in and only the last fades out — fading every join
          // would pump the bed once per track.
          fadeInSeconds: role === 'music' && index === 0 ? 0.8 : 0,
          fadeOutSeconds: role === 'music' && index === clips.length - 1 ? 1.2 : 0,
        })),
      },
    }], { apply: true, summary: `set ${role} level` });
  }

  const summary = {
    projectId: project.id,
    role,
    track,
    clips: clips.length,
    itemIds: clips.map((entry) => entry.itemId),
    durationInFrames: clips.reduce((total, entry) => total + entry.durationInFrames, 0),
    downloadedBytes,
    note,
  };
  if (json) printJson(summary);
  else {
    for (const [index, item] of picks.entries()) {
      if (index >= clips.length) break;
      writeStdout(`placed ${describe(item)} on ${track} (${clips[index]!.durationInFrames} frames)`);
    }
    if (clips.length > 1) writeStdout(`  ${clips.length} tracks chained, ${summary.durationInFrames} frames total`);
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
