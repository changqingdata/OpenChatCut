// Word-level speech timing from the app's own local ASR (whisper.cpp).
//
// Why this exists: `captions.ts` has to place one highlight per character, and
// a subtitle only gives cue-level timings. Spreading a cue's duration across its
// characters by length is an approximation that shows whenever a line is long
// and unevenly paced — a fast clause followed by a pause gets the pause spread
// evenly through the fast part.
//
// The local model fixes exactly that and nothing else. It is NOT used for the
// text: whisper's Chinese output is traditional and mishears homophones
// (复利 → 復律), which is worse than the subtitle the author already has. So the
// subtitle keeps the words, the model supplies the rhythm, and the two are
// combined per cue — no character-to-token alignment, no risk of wrong text.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ggmlCachePath } from '../shared/asr-ggml-cache.ts';
import { modelCachePath } from '../shared/model-cache-path.ts';

/** One spoken unit with its measured span, in milliseconds. */
export interface SpeechToken {
  text: string;
  start: number;
  end: number;
}

export interface SpeechTiming {
  model: string;
  language: string;
  /** Last measured token end; 0 when nothing was recognised. */
  durationMs: number;
  tokens: SpeechToken[];
}

/** Model tiers the app already downloads; the file names are its catalogue's. */
export const WHISPER_MODELS = {
  tiny: 'ggml-tiny-q5_1.bin',
  base: 'ggml-base-q5_1.bin',
  small: 'ggml-small-q5_1.bin',
  medium: 'ggml-medium-q5_0.bin',
  'large-v3-turbo': 'ggml-large-v3-turbo-q5_0.bin',
} as const;

export type WhisperModelId = keyof typeof WHISPER_MODELS;

/**
 * The binary the app ships, under the same per-platform directory layout the
 * media binaries use. `OPENCHATCUT_WHISPER_CLI` wins so a different build can be
 * dropped in without touching this file.
 */
export function whisperBinary(repoRoot: string): string | null {
  const override = process.env.OPENCHATCUT_WHISPER_CLI?.trim();
  if (override) return existsSync(override) ? override : null;
  const dir = `${process.platform}-${process.arch}`;
  const name = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const candidate = join(repoRoot, 'public', 'whisper-cli', dir, name);
  return existsSync(candidate) ? candidate : null;
}

/** Canonical GGML path — the same file the app's own local transcription uses. */
export function whisperModelPath(model: WhisperModelId): string {
  const file = WHISPER_MODELS[model];
  if (!file) throw new Error(`unknown whisper model "${model}" (have: ${Object.keys(WHISPER_MODELS).join(', ')})`);
  return ggmlCachePath(modelCachePath(homedir()), file);
}

/** Every tier that is already on disk, smallest first. */
export function installedWhisperModels(): WhisperModelId[] {
  return (Object.keys(WHISPER_MODELS) as WhisperModelId[]).filter((id) => existsSync(whisperModelPath(id)));
}

interface WhisperJson {
  transcription?: Array<{
    offsets?: { from?: number; to?: number };
    text?: string;
    tokens?: Array<{ text?: string; offsets?: { from?: number; to?: number } }>;
  }>;
  result?: { language?: string };
}

/**
 * Tokens from whisper.cpp's `-ojf` output.
 *
 * Special tokens (`[_BEG_]`, `[_TT_123]`, …) carry timings but no speech, and a
 * zero-length token cannot place a highlight. Both are dropped, and the rest are
 * clamped so the list is monotonic — a consumer walks it as a timeline.
 */
export function tokensFromWhisperJson(json: unknown): SpeechToken[] {
  const parsed = json as WhisperJson;
  const tokens: SpeechToken[] = [];
  for (const segment of parsed.transcription ?? []) {
    for (const token of segment.tokens ?? []) {
      const text = String(token.text ?? '');
      if (!text.trim() || text.trim().startsWith('[_')) continue;
      const from = Number(token.offsets?.from);
      const to = Number(token.offsets?.to);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      const start = Math.max(0, Math.round(from));
      const end = Math.max(start, Math.round(to));
      if (end === start) continue;
      // Word timestamps can overlap by a few milliseconds. Clamping to the
      // previous token's end keeps the list walkable without losing speech —
      // dropping the token would delete a syllable from the timeline.
      const previous = tokens[tokens.length - 1];
      const clamped = previous ? Math.max(start, previous.end) : start;
      if (end <= clamped) continue;
      tokens.push({ text: text.trim(), start: clamped, end });
    }
  }
  return tokens;
}

