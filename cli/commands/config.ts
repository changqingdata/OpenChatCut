// `occ config` — where the pipeline gets its keys, and what it resolved.
//
// Values are never printed: this is a diagnostic that gets pasted into a chat or
// an issue, so it shows names and provenance only. The one derived value worth
// showing is the LLM provider and model, because "why is it calling the wrong
// model" is the question this command exists to answer.
import { rejectUnknownFlags, type CommandLine } from '../args.ts';
import { UsageError } from '../errors.ts';
import { printJson, writeStdout } from '../output.ts';
import { describeConfig, loadPipelineConfig } from '../../production/config.ts';
import { readLlmConfig } from '../../production/llm.ts';
import { GLOBAL_FLAGS } from './common.ts';

const FLAGS = [...GLOBAL_FLAGS, 'json'] as const;

/** Keys the pipeline actually reads, grouped the way a person thinks about them. */
const GROUPS: Array<{ label: string; keys: string[] }> = [
  {
    label: 'storyboard model',
    keys: ['PRODUCTION_LLM_PROVIDER', 'PRODUCTION_LLM_BASE_URL', 'PRODUCTION_LLM_MODEL', 'PRODUCTION_LLM_API_KEY',
      'LLM_PROVIDER'],
  },
  { label: 'stock footage', keys: ['PEXELS_API_KEY', 'PIXABAY_API_KEY'] },
  { label: 'private library', keys: ['PRESET_CDN_BASE', 'PRESET_MUSIC_INDEX_URL', 'PRESET_SFX_MANIFEST_URL'] },
];

export async function runConfigCommand(commandLine: CommandLine, json: boolean): Promise<void> {
  rejectUnknownFlags(commandLine, FLAGS);
  if (commandLine.positionals.length) {
    throw new UsageError('occ config takes no arguments');
  }
  const { values } = await loadPipelineConfig();
  const sources = await describeConfig();
  const llm = await readLlmConfig();

  const groups = GROUPS.map((group) => ({
    label: group.label,
    keys: group.keys.map((key) => ({ key, set: Boolean(values[key]) })),
  }));

  if (json) {
    printJson({
      sources,
      groups,
      llm: llm ? { provider: llm.provider, model: llm.model, baseUrl: llm.baseUrl } : null,
    });
    return;
  }

  writeStdout('sources');
  for (const line of sources) writeStdout(`  ${line}`);

  writeStdout('');
  writeStdout('keys (names only)');
  for (const group of groups) {
    writeStdout(`  ${group.label}`);
    for (const entry of group.keys) {
      writeStdout(`    ${entry.set ? 'set    ' : 'missing'} ${entry.key}`);
    }
  }

  writeStdout('');
  if (llm) {
    writeStdout(`storyboard model: ${llm.provider} / ${llm.model}`);
    writeStdout(`  endpoint: ${llm.baseUrl}`);
  } else {
    writeStdout('storyboard model: not configured');
    writeStdout('  set PRODUCTION_LLM_* in .env.local, or a provider in the app settings');
    writeStdout('  without it, use --prompt / --from to supply the storyboard from outside');
  }
}
