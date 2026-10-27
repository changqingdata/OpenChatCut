// `occ transcribe` — word-level speech timing from the local whisper model.
//
// Its output is not a transcript anyone should read: whisper's Chinese comes out
// traditional and mishears homophones. It is a timing profile, and the only
// consumer is the caption builder, which keeps the subtitle's words and takes
// this file's rhythm. Run it once per video and pass the result to
// `occ compile --timing`.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CliError, UsageError } from '../errors.ts';
import { flagText, rejectUnknownFlags, type CommandLine } from '../args.ts';
import { printJson, writeStdout } from '../output.ts';
import {
  installedWhisperModels,
  transcribeAudio,
  whisperBinary,
  type WhisperModelId,
} from '../../production/transcribe.ts';
import { GLOBAL_FLAGS } from './common.ts';

const FLAGS = [...GLOBAL_FLAGS, 'audio', 'model', 'language', 'threads', 'out', 'json', 'text'] as const;

export async function runTranscribeCommand(commandLine: CommandLine, json: boolean): Promise<void> {
  rejectUnknownFlags(commandLine, FLAGS);

  const audioFlag = flagText(commandLine, 'audio');
  if (!audioFlag?.trim()) throw new UsageError('transcribe needs --audio <file>');

  const repoRoot = resolve('.');
  if (!whisperBinary(repoRoot)) {
    throw new CliError('whisper-cli is not available for this platform', {
      code: 'whisper-missing',
      step: 'transcribe',
      cause: `no binary under ${resolve(repoRoot, 'public', 'whisper-cli')}`,
      hint: 'run on a platform the app ships a build for, or set OPENCHATCUT_WHISPER_CLI to one',
    });
  }

  const installed = installedWhisperModels();
  const requested = flagText(commandLine, 'model')?.trim() as WhisperModelId | undefined;
  if (requested && !installed.includes(requested)) {
    throw new CliError(`whisper model "${requested}" is not downloaded`, {
      code: 'model-missing',
      step: 'transcribe',
      cause: installed.length ? `installed: ${installed.join(', ')}` : 'no model is installed',
      hint: 'download one once from Settings → 本地模型, then re-run',
    });
  }

  const threads = Number(flagText(commandLine, 'threads'));
  const result = await transcribeAudio({
    audio: resolve(audioFlag),
    repoRoot,
    ...(requested ? { model: requested } : {}),
    ...(flagText(commandLine, 'language') ? { language: flagText(commandLine, 'language')!.trim() } : {}),
    ...(Number.isFinite(threads) && threads > 0 ? { threads } : {}),
  });

  const outFlag = flagText(commandLine, 'out');
  const timing = {
    model: result.model,
    language: result.language,
    durationMs: result.durationMs,
    tokens: result.tokens,
  };

  if (outFlag?.trim()) {
    const target = resolve(outFlag);
    await writeFile(target, `${JSON.stringify(timing, null, 2)}\n`, 'utf8');
    if (!json) writeStdout(`timing → ${target}`);
  }

  if (json) {
    printJson(timing);
    return;
  }

  writeStdout(
    `${result.tokens.length} tokens · ${(result.durationMs / 1000).toFixed(2)}s · `
    + `${result.model} · ${result.language}`,
  );
  // The text is off by default: it is a byproduct used to sanity-check the
  // timing, not a transcript to publish — whisper's Chinese is traditional and
  // mishears homophones, which is exactly why the pipeline keeps the subtitle.
  if (flagText(commandLine, 'text') !== undefined) {
    for (const segment of result.segments) {
      writeStdout(`  ${(segment.startMs / 1000).toFixed(2)} → ${(segment.endMs / 1000).toFixed(2)}  ${segment.text}`);
    }
  }
}
