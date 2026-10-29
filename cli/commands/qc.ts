// `occ qc` — check a storyboard before it reaches a project.
//
// Separate from `occ compile` because the two answer different questions:
// compile asks "can this become a timeline", QC asks "will it look wrong". A
// storyboard can compile perfectly and still be a stutter with one recipe on half
// the shots.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CliError, UsageError } from '../errors.ts';
import { flagBoolean, flagText, rejectUnknownFlags, type CommandLine } from '../args.ts';
import { printJson, writeStdout } from '../output.ts';
import { loadRecipeRegistry } from '../../production/recipes/load.ts';
import { formatFindings, runQc } from '../../production/qc.ts';
import type { Storyboard } from '../../production/types.ts';
import { GLOBAL_FLAGS, requireStoryboardLock } from './common.ts';

const FLAGS = [...GLOBAL_FLAGS, 'storyboard', 'json', 'strict', 'captions', 'no-captions', 'report-only', 'allow-edited'] as const;

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

export async function runQcCommand(commandLine: CommandLine, json: boolean): Promise<void> {
  rejectUnknownFlags(commandLine, FLAGS);

  const storyboardFlag = flagText(commandLine, 'storyboard');
  if (!storyboardFlag?.trim()) throw new UsageError('qc needs --storyboard <file.json>');

  const storyboardFile = resolve(storyboardFlag);
  requireStoryboardLock(storyboardFile, flagBoolean(commandLine, 'allow-edited'));
  const storyboard = await readStoryboard(storyboardFile);
  const { schemas } = await loadRecipeRegistry(resolve('production/recipes'));

  // Captions are on by default here: the pipeline burns them in unless asked not
  // to, and a bottom anchor collides with them. Checking without that knowledge
  // would report a clean board that renders badly.
  const captions = flagBoolean(commandLine, 'no-captions') ? false : true;

  const report = runQc(storyboard, { schemas, captions });
  const strict = flagBoolean(commandLine, 'strict');
  const warnings = report.findings.filter((finding) => finding.severity === 'warn').length;

  if (json) {
    printJson(report);
  } else {
    const { stats } = report;
    writeStdout(
      `${stats.shots} shots · ${stats.durationSec}s · avg ${stats.avgShotSec}s · `
      + `${stats.footageShots} with footage (${Math.round(stats.footageRatio * 100)}%) · `
      + `${stats.distinctRecipes} recipes`,
    );
    const lines = formatFindings(report);
    if (!lines.length) writeStdout('  clean');
    for (const line of lines) writeStdout(`  ${line}`);
  }

  // `--report-only` lets a caller decide what to do with a failure. The
  // orchestrator prints the findings first and then exits itself, which reads
  // better than a thrown error with the report buried in its message.
  if (flagBoolean(commandLine, 'report-only')) return;

  if (!report.ok) {
    const errors = report.findings.filter((finding) => finding.severity === 'error');
    throw new CliError('qc found blocking problems', {
      code: 'qc-blocking',
      step: 'qc',
      cause: errors.map((finding) => finding.message).join('; '),
      hint: 'fix the storyboard, or run without --strict to see warnings only',
    });
  }
  if (strict && warnings) {
    throw new CliError(`qc found ${warnings} warning(s) and --strict was passed`, {
      code: 'qc-warnings',
      step: 'qc',
      hint: 'drop --strict, or fix the warnings',
    });
  }
}
