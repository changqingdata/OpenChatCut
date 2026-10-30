// A brand change must be a document change, not fifteen component edits.
//
// Three things have to hold, and only the third is easy to get wrong silently:
//
//   1. a style fills the props a template declares, and nothing else;
//   2. the shot's own params still win over the style;
//   3. a style never moves anything — same rects, same frames, same tracks.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

import { compile } from '../src/pipeline/compile.ts';
import type { RecipeRegistry } from '../src/pipeline/recipes.ts';
import { recipeRegistryFromTemplates } from '../src/pipeline/templates.ts';
import type { DesignStyle } from '../src/editor/designTypes.ts';
import type { Storyboard } from '../src/pipeline/types.ts';
import type { Tpl } from '../src/types.ts';

const ROOT = 'E:/Anacondapj/OpenChatCut';
const templates = JSON.parse(readFileSync(`${ROOT}/assets/templates/shots-templates.json`, 'utf8')) as Tpl[];
const recipes: RecipeRegistry = recipeRegistryFromTemplates(templates);

const storyboard: Storyboard = {
  version: 1,
  meta: { title: 'style', runId: 'style-verify', aspect: '16:9', width: 1920, height: 1080, fps: 30, language: 'zh' },
  shots: [{
    id: 'S01',
    startFrame: 0,
    endFrame: 90,
    job: 'number',
    intent: 'a number',
    narration: { text: '一个数字。', startMs: 0, endMs: 3000 },
    visual: { kind: 'mg', recipe: 'number-count', params: { value: 37 }, layout: { anchor: 'mc', widthRatio: 0.85 } },
    background: '#0B0B0C',
  }],
};

const warm: DesignStyle = {
  colors: [
    { role: 'background', value: '#0B0B0C' },
    { role: 'text', value: '#F2EFE9' },
    { role: 'accent', value: '#E8B04B' },
    { role: 'text secondary', value: '#8A857C' },
  ],
  fonts: [
    { role: 'heading', family: 'Smiley Sans' },
    { role: 'body', family: 'Noto Sans SC' },
  ],
};

const cool: DesignStyle = {
  colors: [
    { role: 'background', value: '#F7F5F0' },
    { role: 'text', value: '#101418' },
    { role: 'accent copper', value: '#C2410C' },
    { role: 'secondary', value: '#5F6B73' },
  ],
  fonts: [
    { role: 'display', family: 'PangMen ZhengDao' },
    { role: 'text', family: 'Noto Sans SC' },
  ],
};

/** The graphic itself — a shot also lays a base plate on V1. */
const graphic = (timeline: { items: Array<{ templateId?: string }> }) =>
  timeline.items.find((item) => item.templateId === 'number-count') as
    | (typeof timeline.items)[number] & { props?: Record<string, unknown> }
    | undefined;

const plain = graphic(compile(storyboard, { recipes }).timeline)!;
const warmItem = graphic(compile(storyboard, { recipes, style: warm }).timeline)!;
const coolItem = graphic(compile(storyboard, { recipes, style: cool }).timeline)!;

// 1. declared props get filled
assert.equal(warmItem.props?.accent, '#E8B04B', 'accent comes from the style');
assert.equal(warmItem.props?.ink, '#F2EFE9', 'text colour becomes ink');
assert.equal(warmItem.props?.displayFont, 'Smiley Sans', 'heading font becomes displayFont');
assert.equal(coolItem.props?.accent, '#C2410C', 'a differently named accent role still lands');
assert.equal(coolItem.props?.muted, '#5F6B73', 'secondary becomes muted');
assert.equal(coolItem.props?.bg, '#F7F5F0', 'background becomes bg');

// 2. no style → defaults untouched
assert.equal(plain.props?.accent, '#E8B04B', 'without a style the schema default stands');
assert.equal(plain.props?.bg, '', 'and a default that was empty stays empty');

// 3. the shot wins over the style
const override = graphic(compile(
  { ...storyboard, shots: [{ ...storyboard.shots[0]!, visual: { ...storyboard.shots[0]!.visual, params: { value: 37, accent: '#00FF00' } } }] },
  { recipes, style: warm },
).timeline)!;
assert.equal(override.props?.accent, '#00FF00', 'a shot-level param beats the brand');

// 4. geometry is untouched: same frames, same rect, same track
const shape = (item: typeof plain) => ({
  startFrame: item.startFrame,
  durationInFrames: item.durationInFrames,
  track: item.track,
  width: item.width,
  height: item.height,
  transform: item.transform,
});
assert.deepEqual(shape(warmItem), shape(plain), 'a style does not move a card');
assert.deepEqual(shape(coolItem), shape(plain), 'and a second style does not either');

// 5. props the template never declares are not invented
const quote = templates.find((template) => template.id === 'quote-card')!;
const quoteBoard: Storyboard = {
  ...storyboard,
  shots: [{
    ...storyboard.shots[0]!,
    job: 'quote',
    visual: { kind: 'mg', recipe: 'quote-card', params: { text: '坚持' }, layout: { anchor: 'mc', widthRatio: 0.85 } },
  }],
};
const quoteItem = compile(quoteBoard, { recipes, style: warm }).timeline.items
  .find((item) => item.templateId === 'quote-card')!;
for (const key of Object.keys(quoteItem.props ?? {})) {
  assert.ok(
    key in (quote.props ?? {}) || key === 'landscape' || key === 'muted',
    `compiled prop "${key}" is not declared by the template`,
  );
}

console.log('style.verify: brand fills declared props, shot params win, geometry unchanged');
