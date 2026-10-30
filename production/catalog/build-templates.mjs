// Recipes → the app's template catalog.
//
// `production/recipes/<id>/{index.jsx,schema.json}` is the authoring source; this
// script turns each one into a `Tpl` the editor, the library and the built-in
// agent can see. One direction only — hand-editing the JSON is what makes two
// sources of truth, so `--check` regenerates in memory and fails when the
// committed file has drifted.
//
//   node production/catalog/build-templates.mjs            # write
//   node production/catalog/build-templates.mjs --check    # verify only
//
// Thumbnails come from `production/catalog/stills/` (the same reference frames
// `occ catalog` points at) and are copied into `assets/thumbnails/`, which the
// dev server serves at `/thumbnails/…`.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const RECIPES = join(ROOT, 'production/recipes');
const STILLS = join(ROOT, 'production/catalog/stills');
const THUMBS = join(ROOT, 'assets/thumbnails');
const OUT = join(ROOT, 'assets/templates/shots-templates.json');

/** Where each recipe belongs in the catalog. Mirrors the upstream category names
 * so one library has one vocabulary, not two. */
const CATEGORY = {
  'number-count': 'data-visualization',
  'bar-compare': 'data-visualization',
  'line-chart': 'data-visualization',
  'stack-share': 'data-visualization',
  'progress-bar': 'data-visualization',
  'compare-stack': 'infographics',
  'list-reveal': 'infographics',
  'icon-row': 'infographics',
  'flow-chain': 'infographics',
  'timeline-dots': 'infographics',
  annotation: 'infographics',
  'quote-card': 'quote-cards',
  'chapter-card': 'title-cards',
  'big-word-fill': 'title-cards',
  'keyword-punch': 'text-effects',
};

/** The value a param carries when the schema declares no default. */
function neutral(param) {
  if (param.type === 'number') return param.min ?? 0;
  if (param.type === 'color') return '#ffffff';
  if (param.type === 'enum') return param.values?.[0] ?? '';
  if (param.type === 'array') return [];
  return '';
}

/** Recipe param type → editor control. `array` needs a control of its own. */
function toPropSpec(key, param) {
  const base = { key, label: param.description || key };
  const spec = { ...base, type: 'text', defaultValue: param.default ?? neutral(param) };

  if (param.type === 'number') {
    return {
      ...base,
      type: 'number',
      defaultValue: param.default ?? neutral(param),
      ...(param.min !== undefined ? { min: param.min } : {}),
      ...(param.max !== undefined ? { max: param.max } : {}),
    };
  }
  if (param.type === 'color') return { ...base, type: 'color', defaultValue: param.default ?? neutral(param) };
  if (param.type === 'font') return { ...base, type: 'font', defaultValue: param.default ?? neutral(param) };
  if (param.type === 'enum') {
    return { ...base, type: 'select', defaultValue: param.default ?? neutral(param), options: param.values ?? [] };
  }
  if (param.type === 'array') {
    return {
      ...base,
      type: 'array',
      defaultValue: param.default ?? neutral(param),
      ...(param.maxItems !== undefined ? { maxItems: param.maxItems } : {}),
      ...(param.itemMaxChars !== undefined ? { itemMaxLength: param.itemMaxChars } : {}),
    };
  }
  return { ...spec, ...(param.maxChars !== undefined ? { maxLength: param.maxChars } : {}) };
}

function build() {
  const dirs = readdirSync(RECIPES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const templates = [];
  for (const dir of dirs) {
    const schemaPath = join(RECIPES, dir, 'schema.json');
    const codePath = join(RECIPES, dir, 'index.jsx');
    if (!existsSync(schemaPath) || !existsSync(codePath)) continue;

    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const code = readFileSync(codePath, 'utf8');
    if (!CATEGORY[schema.id]) throw new Error(`${schema.id}: no catalog category — add it to CATEGORY`);

    // Defaults, so a card dragged out of the library renders something real
    // instead of an empty box. `landscape` is exposed as a switch: the compiler
    // injects it when the canvas is wide, and a person can flip it by hand.
    const props = { landscape: false };
    const propSchema = [{ key: 'landscape', type: 'boolean', defaultValue: false, label: '横屏排布' }];
    for (const [key, param] of Object.entries(schema.params)) {
      const spec = toPropSpec(key, param);
      props[key] = spec.defaultValue;
      propSchema.push(spec);
    }

    // A full-frame recipe owns the canvas, so that is the canvas it declares.
    // Its design box is not a card size and must not be published as one —
    // a 900×900 "scene" would letterbox to a square on a 16:9 timeline.
    const fullFrame = schema.fullFrame === true;
    const portrait = schema.box.width === 1080 && schema.box.height === 1920;
    const width = fullFrame ? (portrait ? 1080 : 1920) : schema.box.width;
    const height = fullFrame ? (portrait ? 1920 : 1080) : schema.box.height;

    templates.push({
      id: schema.id,
      name: schema.name,
      category: CATEGORY[schema.id],
      description: schema.intent ?? schema.name,
      tags: [
        '卡片',
        ...(schema.nameEn ? [schema.nameEn] : []),
        ...(schema.fullFrame ? ['整屏'] : ['叠加']),
        ...(schema.landscapeBox ? ['横屏适配'] : []),
        ...(schema.jobs ?? []),
      ],
      width,
      height,
      fps: 30,
      durationInFrames: 90,
      kind: fullFrame ? 'scene' : 'card',
      ...(fullFrame ? { fullFrame: true } : { box: { width, height } }),
      ...(schema.landscapeBox ? { landscapeBox: schema.landscapeBox } : {}),
      ...(schema.jobs ? { jobs: schema.jobs } : {}),
      ...(schema.sfx ? { sfx: schema.sfx } : {}),
      props,
      propSchema,
      thumb: `/thumbnails/shots-${schema.id}.jpg`,
      code,
    });
  }
  return templates;
}

const templates = build();
const serialized = `${JSON.stringify(templates, null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (!existsSync(OUT)) {
    console.error('shots-templates.json is missing — run: node production/catalog/build-templates.mjs');
    process.exit(1);
  }
  const committed = readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
  if (committed !== serialized) {
    const a = committed.split('\n');
    const b = serialized.split('\n');
    const at = a.findIndex((line, i) => line !== b[i]);
    console.error('shots-templates.json is stale — regenerate it with: node production/catalog/build-templates.mjs');
    console.error(`  first difference at line ${at + 1}`);
    console.error(`  committed: ${a[at]}`);
    console.error(`  generated: ${b[at]}`);
    process.exit(1);
  }
  console.log(`shots-templates.json up to date (${templates.length} templates)`);
  process.exit(0);
}

mkdirSync(join(ROOT, 'assets/templates'), { recursive: true });
mkdirSync(THUMBS, { recursive: true });

let thumbs = 0;
for (const template of templates) {
  const still = join(STILLS, `${template.id}.jpg`);
  if (!existsSync(still)) {
    console.warn(`  no reference still for ${template.id} — run: node production/catalog/build.mjs`);
    continue;
  }
  copyFileSync(still, join(THUMBS, `shots-${template.id}.jpg`));
  thumbs += 1;
}

writeFileSync(OUT, serialized, 'utf8');
const cards = templates.filter((t) => t.kind === 'card').length;
console.log(`wrote ${templates.length} templates (${cards} card / ${templates.length - cards} scene), ${thumbs} thumbnails`);
