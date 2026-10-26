// Where the pipeline gets its keys.
//
// Three files can hold configuration, and they exist for different reasons:
//
//   .env.local          the checkout's dev file, gitignored, written by hand
//   <profile>/settings.env  the app's settings — what the user fills in the UI
//   process.env         the shell, for a one-off run or a container
//
// The app and the pipeline need to agree: filling a Pexels key into the settings
// panel should make `occ footage resolve` work, without a second copy anywhere.
// So both read the same file, and the app's settings win over the checkout's dev
// file — the UI is the thing a person actually edits.
//
// Precedence, lowest to highest: .env.local → settings.env → process.env.
// Empty values never override a non-empty one: a blank `LLM_X_API_KEY=` left in
// the dev file would otherwise shadow a real key in the settings.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ConfigSource {
  path: string;
  present: boolean;
  keys: number;
}

export interface PipelineConfig {
  values: Record<string, string>;
  /** In merge order, so a diagnostic can show what won. */
  sources: ConfigSource[];
}

/** Parse a `KEY=value` file. Tolerates CRLF, comments, and quoted values. */
export function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    env[match[1]!] = match[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

/**
 * The app's settings file for the active profile.
 *
 * Resolved through `runtimeProfile()` when possible — it knows about isolated dev
 * profiles and `--data-dir`. The dynamic import matters: a static one would
 * freeze the profile before the CLI applies `--data-dir`.
 */
async function settingsPath(): Promise<string | null> {
  try {
    const { runtimeProfile } = await import('../server/runtime-profile.ts');
    const profile = runtimeProfile() as { keystorePath?: string };
    if (profile?.keystorePath) return profile.keystorePath;
  } catch {
    // Fall through to the conventional location.
  }
  const dataDir = process.env.OPENCHATCUT_DATA_DIR?.trim();
  return join(dataDir || join(homedir(), '.openchatcut'), 'settings.env');
}

async function readFileValues(path: string): Promise<{ values: Record<string, string>; present: boolean }> {
  try {
    return { values: parseEnvText(await readFile(path, 'utf8')), present: true };
  } catch {
    return { values: {}, present: false };
  }
}

/**
 * Merge every source once.
 *
 * Read per call rather than cached: a CLI invocation is short-lived, and a
 * cached config would make `occ` ignore a key the user just typed into the app.
 */
export interface LoadOptions {
  /** Override the app settings path. Tests use it; production leaves it unset. */
  settingsPath?: string | null;
  /** Merge `process.env` on top. Default true; tests turn it off to stay hermetic. */
  includeProcessEnv?: boolean;
}

export async function loadPipelineConfig(
  envPath = '.env.local',
  options: LoadOptions = {},
): Promise<PipelineConfig> {
  const settings = options.settingsPath === undefined ? await settingsPath() : options.settingsPath;
  const order = [envPath, ...(settings ? [settings] : [])];

  const values: Record<string, string> = {};
  const sources: ConfigSource[] = [];

  for (const path of order) {
    const { values: parsed, present } = await readFileValues(path);
    sources.push({ path, present, keys: Object.keys(parsed).length });
    for (const [key, value] of Object.entries(parsed)) {
      if (!value) continue;
      values[key] = value;
    }
  }

  // The shell wins, and is not a file, so it is reported separately.
  if (options.includeProcessEnv !== false) {
    for (const [key, value] of Object.entries(process.env)) {
      if (value) values[key] = value;
    }
  }

  return { values, sources };
}

/** Where a key came from, for `occ config`. */
export async function describeConfig(envPath = '.env.local'): Promise<string[]> {
  const { sources } = await loadPipelineConfig(envPath);
  return sources.map((source) =>
    `${source.present ? 'found  ' : 'missing'} ${source.path}`
    + (source.present ? ` (${source.keys} keys)` : ''));
}
