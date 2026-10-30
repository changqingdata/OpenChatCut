// `occ revise` — the sanctioned way to edit a storyboard.
//
// The lock exists because a hand-edited storyboard skips the validator, and the
// timeline it produces has no validator of its own. That rule is right; the old
// answer to it was "do not edit", which is wrong for a director. `revise` is the
// third option: apply the edit, validate the result, re-lock, and refuse to
// write anything that would not compile.
//
// Cut points come from `startFrame` alone. Every shot's `endFrame` is set to the
// next shot's `startFrame` (and the last one to the total), which makes a frame
// gap impossible by construction rather than by a rule someone has to remember.
//
//   occ revise sb.json --ops ops.json
//   occ revise sb.json --replace-with new.json
//
// Ops, applied in order:
//   { "op": "set",    "shot": "S05", "path": "visual.params.text", "value": "时间" }
//   { "op": "recipe", "shot": "S05", "recipe": "quote-card", "params": { … } }
//   { "op": "layout", "shot": "S05", "anchor": "tc", "widthRatio": 0.9 }
//   { "op": "retime", "shot": "S05", "startFrame": 369 }
//   { "op": "remove", "shot": "S05" }
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { flagText, rejectUnknownFlags, type CommandLine } from '../args.ts';
import { CliError, UsageError } from '../errors.ts';
import { printJson, writeStdout } from '../output.ts';
import { GLOBAL_FLAGS, requireStoryboardLock } from './common.ts';
import { checkStoryboard } from '../../production/generate.ts';
import { formatFindings, runQc } from '../../src/pipeline/qc.ts';
import { loadRecipeRegistry } from '../../production/recipes/load.ts';
import { writeLock } from '../../production/storyboard-lock.ts';
import type { Shot, Storyboard } from '../../src/pipeline/types.ts';

const FLAGS = [...GLOBAL_FLAGS, 'ops', 'replace-with', 'json', 'allow-edited'] as const;

interface Op {
  op: 'set' | 'recipe' | 'layout' | 'retime' | 'remove';
  shot: string;
  path?: string;
  value?: unknown;
  recipe?: string;
  params?: Record<string, unknown>;
  anchor?: string;
  widthRatio?: number;
  startFrame?: number;
}

async function readJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    throw new CliError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter(Boolean);
  if (!parts.length) throw new UsageError('set needs a path, e.g. visual.params.text');
  let cursor: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      // Creating the branch is friendlier than failing: "set visual.layout.anchor"
      // on a shot with no layout should work, not ask the caller to add one first.
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

function findShot(storyboard: Storyboard, id: string): Shot {
  const shot = (storyboard.shots ?? []).find((candidate) => candidate.id === id);
  if (!shot) {
    throw new CliError(`no shot "${id}" in this storyboard`, {
      code: 'unknown-shot',
      step: 'revise',
      hint: `have: ${(storyboard.shots ?? []).map((candidate) => candidate.id).join(', ')}`,
    });
  }
  return shot;
}

/**
 * Cut points are `startFrame`. Re-derive every `endFrame` from the next shot so
 * coverage is total by construction.
 */
function normalizeCoverage(storyboard: Storyboard): void {
  const shots = [...(storyboard.shots ?? [])].sort((a, b) => a.startFrame - b.startFrame);
  if (!shots.length) return;
  const total = Math.max(...shots.map((shot) => shot.endFrame));
  for (const [index, shot] of shots.entries()) {
    const next = shots[index + 1];
    shot.endFrame = next ? next.startFrame : total;
  }
  storyboard.shots = shots;
}