export interface TranscribeOptions {
  audio: string;
  repoRoot: string;
  model?: WhisperModelId;
  language?: string;
  /** Threads for whisper.cpp; its own default is 4. */
  threads?: number;
  timeoutMs?: number;
}

export interface TranscribeResult extends SpeechTiming {
  binary: string;
  modelPath: string;
  /** Whisper's own lines, for a human sanity-checking the timing. */
  segments: Array<{ startMs: number; endMs: number; text: string }>;
}

/**
 * Run the local model over one audio file and return its token timings.
 *
 * whisper-cli reads mp3/ogg/flac/wav directly, so there is no decode step here.
 * Output goes to a temp prefix and is removed afterwards: the tool writes
 * `<prefix>.json` next to the input otherwise, which would litter the user's
 * media folder.
 */
export async function transcribeAudio(options: TranscribeOptions): Promise<TranscribeResult> {
  const binary = whisperBinary(options.repoRoot);
  if (!binary) {
    throw new Error(
      `whisper-cli is not available for ${process.platform}-${process.arch}; `
      + 'expected it under public/whisper-cli/ (or set OPENCHATCUT_WHISPER_CLI)',
    );
  }
  const model = options.model ?? (installedWhisperModels()[0] ?? 'base');
  const modelPath = whisperModelPath(model);
  if (!existsSync(modelPath)) {
    throw new Error(
      `whisper model "${model}" is not downloaded (${modelPath}). `
      + 'Download it once from Settings → 本地模型, or pick a tier that is already there: '
      + (installedWhisperModels().join(', ') || '(none installed)'),
    );
  }

  const work = join(tmpdir(), `occ-asr-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const prefix = join(work, 'out');
  const args = [
    '-m', modelPath,
    '-f', options.audio,
    '-ojf',
    '-l', options.language ?? 'auto',
    '-np',
    '-of', prefix,
    ...(options.threads ? ['-t', String(options.threads)] : []),
  ];

  try {
    await new Promise<string>((resolvePromise, rejectPromise) => {
      const child = spawn(binary, args, { windowsHide: true });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill();
        rejectPromise(new Error(`whisper-cli timed out after ${options.timeoutMs ?? 600_000}ms`));
      }, options.timeoutMs ?? 600_000);
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
      child.on('error', (error) => { clearTimeout(timer); rejectPromise(error); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolvePromise(out);
        else rejectPromise(new Error(`whisper-cli exited ${code}: ${err.trim().slice(-600) || out.trim().slice(-600)}`));
      });
    });

    const jsonPath = `${prefix}.json`;
    if (!existsSync(jsonPath)) throw new Error(`whisper-cli produced no JSON at ${jsonPath}`);
    const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as WhisperJson;
    const tokens = tokensFromWhisperJson(parsed);
    return {
      binary,
      modelPath,
      model,
      language: parsed.result?.language ?? options.language ?? 'auto',
      durationMs: tokens.length ? tokens[tokens.length - 1]!.end : 0,
      tokens,
      segments: segmentsFromWhisperJson(parsed),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Transcript lines whisper itself would show, for a human reading the output. */
export function segmentsFromWhisperJson(json: unknown): Array<{ startMs: number; endMs: number; text: string }> {
  const parsed = json as WhisperJson;
  return (parsed.transcription ?? [])
    .map((segment) => ({
      startMs: Math.max(0, Math.round(Number(segment.offsets?.from ?? 0))),
      endMs: Math.max(0, Math.round(Number(segment.offsets?.to ?? 0))),
      text: String(segment.text ?? '').trim(),
    }))
    .filter((segment) => segment.text && segment.endMs > segment.startMs);
}
