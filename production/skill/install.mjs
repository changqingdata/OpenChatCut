#!/usr/bin/env node
// Install (or refresh) the occ-video skill into the app's skill directory.
//
//   node production/skill/install.mjs            # copy + configure
//   node production/skill/install.mjs --check    # report drift
//   node production/skill/install.mjs --data-dir <abs path>   # isolated library
//
// What lands in the skill directory is deliberately tiny: SKILL.md (the
// playbook the agent reads) plus a bootstrap that imports the host layer from
// this repository. All the logic — cwd, environment, quoting, timeouts, run
// records — stays in production/skill-host/, so it is versioned, diffable and
// testable instead of living in a copy under the user's home directory.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const SLUG = 'occ-video';
const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), SLUG);
const REPO_ROOT = resolve(SOURCE, '..', '..', '..');
const SKILLS_ROOT = process.env.OPENCHATCUT_SKILLS_DIR?.trim() || join(homedir(), '.openchatcut', 'skills');
const TARGET = join(SKILLS_ROOT, SLUG);
/** Everything the agent actually reads; the rest is generated per install. */
const INSTALLED_FILES = ['SKILL.md', 'scripts/step.mjs'];

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const dataDirAt = args.indexOf('--data-dir');
const dataDir = dataDirAt >= 0 ? resolve(args[dataDirAt + 1] ?? '') : null;

const sha = (file) => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null);

if (checkOnly) {
  const rows = INSTALLED_FILES.map((file) => ({
    file,
    source: sha(join(SOURCE, file)),
    installed: sha(join(TARGET, file)),
  }));
  const drift = rows.filter((row) => row.source !== row.installed);
  console.log(JSON.stringify({ ok: drift.length === 0, target: TARGET, drift: drift.map((r) => r.file), rows }, null, 2));
  process.exit(drift.length === 0 ? 0 : 1);
}

if (!existsSync(join(SOURCE, 'SKILL.md'))) {
  console.error(`missing source skill at ${SOURCE}`);
  process.exit(1);
}

mkdirSync(SKILLS_ROOT, { recursive: true });
// scripts/ is replaced wholesale so a renamed helper never lingers.
rmSync(join(TARGET, 'scripts'), { recursive: true, force: true });
cpSync(SOURCE, TARGET, { recursive: true });

const config = { repoRoot: REPO_ROOT, ...(dataDir ? { dataDir } : {}) };
writeFileSync(join(TARGET, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  ok: true,
  installed: TARGET,
  repoRoot: REPO_ROOT,
  dataDir: dataDir ?? '(default profile: media resolves under the repo)',
  host: join(REPO_ROOT, 'production', 'skill-host', 'step.mjs'),
  next: [
    `run_skill_script(skill="${SLUG}", command="node scripts/step.mjs doctor")`,
    `run_skill_script(skill="${SLUG}", command="node scripts/step.mjs run -- where")`,
  ],
}, null, 2));
