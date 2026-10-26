// `occ footage resolve` — turn every footage query into a real pool asset.
//
// The model writes "office worker typing at a laptop", not a provider id: it
// cannot see the footage, so naming a specific clip would be a guess. This
// command does the part that needs the network and the filesystem — search,
// download, import — and writes the resulting `assetId` back into the
// storyboard. Compile then stays pure.
//
// Kept out of `compile` on purpose: compiling a storyboard should never touch
// the network, and re-rendering a resolved storyboard must not re-download
// anything.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { CliError, UsageError } from '../errors.ts';
import { flagText, rejectUnknownFlags, type CommandLine } from '../args.ts';
import { printJson, writeStdout } from '../output.ts';
import { readProjectDoc, resolveProject } from '../store.ts';
import { runToolSession } from '../session.ts';
import { createProviders } from '../../production/assets/registry.ts';
import { acquireToFile } from '../../production/assets/acquire.ts';
import { chooseInFrame, findFootage } from '../../production/assets/footage.ts';
import { materializeUpload } from '../../production/assets/materialize.ts';
import { uploadDir } from '../../server/media-dir.ts';
import type { Storyboard } from '../../production/types.ts';
import { GLOBAL_FLAGS, projectReference, subLine } from './common.ts';

const FLAGS = [...GLOBAL_FLAGS, 'storyboard', 'out', 'json', 'max-clips', 'dry-run'] as const;

interface Attribution {
  shotId: string;
  provider: string;
  providerId: string;
  label: string;
  author?: string;
  sourceUrl?: string;
  licenseName?: string;
  licenseUrl?: string;
}

