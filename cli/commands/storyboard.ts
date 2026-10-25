// `occ storyboard` — turn subtitles into a Storyboard JSON.
//
// Three modes, so the command is useful with or without an API key:
//
//   --prompt            print the prompt for a human or another agent to answer
//   --from <file>       validate a reply and write the storyboard
//   --generate          call the configured LLM, retrying once with the errors
//
// Every mode runs the same validation, so a hand-filled reply and a generated
// one are held to the same bar.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { CliError, UsageError } from '../errors.ts';
import { flagBoolean, flagText, rejectUnknownFlags, type CommandLine } from '../args.ts';
import { printJson, writeStdout } from '../output.ts';
import { loadRecipeRegistry } from '../../production/recipes/load.ts';
import { buildStoryboardPrompt, checkStoryboard, extractJson, repairPrompt } from '../../production/generate.ts';
import { completeText, readLlmConfig } from '../../production/llm.ts';
import { parseSrtCues } from '../../production/srt.ts';
import { GLOBAL_FLAGS } from './common.ts';

const FLAGS = [...GLOBAL_FLAGS, 'srt', 'brief', 'out', 'prompt', 'from', 'generate', 'size', 'fps', 'json'] as const;

async function readText(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new CliError(`cannot read ${label}: ${path}`);
  }
}

export async function runStoryboardCommand(commandLine: CommandLine, json: boolean): Promise<void> {
  rejectUnknownFlags(commandLine, FLAGS);

  const srtFlag = flagText(commandLine, 'srt');
  const briefFlag = flagText(commandLine, 'brief');
  const outFlag = flagText(commandLine, 'out');
  if (!srtFlag?.trim()) throw new UsageError('storyboard needs --srt <file.srt>');
  if (!briefFlag?.trim()) throw new UsageError('storyboard needs --brief "<one line about the video>"');

  const sizeFlag = flagText(commandLine, 'size') ?? '1080x1920';
  const sizeMatch = sizeFlag.match(/^(\d+)x(\d+)$/);
  if (!sizeMatch) throw new UsageError('--size expects WIDTHxHEIGHT, e.g. 1080x1920');
  const width = Number(sizeMatch[1]);
  const height = Number(sizeMatch[2]);
  const fps = Number(flagText(commandLine, 'fps') ?? 30);
  if (!(fps > 0)) throw new UsageError('--fps must be positive');

  const cues = parseSrtCues(await readText(resolve(srtFlag), 'subtitle file'));
  if (!cues.length) throw new CliError(`no cues parsed from ${srtFlag}`);

  const { schemas } = await loadRecipeRegistry(resolve('production/recipes'));
  if (!schemas.size) throw new CliError('no recipes found under production/recipes');

  const prompt = buildStoryboardPrompt({
    cues,
    brief: briefFlag,
    width,
    height,
    fps,
    aspect: width === height ? '1:1' : width > height ? '16:9' : '9:16',
    language: /[\u4e00-\u9fa5]/.test(cues.map((cue) => cue.text).join('')) ? 'zh' : 'en',
    catalog: schemas,
  });

  // Mode 1: emit the prompt. Works with no key at all.
  if (flagBoolean(commandLine, 'prompt')) {
    const text = `### SYSTEM\n${prompt.system}\n\n### USER\n${prompt.user}`;
    if (json) printJson({ cues: cues.length, system: prompt.system, user: prompt.user });
    else writeStdout(text);
    return;
  }

  const outPath = resolve(outFlag ?? `production/work/storyboard-${Date.now()}.json`);

  // Mode 2: validate a reply produced elsewhere.
  const fromFlag = flagText(commandLine, 'from');
  if (fromFlag) {
    const raw = await readText(resolve(fromFlag), 'response file');
    let candidate: unknown;
    try {
      candidate = extractJson(raw);
    } catch (error) {
      throw new CliError(`could not parse JSON from ${fromFlag}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const checked = checkStoryboard(candidate, schemas);
    if (!checked.ok) {
      throw new CliError(`storyboard rejected:\n  - ${checked.errors.join('\n  - ')}`);
    }
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(checked.storyboard, null, 2)}\n`, 'utf8');
    const summary = { out: outPath, shots: checked.storyboard!.shots.length, warnings: checked.warnings };
    if (json) printJson(summary);
    else {
      writeStdout(`storyboard → ${outPath} (${summary.shots} shots)`);
      for (const warning of checked.warnings) writeStdout(`  warning: ${warning}`);
    }
    return;
  }

  // Mode 3: call the model. Retry once, feeding the validation errors back.
  if (!flagBoolean(commandLine, 'generate')) {
    throw new UsageError('pass one of --prompt, --from <file>, or --generate');
  }
  const config = await readLlmConfig();
  if (!config) {
    throw new CliError(
      'no LLM key configured. Set LLM_<PROVIDER>_API_KEY and LLM_<PROVIDER>_MODEL in .env.local,\n'
      + 'or run with --prompt and answer it yourself, then --from <file>.',
    );
  }

  let reply = await completeText(config, { system: prompt.system, user: prompt.user });
  let checked = checkStoryboard(safeExtract(reply), schemas);
  if (!checked.ok) {
    reply = await completeText(config, {
      system: prompt.system,
      user: `${prompt.user}\n\n${repairPrompt(checked.errors)}`,
    });
    checked = checkStoryboard(safeExtract(reply), schemas);
  }
  if (!checked.ok) {
    throw new CliError(`model output failed validation after one retry:\n  - ${checked.errors.join('\n  - ')}`);
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(checked.storyboard, null, 2)}\n`, 'utf8');
  const summary = {
    out: outPath,
    model: config.model,
    shots: checked.storyboard!.shots.length,
    warnings: checked.warnings,
  };
  if (json) printJson(summary);
  else {
    writeStdout(`storyboard → ${outPath} (${summary.shots} shots, ${config.model})`);
    for (const warning of summary.warnings) writeStdout(`  warning: ${warning}`);
  }
}

/** JSON that fails to parse is a validation failure, not a crash. */
function safeExtract(text: string): unknown {
  try {
    return extractJson(text);
  } catch {
    return null;
  }
}