export async function runReviseCommand(commandLine: CommandLine, json: boolean): Promise<void> {
  rejectUnknownFlags(commandLine, FLAGS);

  const storyboardFlag = commandLine.positionals[0] ?? flagText(commandLine, 'storyboard');
  if (!storyboardFlag?.trim()) throw new UsageError('revise needs a storyboard path');
  const file = resolve(storyboardFlag);

  const opsFlag = flagText(commandLine, 'ops');
  const replaceFlag = flagText(commandLine, 'replace-with');
  if (!opsFlag && !replaceFlag) throw new UsageError('revise needs --ops <ops.json> or --replace-with <storyboard.json>');
  if (opsFlag && replaceFlag) throw new UsageError('--ops and --replace-with are alternatives');

  // An edited file is exactly what this command is for, so a stale lock is
  // expected here — the point is that the result gets validated and re-locked.
  requireStoryboardLock(file, true);

  const storyboard = replaceFlag
    ? await readJson<Storyboard>(resolve(replaceFlag))
    : await readJson<Storyboard>(file);

  const applied: string[] = [];
  if (opsFlag) {
    const ops = await readJson<Op[]>(resolve(opsFlag));
    if (!Array.isArray(ops)) throw new CliError('--ops expects a JSON array');
    for (const op of ops) {
      if (op.op === 'remove') {
        const before = (storyboard.shots ?? []).length;
        storyboard.shots = (storyboard.shots ?? []).filter((shot) => shot.id !== op.shot);
        if (storyboard.shots.length === before) findShot(storyboard, op.shot);
        applied.push(`remove ${op.shot}`);
        continue;
      }
      const shot = findShot(storyboard, op.shot);
      if (op.op === 'set') {
        setPath(shot as unknown as Record<string, unknown>, op.path ?? '', op.value);
        applied.push(`set ${op.shot}.${op.path}`);
      } else if (op.op === 'recipe') {
        if (!op.recipe) throw new UsageError('recipe op needs "recipe"');
        shot.visual = {
          kind: 'mg',
          recipe: op.recipe,
          params: op.params ?? {},
          layout: (shot.visual && 'layout' in shot.visual ? shot.visual.layout : { anchor: 'mc', widthRatio: 0.9 }),
        } as Shot['visual'];
        applied.push(`recipe ${op.shot} → ${op.recipe}`);
      } else if (op.op === 'layout') {
        if (shot.visual && 'layout' in shot.visual) {
          if (op.anchor) shot.visual.layout.anchor = op.anchor as never;
          if (op.widthRatio !== undefined) shot.visual.layout.widthRatio = op.widthRatio;
        } else {
          shot.visual = { kind: 'solid', color: '#0B0B0C', layout: { anchor: (op.anchor ?? 'mc') as never, widthRatio: op.widthRatio ?? 0.9 } } as Shot['visual'];
        }
        applied.push(`layout ${op.shot} → ${op.anchor ?? ''} ${op.widthRatio ?? ''}`.trim());
      } else if (op.op === 'retime') {
        if (op.startFrame === undefined) throw new UsageError('retime op needs "startFrame"');
        shot.startFrame = op.startFrame;
        applied.push(`retime ${op.shot} → ${op.startFrame}`);
      } else {
        throw new UsageError(`unknown op "${(op as { op: string }).op}"`);
      }
    }
    normalizeCoverage(storyboard);
  }

  const { schemas } = await loadRecipeRegistry(resolve('production/recipes'));
  const checked = checkStoryboard(storyboard, schemas);
  const qc = runQc(storyboard, { schemas, captions: true });

  // QC's `error` findings are "the video is broken", not "the video is ugly" —
  // a frame gap renders as black. Structural validation alone does not catch a
  // leading gap (removing the first shot leaves frames 0..n empty and every
  // remaining shot still contiguous), so both gates have to pass before anything
  // is written.
  const blocking = qc.findings.filter((finding) => finding.severity === 'error');
  if (!checked.ok || blocking.length) {
    // Nothing is written. A revise that half-applies is worse than one that
    // refuses: the next reader cannot tell which ops landed.
    const errors = [...checked.errors, ...blocking.map((finding) => finding.message)];
    const payload = { ok: false, written: false, applied, errors, findings: qc.findings };
    if (json) {
      printJson(payload);
      process.exitCode = 1;
      return;
    }
    writeStdout(`rejected — nothing written (${errors.length} error(s))`);
    for (const error of errors) writeStdout(`  error: ${error}`);
    process.exitCode = 1;
    return;
  }

  await writeFile(file, `${JSON.stringify(storyboard, null, 2)}\n`, 'utf8');
  const lock = writeLock(file, { action: 'revise' });

  const payload = {
    ok: true,
    written: true,
    applied,
    lock: { state: 'match', hash: lock.hash.slice(0, 12) },
    findings: qc.findings,
    stats: qc.stats,
  };
  if (json) {
    printJson(payload);
    return;
  }
  writeStdout(`revised ${file} (${applied.length} op(s), ${qc.stats.shots} shots)`);
  for (const line of formatFindings(qc)) writeStdout(`  ${line}`);
}
