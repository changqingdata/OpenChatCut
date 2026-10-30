// `occ catalog` — what the pipeline can render, in a form an agent can hold.
//
// This command exists because the recipe list used to live in a prompt. A prompt
// is a copy, and copies drift: by the time `generate.ts` described fifteen
// recipes, three of them had grown a landscape box the prompt never mentioned.
// Reading the schemas means there is one source of truth, and it is the same one
// the compiler uses.
//
// Two shapes on purpose:
//
//   occ catalog                 the index — small enough to keep in context
//   occ catalog --recipe <id>   one recipe, in full
//
// An agent reads the index, picks two or three candidates, then asks for the
// detail it needs. Dumping all fifteen schemas is ~10KB and buys nothing.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { flagBoolean, flagText, rejectUnknownFlags, type CommandLine } from '../args.ts';
import { CliError } from '../errors.ts';
import { printJson, writeStdout } from '../output.ts';
import { GLOBAL_FLAGS, parseSize } from './common.ts';
import { loadRecipeRegistry, type RecipeSchema } from '../../production/recipes/load.ts';
import { DEFAULT_FOOTAGE_POLICY } from '../../src/pipeline/footage-policy.ts';
import { createProviders } from '../../production/assets/registry.ts';

const FLAGS = [...GLOBAL_FLAGS, 'json', 'recipe', 'full', 'size'] as const;

/**
 * Canvas sizes worth naming. The storyboard carries its own width/height, so
 * these are suggestions rather than a whitelist — but a director that invents
 * 1234x768 will get a layout nobody designed for.
 */
const CANVAS_PRESETS = [
  { id: '16:9', width: 1920, height: 1080 },
  { id: '9:16', width: 1080, height: 1920 },
  { id: '1:1', width: 1080, height: 1080 },
] as const;

/** The vocabulary a shot's `job` is drawn from. Recipes declare which they serve. */
const JOBS = ['thing', 'relation', 'number', 'process', 'quote', 'attention'] as const;

const CAPTION_PACING = ['phrase', 'word'] as const;
const CAPTION_MOTION = ['none', 'fade-up', 'pop', 'word-pop', 'karaoke-pulse'] as const;

/** Reference stills, produced by `production/catalog/build.mjs`. */
const STILL_DIR = 'production/catalog/stills';

/**
 * The storyboard shape, as data rather than prose.
 *
 * `catalog` used to describe what can be drawn and stop there, which left the
 * one thing a caller actually has to produce — the storyboard — to be inferred
 * from an example in a markdown file. An agent that has to guess field names
 * will guess wrong, and the failure arrives as a validation error several steps
 * later.
 *
 * The values are illustrative; the field names and the nesting are not.
 */
function storyboardShape(canvas: { width: number; height: number }) {
  return {
    version: 1,
    meta: {
      title: '一句话标题',
      runId: 'kebab-case-id',
      aspect: canvas.width > canvas.height ? '16:9' : '9:16',
      width: canvas.width,
      height: canvas.height,
      fps: 30,
      language: 'zh',
    },
    shots: [
      {
        id: 'S01',
        startFrame: 0,
        endFrame: 97,
        job: 'attention',
        intent: '这镜要观众记住什么，一句话',
        narration: { text: '这一镜说的字幕原文', startMs: 0, endMs: 3230 },
        visual: {
          kind: 'mg',
          recipe: 'chapter-card',
          params: {},
          layout: { anchor: 'full', widthRatio: 1 },
        },
        underlay: { subject: '硬币堆', query: 'stacked coins close up macro', confidence: 'high' },
        background: '#0B0B0C',
      },
    ],
  };
}

/** The handful of rules that fail loudly if broken, in the order they bite. */
const STORYBOARD_RULES = [
  'startFrame is the cut point: the first shot starts at 0, each shot starts where the previous one ended, and the last ends at the audio length in frames (seconds × 30). endFrame follows the next startFrame — `revise` re-derives it.',
  'meta.width/height must equal the target project canvas. `apply` refuses a mismatch rather than resizing the timeline.',
  'job must appear in the chosen recipe\'s `jobs`, or `check` reports job-mismatch. Omit `job` if you have no opinion — it is optional.',
  'Cards carry keywords, not the subtitle. quote-card may be a whole sentence, but not the sentence the voiceover just said.',
  'underlay.query describes a picture — object + setting + framing, 2-6 English words. Write no query when subject is "-"; density is decided by the pipeline, not by how many queries you write.',
];

function stillFor(id: string): string | null {
  const path = `${STILL_DIR}/${id}.jpg`;
  return existsSync(resolve(path)) ? path : null;
}

function indexEntry(schema: RecipeSchema) {
  const still = stillFor(schema.id);
  return {
    id: schema.id,
    name: schema.name,
    ...(schema.intent ? { intent: schema.intent } : {}),
    jobs: schema.jobs ?? [],
    ...(schema.fullFrame ? { fullFrame: true } : {}),
    ...(schema.landscapeBox ? { landscapeBox: schema.landscapeBox } : {}),
    // Names only: the detail view has the schemas, and an index that repeats
    // every parameter description is the 10KB dump this command avoids.
    paramNames: Object.keys(schema.params),
    ...(still ? { still } : {}),
  };
}

