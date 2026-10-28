#!/usr/bin/env node
// Run the content corpus: regenerate each storyboard, then score the set.
//
//   node production/corpus/run.mjs            # score what is already there
//   node production/corpus/run.mjs --regen    # call the model, then score
//
// The point is a number that moves when the prompt moves. One storyboard tells
// you what a run looks like; four sentence shapes tell you whether a change
// generalised or just fitted the last brief.
//
// Output lands in production/corpus/<id>/storyboard.json (gitignored, like
// everything else under work/). Regeneration needs LLM_<PROVIDER>_API_KEY.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = 'production/corpus';
const regen = process.argv.includes('--regen');
const size = process.argv.find((arg) => arg.startsWith('--size='))?.slice(7) ?? '1080x1920';

const items = JSON.parse(readFileSync(join(HERE, 'index.json'), 'utf8'));
const targets = [];

for (const item of items) {
  const srt = join(HERE, item.id, 'script.srt');
  const out = join(HERE, item.id, 'storyboard.json');
  if (regen || !existsSync(out)) {
    process.stderr.write(`▸ ${item.id} — generating…\n`);
    try {
      execFileSync(process.execPath, [
        'cli/occ.mjs', 'storyboard',
        '--srt', srt,
        '--brief', item.brief,
        '--generate',
        '--size', size,
        '--out', out,
        '--json',
      ], { stdio: ['ignore', 'ignore', 'inherit'] });
    } catch {
      process.stderr.write(`  ${item.id} failed — skipped\n`);
      continue;
    }
  }
  targets.push(out);
}

if (!targets.length) {
  process.stderr.write('nothing to score\n');
  process.exit(1);
}

execFileSync(process.execPath, ['production/score.mjs', ...targets], { stdio: 'inherit' });
