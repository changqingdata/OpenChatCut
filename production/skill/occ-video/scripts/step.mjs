#!/usr/bin/env node
// Bootstrap only — the logic lives in the repository, not here.
//
// `run_skill_script` refuses to run a script outside the skill directory, so
// this file has to exist. It does nothing but hand over to
// <repo>/production/skill-host/step.mjs, which means there is exactly one copy
// of that logic, versioned with the rest of the pipeline. Editing it here would
// be editing the wrong file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const configUrl = new URL('../config.json', import.meta.url);
const config = JSON.parse(readFileSync(configUrl, 'utf8'));

process.env.OCC_SKILL_CONFIG = fileURLToPath(configUrl);
process.env.OCC_REPO_ROOT = config.repoRoot;

const host = join(config.repoRoot, 'production', 'skill-host', 'step.mjs');
const { run } = await import(pathToFileURL(host).href);
run();