async function readStoryboard(path: string): Promise<Storyboard> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new CliError(`cannot read storyboard: ${path}`);
  }
  try {
    return JSON.parse(raw) as Storyboard;
  } catch (error) {
    throw new CliError(`storyboard is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function runFootageCommand(commandLine: CommandLine, json: boolean): Promise<void> {
  const action = commandLine.positionals[0];
  if (action !== 'resolve') {
    throw new UsageError('usage: occ footage resolve <project> --storyboard <file.json> --out <file.json>');
  }

  // Drop the verb before anything reads positionals[0] as the project.
  const rest = subLine(commandLine, commandLine.positionals.slice(1));
  rejectUnknownFlags(rest, FLAGS);

  const storyboardFlag = flagText(rest, 'storyboard');
  if (!storyboardFlag?.trim()) throw new UsageError('footage resolve needs --storyboard <file.json>');
  const outFlag = flagText(rest, 'out') ?? storyboardFlag;
  const dryRun = rest.flags.has('dry-run');
  const maxClips = Number(flagText(rest, 'max-clips') ?? 0);

  const project = await resolveProject(projectReference(rest));
  const storyboard = await readStoryboard(resolve(storyboardFlag));
  const providers = await createProviders();
  const fps = storyboard.meta?.fps || 30;
  // Orientation comes from the canvas, not from a hardcoded vertical default:
  // a 16:9 film filled with vertical clips would letterbox every shot.
  const canvasW = storyboard.meta?.width ?? 1080;
  const canvasH = storyboard.meta?.height ?? 1920;
  const aspect: '9:16' | '16:9' | '1:1' =
    canvasW === canvasH ? '1:1' : canvasW > canvasH ? '16:9' : '9:16';

  // Assets live inside a project, so an id from another project's pool is
  // dangling here. Reusing a storyboard across projects must re-import, not
  // inherit ids that the target pool has never heard of.
  const poolIds = new Set((await readProjectDoc(project.id)).assets.map((asset) => asset.id));

  const resolved: Attribution[] = [];
  const misses: string[] = [];
  const short: string[] = [];
  let imported = 0;

  const shots = [...(storyboard.shots ?? [])].sort((a, b) => a.startFrame - b.startFrame);

  for (const shot of shots) {
    const underlay = shot.underlay;
    if (!underlay?.query?.trim()) continue;
    if (underlay.assetId?.trim() && poolIds.has(underlay.assetId)) continue;
    // The density policy turned this shot down; downloading it would be waste.
    if (underlay.selected === false) continue;
    if (maxClips > 0 && imported >= maxClips) break;

    const neededFrames = shot.endFrame - shot.startFrame;
    const pick = await findFootage(providers, {
      query: underlay.query,
      neededFrames,
      fps,
      aspect,
      ...(underlay.kind ? { kind: underlay.kind } : {}),
    });

    if (!pick) {
      misses.push(`${shot.id}: no footage for "${underlay.query}"`);
      continue;
    }

    if (dryRun) {
      resolved.push({
        shotId: shot.id,
        provider: pick.item.provider,
        providerId: pick.item.providerId,
        label: pick.item.label,
        ...(pick.item.author ? { author: pick.item.author } : {}),
        ...(pick.item.sourceUrl ? { sourceUrl: pick.item.sourceUrl } : {}),
        ...(pick.item.licenseName ? { licenseName: pick.item.licenseName } : {}),
        ...(pick.item.licenseUrl ? { licenseUrl: pick.item.licenseUrl } : {}),
      });
      imported += 1;
      continue;
    }

    const file = await acquireToFile(pick.item);
    const importedRun = await runToolSession(project.id, [{
      tool: 'import_asset',
      args: { path: file.path },
    }], { apply: true, summary: `import footage for ${shot.id}` });

    const importResult = (importedRun.executions[0]?.result ?? {}) as {
      imported?: Array<{ id: string }>;
    };
    let assetId = importResult.imported?.[0]?.id;

    // Re-resolving the same query imports nothing and reports a duplicate
    // instead of an id, so fall back to the pool entry with that filename.
    if (!assetId) {
      const doc = await readProjectDoc(project.id);
      const wanted = basename(file.path);
      assetId = doc.assets.find(
        (asset) => asset.sourceFilename === wanted || asset.name === wanted,
      )?.id;
    }
    if (!assetId) {
      misses.push(`${shot.id}: imported but no asset id came back`);
      continue;
    }

    // The renderer serves video from the static bundle, which cannot read a
    // `.references` pointer. Give it a real file under the stored name.
    const poolDoc = await readProjectDoc(project.id);
    const stored = poolDoc.assets.find((asset) => asset.id === assetId)?.src ?? '';
    const storedName = stored.split('/').pop();
    if (storedName) await materializeUpload(uploadDir(), storedName, file.path);

    underlay.assetId = assetId;
    underlay.kind = pick.item.role === 'image' ? 'image' : 'video';
    const inFrame = chooseInFrame(pick.item, neededFrames, fps);
    if (inFrame > 0) underlay.srcInFrame = inFrame;

    if (pick.short) short.push(`${shot.id}: ${pick.item.label} is ${Math.round(pick.item.durationSec ?? 0)}s, shot needs ${(neededFrames / fps).toFixed(1)}s`);

    resolved.push({
      shotId: shot.id,
      provider: pick.item.provider,
      providerId: pick.item.providerId,
      label: pick.item.label,
      ...(pick.item.author ? { author: pick.item.author } : {}),
      ...(pick.item.sourceUrl ? { sourceUrl: pick.item.sourceUrl } : {}),
      ...(pick.item.licenseName ? { licenseName: pick.item.licenseName } : {}),
      ...(pick.item.licenseUrl ? { licenseUrl: pick.item.licenseUrl } : {}),
    });
    imported += 1;
  }

  const outPath = resolve(outFlag);
  if (!dryRun) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(storyboard, null, 2)}\n`, 'utf8');
    // Attribution travels beside the storyboard rather than inside it: it is a
    // publishing obligation, not a directing decision, and compile never reads it.
    await writeFile(
      outPath.replace(/\.json$/i, '') + '.attributions.json',
      `${JSON.stringify(resolved, null, 2)}\n`,
      'utf8',
    );
  }

  const summary = {
    out: outPath,
    resolved: resolved.length,
    imported,
    misses,
    short,
    dryRun,
    attributions: resolved,
  };

  if (json) {
    printJson(summary);
    return;
  }

  writeStdout(`${dryRun ? 'would resolve' : 'resolved'} ${resolved.length} shot(s) → ${outPath}`);
  for (const entry of resolved) {
    writeStdout(`  ${entry.shotId} ← ${entry.provider}/${entry.providerId} ${entry.label}${entry.author ? ` (${entry.author})` : ''}`);
  }
  for (const miss of misses) writeStdout(`  miss: ${miss}`);
  for (const note of short) writeStdout(`  short: ${note}`);
  if (dryRun) writeStdout('dry run — nothing downloaded or imported');
}
