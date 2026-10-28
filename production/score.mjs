#!/usr/bin/env node
// Content metrics for a storyboard — the ruler, not the judge.
//
//   node production/score.mjs production/work/*/storyboard.json
//   node production/score.mjs --json <file...>
//
// QC answers "is this cut broken". This answers "is this version better than
// the last one", which is a different question and needs numbers that move.
// Every metric here is deterministic and needs no model, so a change to the
// prompt or the recipes can be measured in seconds instead of by eye.
//
// Deliberately no composite score: one number invites optimising the number.
// The columns are the argument.

import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const args = process.argv.slice(2);
const json = args.includes('--json');
const files = args.filter((arg) => !arg.startsWith('--'));
if (!files.length) {
  console.error('usage: node production/score.mjs [--json] <storyboard.json...>');
  process.exit(2);
}

/** Text params a recipe might carry. Colours and fonts are not copy. */
function copyStrings(params) {
  const out = [];
  for (const value of Object.values(params ?? {})) {
    if (typeof value !== 'string') continue;
    if (value.startsWith('#') || value.includes('sans') || value.includes('Smiley')) continue;
    if (value.length < 2) continue;
    out.push(value);
  }
  return out;
}

/** Longest common substring length — cheap enough for 30-character strings. */
function longestCommon(a, b) {
  if (!a || !b) return 0;
  let best = 0;
  let previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best) best = current[j];
      }
    }
    previous = current;
  }
  return best;
}

export function scoreStoryboard(storyboard) {
  const shots = Array.isArray(storyboard.shots) ? storyboard.shots : [];
  const total = shots.length || 1;

  const recipeOf = (shot) => shot.visual?.recipe ?? shot.visual?.kind ?? 'none';
  const counts = new Map();
  for (const shot of shots) {
    const recipe = recipeOf(shot);
    counts.set(recipe, (counts.get(recipe) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0] ?? ['none', 0];

  const anchors = new Set(shots.map((shot) => shot.visual?.layout?.anchor ?? '-'));
  const durations = shots.map((shot) => (shot.endFrame - shot.startFrame) / 30);
  const mean = durations.length ? durations.reduce((sum, d) => sum + d, 0) / durations.length : 0;
  const span = durations.length ? Math.max(...durations) - Math.min(...durations) : 0;

  // A transition on every cut is a slideshow. The count alone is meaningless
  // without the shot count, so both are kept.
  const transitions = shots.filter((shot) => shot.transitionIn).length;

  // Intent is not evidence. A shot "asks" for footage when it names a query,
  // and the pipeline can only use it when the model also committed to a
  // concrete subject it is not unsure about — that is the number that matters.
  const asksFootage = shots.filter((shot) => shot.underlay?.query).length;
  const usableFootage = shots.filter((shot) => {
    const underlay = shot.underlay;
    if (!underlay) return false;
    if (underlay.confidence === 'low') return false;
    if ((underlay.subject ?? '').trim() === '-') return false;
    return Boolean(underlay.subject || underlay.query);
  }).length;

  // A card that repeats the line being spoken reads as a stutter. Measured as
  // the longest shared run, because the card is often longer than the cue (a
  // quote) or shorter than it (a keyword) — containment only catches one side.
  const duplicates = shots.filter((shot) => {
    const narration = String(shot.narration?.text ?? '');
    if (!narration) return false;
    return copyStrings(shot.visual?.params).some((text) => {
      const shared = longestCommon(text, narration);
      return shared >= 6 && shared / Math.min(text.length, narration.length) >= 0.6;
    });
  }).length;

  return {
    shots: shots.length,
    recipes: counts.size,
    topRecipe: top[0],
    topCount: top[1],
    topShare: Number((top[1] / total).toFixed(2)),
    anchors: anchors.size,
    meanDuration: Number(mean.toFixed(2)),
    durationSpan: Number(span.toFixed(2)),
    transitions,
    transitionShare: Number((transitions / total).toFixed(2)),
    asksFootage,
    usableFootage,
    duplicates,
    recipeCounts: Object.fromEntries(ranked),
  };
}

const rows = [];
for (const file of files) {
  let storyboard;
  try {
    storyboard = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    continue;
  }
  // Prefer the project name — `production/work/<name>/storyboard.json` is how
  // these are laid out, and two files called storyboard.json are the norm.
  const label = basename(dirname(file)) === 'work' ? basename(file, '.json') : basename(dirname(file));
  rows.push({ label, ...scoreStoryboard(storyboard) });
}

if (json) {
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  process.exit(process.exitCode ?? 0);
}

if (!rows.length) process.exit(1);

const pad = (value, width) => String(value).padEnd(width);
const num = (value, width) => String(value).padStart(width);

console.log(
  pad('storyboard', 16), num('shots', 5), num('rec', 4), num('anchor', 6),
  num('dur μ/span', 11), num('trans', 6), num('foot', 5), num('use', 4), num('dup', 4), '  top',
);
console.log('-'.repeat(96));
for (const row of rows) {
  console.log(
    pad(row.label.slice(0, 15), 16),
    num(row.shots, 5),
    num(row.recipes, 4),
    num(row.anchors, 6),
    num(`${row.meanDuration}/${row.durationSpan}`, 11),
    num(`${row.transitions}/${row.shots}`, 6),
    num(row.asksFootage, 5),
    num(row.usableFootage, 4),
    num(row.duplicates, 4),
    `  ${row.topRecipe}×${row.topCount} (${Math.round(row.topShare * 100)}%)`,
  );
}

if (rows.length > 1) {
  const mean = (key) => (rows.reduce((sum, row) => sum + row[key], 0) / rows.length);
  console.log('-'.repeat(96));
  console.log(
    pad('MEAN', 16),
    num(mean('shots').toFixed(1), 5),
    num(mean('recipes').toFixed(1), 4),
    num(mean('anchors').toFixed(1), 6),
    num(`${mean('meanDuration').toFixed(2)}/${mean('durationSpan').toFixed(2)}`, 11),
    num(mean('transitions').toFixed(1), 6),
    num(mean('asksFootage').toFixed(1), 5),
    num(mean('usableFootage').toFixed(1), 4),
    num(mean('duplicates').toFixed(1), 4),
    `  ${Math.round(mean('topShare') * 100)}% top share`,
  );
}

// Which recipes never appear is the number that explains "it all looks the
// same". A recipe that is never chosen cannot be the wrong choice.
const used = new Set();
for (const file of files) {
  try {
    for (const shot of JSON.parse(readFileSync(file, 'utf8')).shots ?? []) {
      used.add(shot.visual?.recipe ?? shot.visual?.kind);
    }
  } catch { /* already reported */ }
}
console.log('');
console.log(`recipes used across ${files.length} storyboard(s): ${[...used].filter(Boolean).sort().join(', ')}`);
