// `occ check` — one call, three answers.
//
// A caller that has to remember to run the validator, then QC, then the
// scorecard will run one of them. They answer different questions and the
// difference is the whole point:
//
//   valid     can this become a timeline at all
//   findings  will it look wrong (recipe repeats, gaps, cards echoing captions)
//   score     is this version better than the last one
//
// Keeping them in one payload is also what makes self-review honest: an agent
// cannot quietly skip the check that would have caught its mistake.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { flagBoolean, flagText, rejectUnknownFlags, type CommandLine } from '../args.ts';
import { CliError, UsageError } from '../errors.ts';
import { printJson, writeStdout } from '../output.ts';
import { GLOBAL_FLAGS, parseSize, requireStoryboardLock } from './common.ts';
import { checkStoryboard } from '../../production/generate.ts';
import { formatFindings, runQc } from '../../src/pipeline/qc.ts';
import { loadRecipeRegistry } from '../../production/recipes/load.ts';
import type { Storyboard } from '../../src/pipeline/types.ts';

const FLAGS = [...GLOBAL_FLAGS, 'storyboard', 'json', 'size', 'captions', 'no-captions', 'allow-edited'] as const;

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

/**
 * Run the scorecard in its own process.
 *
 * `production/score.mjs` is the implementation, not a copy of it: it is the
 * script the corpus runner and the README both call, and a second version
 * inside this command would drift the first time a column changed.
 */
function score(path: string): Record<string, unknown> | null {
  try {
    const out = execFileSync(process.execPath, ['production/score.mjs', '--json', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
    });
    const rows = JSON.parse(out) as Array<Record<string, unknown>>;
    return rows[0] ?? null;
  } catch {
    // A scorecard is diagnostic, not a gate: losing it must not fail a check.
    return null;
  }
}

export async function runCheckCommand(commandLine: CommandLine, json: boolean): Promise<void> {
  rejectUnknownFlags(commandLine, FLAGS);

  const storyboardFlag = flagText(commandLine, 'storyboard');
  if (!storyboardFlag?.trim()) throw new UsageError('check needs --storyboard <file.json>');
  const file = resolve(storyboardFlag);

  const lock = requireStoryboardLock(file, flagBoolean(commandLine, 'allow-edited'));
  const storyboard = await readStoryboard(file);
  const { schemas } = await loadRecipeRegistry(resolve('production/recipes'));

  const sizeFlag = flagText(commandLine, 'size');
  const expected = sizeFlag
    ? (() => {
        const [width, height] = parseSize(sizeFlag);
        return { width, height };
      })()
    : undefined;

  const checked = checkStoryboard(storyboard, schemas, expected);
  const captions = !flagBoolean(commandLine, 'no-captions');
  const qc = runQc(storyboard, { schemas, captions });

  const blocking = qc.findings.filter((finding) => finding.severity === 'error');
  const ok = checked.ok && blocking.length === 0;
  const payload = {
    ok,
    valid: checked.ok,
    errors: checked.errors,
    warnings: checked.warnings,
    findings: qc.findings,
    stats: qc.stats,
    score: score(file),
    lock: { state: lock.state, ...(lock.lock?.at ? { at: lock.lock.at } : {}) },
  };

  if (json) {
    printJson(payload);
    // A failed check has to be a failed process: a caller that branches on the
    // exit code is the common case, and a silent 0 reads as "ship it".
    if (!ok) process.exitCode = 1;
    return;
  }

  writeStdout(`${ok ? 'ok' : 'blocked'} · ${qc.stats.shots} shots · ${qc.stats.durationSec}s · `
    + `${qc.stats.distinctRecipes} recipes · footage ${Math.round(qc.stats.footageRatio * 100)}% · lock ${lock.state}`);
  for (const error of checked.errors) writeStdout(`  error: ${error}`);
  for (const line of formatFindings(qc)) writeStdout(`  ${line}`);
  const row = payload.score;
  if (row) {
    writeStdout(`  score: rec ${row.recipes} · anchor ${row.anchors} · dur ${row.meanDuration}/${row.durationSpan}`
      + ` · trans ${row.transitions} · use ${row.usableFootage} · dup ${row.duplicates}`);
  }
  if (!ok) process.exitCode = 1;
}
