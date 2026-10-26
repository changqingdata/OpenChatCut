// Verifies config precedence and parsing: the rules that decide which key wins.
//
//   npx tsx production/config.verify.ts

import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPipelineConfig, parseEnvText } from './config.ts';

// --- parsing --------------------------------------------------------------

const parsed = parseEnvText([
  '# a comment',
  'PEXELS_API_KEY=abc',
  'LLM_MODEL = deepseek-flash ',
  'QUOTED="with spaces"',
  "SINGLE='x'",
  'EMPTY=',
  'not a pair',
  '',
].join('\r\n'));

assert.equal(parsed.PEXELS_API_KEY, 'abc', 'a plain pair parses');
assert.equal(parsed.LLM_MODEL, 'deepseek-flash', 'surrounding space is trimmed');
assert.equal(parsed.QUOTED, 'with spaces', 'double quotes are stripped');
assert.equal(parsed.SINGLE, 'x', 'single quotes are stripped');
assert.equal(parsed.EMPTY, '', 'an empty value is kept as empty');
assert.equal(parsed['# a comment'], undefined, 'comments are skipped');
assert.equal(Object.keys(parsed).length, 5, 'CRLF and junk lines do not add keys');

// --- precedence -----------------------------------------------------------

const dir = await mkdtemp(join(tmpdir(), 'occ-config-'));
const devFile = join(dir, '.env.local');
const appFile = join(dir, 'settings.env');

try {
  await writeFile(devFile, 'PEXELS_API_KEY=from-dev\nONLY_IN_DEV=1\nSHARED=from-dev\n', 'utf8');
  await writeFile(appFile, 'PEXELS_API_KEY=from-app\nSHARED=\nONLY_IN_APP=2\n', 'utf8');

  const { values, sources } = await loadPipelineConfig(devFile, {
    settingsPath: appFile,
    includeProcessEnv: false,
  });

  assert.equal(values.PEXELS_API_KEY, 'from-app', 'the app settings win over the dev file');
  assert.equal(values.ONLY_IN_DEV, '1', 'a key only in the dev file survives');
  assert.equal(values.ONLY_IN_APP, '2', 'a key only in the app file is picked up');
  assert.equal(values.SHARED, 'from-dev', 'an empty value never overrides a non-empty one');
  assert.equal(values.EMPTY_IN_APP, undefined, 'an empty value is not merged at all');

  assert.equal(sources.length, 2, 'both files are reported');
  assert.deepEqual(sources.map((s) => s.present), [true, true], 'both are present');

  // --- a missing settings file is not an error ---------------------------

  const missing = await loadPipelineConfig(devFile, {
    settingsPath: join(dir, 'nope.env'),
    includeProcessEnv: false,
  });
  assert.equal(missing.values.PEXELS_API_KEY, 'from-dev', 'the dev file still supplies the key');
  assert.deepEqual(missing.sources.map((s) => s.present), [true, false], 'the absent file is reported, not thrown');

  // --- no settings path at all -------------------------------------------

  const solo = await loadPipelineConfig(devFile, { settingsPath: null, includeProcessEnv: false });
  assert.equal(solo.sources.length, 1, 'with no app profile only the dev file is read');

  // --- the shell wins ----------------------------------------------------

  process.env.OCC_CONFIG_VERIFY = 'from-shell';
  const withShell = await loadPipelineConfig(devFile, { settingsPath: appFile });
  assert.equal(withShell.values.OCC_CONFIG_VERIFY, 'from-shell', 'process.env overrides both files');
  delete process.env.OCC_CONFIG_VERIFY;
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('config.verify: parsing, precedence, missing files and shell override OK');