function detail(schema: RecipeSchema) {
  const still = stillFor(schema.id);
  return {
    id: schema.id,
    name: schema.name,
    ...(schema.nameEn ? { nameEn: schema.nameEn } : {}),
    ...(schema.intent ? { intent: schema.intent } : {}),
    jobs: schema.jobs ?? [],
    box: schema.box,
    ...(schema.landscapeBox ? { landscapeBox: schema.landscapeBox } : {}),
    ...(schema.fullFrame ? { fullFrame: true } : {}),
    ...(schema.sfx ? { sfx: schema.sfx } : {}),
    params: schema.params,
    ...(still ? { still } : {}),
  };
}

/**
 * Mood categories from the private audio library.
 *
 * Best-effort: a missing library is a reason to omit the list, not to fail a
 * catalog read. The index is served from a local cache, so this is normally
 * instant.
 */
async function musicCategories(): Promise<string[]> {
  try {
    const providers = await createProviders();
    const audio = providers.find((provider) => provider.id === 'private-audio');
    if (!audio?.categories || !(await audio.available())) return [];
    return await audio.categories('music');
  } catch {
    return [];
  }
}

export async function runCatalogCommand(commandLine: CommandLine, json: boolean): Promise<void> {
  rejectUnknownFlags(commandLine, FLAGS);

  const { schemas } = await loadRecipeRegistry(resolve('production/recipes'));
  const recipeFlag = flagText(commandLine, 'recipe');
  const full = flagBoolean(commandLine, 'full');

  if (recipeFlag) {
    const schema = schemas.get(recipeFlag);
    if (!schema) {
      throw new CliError(`unknown recipe "${recipeFlag}"`, {
        code: 'unknown-recipe',
        step: 'catalog',
        hint: `known: ${[...schemas.keys()].sort().join(', ')}`,
      });
    }
    const payload = { ok: true, recipe: detail(schema) };
    if (json) printJson(payload);
    else {
      writeStdout(`${schema.id} — ${schema.name}`);
      writeStdout(`  ${schema.intent ?? ''}`);
      writeStdout(`  jobs: ${(schema.jobs ?? []).join(', ') || '—'}`);
      writeStdout(`  box: ${schema.box.width}x${schema.box.height}${schema.landscapeBox ? ` · landscape ${schema.landscapeBox.width}x${schema.landscapeBox.height}` : ''}`);
      for (const [name, param] of Object.entries(schema.params)) {
        const bits: string[] = [param.type];
        if (param.required) bits.push('required');
        if (param.default !== undefined) bits.push(`default ${JSON.stringify(param.default)}`);
        if (param.maxChars) bits.push(`≤${param.maxChars} 字`);
        if (param.maxItems) bits.push(`≤${param.maxItems} 项`);
        if (param.values) bits.push(param.values.join('|'));
        writeStdout(`  ${name}: ${bits.join(' · ')}${param.description ? ` — ${param.description}` : ''}`);
      }
    }
    return;
  }

  // One shape for the printer, two for the payload: the index carries parameter
  // names, the detail carries the schemas themselves.
  const list = [...schemas.values()].sort((a, b) => a.id.localeCompare(b.id));
  const recipes: Array<{ id: string; jobs: string[]; still?: string }> = full
    ? list.map(detail)
    : list.map(indexEntry);

  const categories = await musicCategories();
  // The shape follows the canvas the caller asked about, because the meta block
  // has to match the project and a mismatched meta is refused downstream.
  const sizeFlag = flagText(commandLine, 'size');
  const [width, height] = sizeFlag ? parseSize(sizeFlag) : [1920, 1080];
  const payload = {
    ok: true,
    canvas: { fps: 30, presets: CANVAS_PRESETS },
    jobs: JOBS,
    storyboard: { shape: storyboardShape({ width, height }), rules: STORYBOARD_RULES },
    recipes,
    policy: {
      targetRatio: DEFAULT_FOOTAGE_POLICY.targetRatio,
      minGapShots: DEFAULT_FOOTAGE_POLICY.minGapShots,
      minFrames: DEFAULT_FOOTAGE_POLICY.minFrames,
      protectLast: DEFAULT_FOOTAGE_POLICY.protectLast,
      note: 'footage density is arithmetic: the storyboard proposes a query, the pipeline decides which shots keep it',
    },
    music: { categories },
    captions: { pacing: CAPTION_PACING, motion: CAPTION_MOTION },
    notes: [
      'storyboard.shape is the document to produce; storyboard.rules are the constraints that fail loudly. Write it, then run `occ check`.',
      'Edit a storyboard with `occ revise` — it validates and re-locks. A hand-edit is refused by compile/qc.',
      'Pick a recipe by its `jobs`: the shot decides what kind of picture it needs, the recipe says whether it can draw it.',
    ],
  };

  if (json) {
    printJson(payload);
    return;
  }
  writeStdout(`${recipes.length} recipes · ${JOBS.join(' / ')}`);
  for (const recipe of recipes) {
    const jobs = (recipe as { jobs: string[] }).jobs.join(',');
    const still = (recipe as { still?: string }).still ? '  [still]' : '';
    writeStdout(`  ${recipe.id.padEnd(16)} ${jobs.padEnd(18)}${still}`);
  }
  if (categories.length) writeStdout(`music: ${categories.join(' · ')}`);
  writeStdout('detail: occ catalog --recipe <id>');
}
