// Every recipe, one shot each, so the layouts can be compared side by side
// instead of one render at a time. Recipes have two arrangements now — a
// portrait design box and, for some, a wide one — and the only way to know a
// wide arrangement is right is to look at all fifteen next to each other.
//
//   node production/recipes/gallery.mjs 1920x1080 > production/work/gallery.json
//   occ project new 画廊 --size 1920x1080
//   occ compile 画廊 --storyboard production/work/gallery.json --replace --apply --no-captions
//   occ render  画廊 --out <abs>.mp4
//
// Then pull one frame per shot and tile them. `still` renders at 480px wide for
// the agent's vision budget, so a real render is the honest review copy.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [width, height] = String(process.argv[2] ?? '1920x1080').split('x').map(Number);
const RECIPES = 'production/recipes';

// Content per recipe: enough to exercise the layout, not a test of the copy.
const FIXTURES = {
  'chapter-card': { number: '01', title: '复利的起点', subtitle: '一个流传很广的说法', kicker: 'CHAPTER' },
  'big-word-fill': { text: '时间', caption: '复利的核心' },
  'keyword-punch': { text: '复利', label: '关于', tail: '一个流传很广的说法' },
  'number-count': { value: 37, from: 1, unit: '倍', label: '一年后', note: '每天进步 1%' },
  'progress-bar': { label: '每天进步', value: 1, unit: '%', note: '看起来微不足道' },
  'bar-compare': { title: '复利的力量', aLabel: '每天 1%', aValue: 1, bLabel: '一年后', bValue: 37, unit: '倍' },
  'line-chart': { title: '每天 1%', points: ['1', '1.2', '1.6', '2.2', '3.1', '5', '12', '37'], labels: ['1月', '2月', '3月', '4月', '6月', '8月', '10月', '12月'] },
  'compare-stack': { topLabel: '不重要', topText: '一次做多少', bottomLabel: '重要', bottomText: '能不能坚持' },
  'list-reveal': { title: '三个变量', items: ['本金', '利率', '时间'] },
  'icon-row': { title: '复利靠什么', items: ['本金', '利率', '时间'], icons: ['coin', 'growth', 'clock'] },
  'timeline-dots': { title: '时间的作用', items: ['开始', '坚持', '加速', '复利'], activeIndex: 2 },
  'flow-chain': { title: '复利怎么来的', steps: ['本金', '利率', '时间', '复利'], labels: ['起点', '乘数', '燃料', '结果'] },
  'stack-share': { title: '一年后的构成', parts: ['本金', '收益'], values: ['30', '70'], unit: '%' },
  'quote-card': { text: '重要的不是一次做多少，而是能不能坚持去做', author: '复利法则' },
  annotation: { x: 0.62, y: 0.42, size: 0.16, shape: 'circle', label: '看这里' },
};

function defaults(schema) {
  const out = {};
  for (const [key, param] of Object.entries(schema.params ?? {})) {
    if (param.default !== undefined) out[key] = param.default;
  }
  return out;
}

const names = readdirSync(RECIPES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const shots = [];
let cursor = 0;
const fps = 30;
const frames = 3 * fps;

names.forEach((name, index) => {
  const schema = JSON.parse(readFileSync(join(RECIPES, name, 'schema.json'), 'utf8'));
  shots.push({
    id: `R${String(index + 1).padStart(2, '0')}`,
    startFrame: cursor,
    endFrame: cursor + frames,
    narration: { text: '', startMs: cursor * (1000 / fps), endMs: (cursor + frames) * (1000 / fps) },
    intent: `${name} on a ${width}x${height} canvas`,
    background: '#0B0B0C',
    visual: {
      kind: 'mg',
      recipe: name,
      params: { ...defaults(schema), ...(FIXTURES[name] ?? {}) },
      // Full-frame recipes ignore this; the rest need a card anchor.
      layout: { anchor: schema.fullFrame ? 'full' : 'mc', widthRatio: 0.9 },
    },
  });
  cursor += frames;
});

const storyboard = {
  version: 1,
  meta: {
    title: 'recipe gallery',
    runId: 'recipe-gallery',
    aspect: width > height ? '16:9' : '9:16',
    width,
    height,
    fps,
    language: 'zh',
  },
  rhythm: { avgShotSec: 3, maxShotSec: 3, grammarChangeEverySec: 3, maxRepeatRecipe: 1, hookMaxSec: 3 },
  shots,
};

// Straight to stdout so the caller decides where it goes — a storyboard is a
// build artifact, not something this script should own a path for.
process.stdout.write(`${JSON.stringify(storyboard, null, 2)}\n`);
console.error(`${shots.length} recipes · ${width}x${height} · ${(cursor / fps).toFixed(0)}s`);
console.error(shots.map((shot) => `${shot.id}=${shot.visual.recipe}`).join(' '));
