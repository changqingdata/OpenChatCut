// Demo for the second batch of recipes: chart, bars, icons, chapter card.
//
//   node production/demo/recipes-v2.mjs
import { mkdirSync, writeFileSync } from 'node:fs';

const FPS = 30;
const at = (s) => Math.round(s * FPS);
const shots = [];
const push = (id, startSec, endSec, recipe, rawParams, extra = {}) => {
  // Directive keys live alongside the recipe params for readability here, then
  // come out before compiling — a recipe would reject them as unknown fields.
  const { __intent, __bg, __anchor, __ratio, ...params } = rawParams;
  shots.push({
    id,
    startFrame: at(startSec),
    endFrame: at(endSec),
    narration: { text: '', startMs: Math.round(startSec * 1000), endMs: Math.round(endSec * 1000) },
    intent: __intent ?? id,
    background: __bg ?? '#0B0B0C',
    ...extra,
    visual: { kind: 'mg', recipe, params, layout: { anchor: __anchor ?? 'mc', widthRatio: __ratio ?? 0.9 } },
  });
};

push('R1', 0, 2.5, 'chapter-card', { number: '01', title: '复利', subtitle: '为什么它不直观', __anchor: 'full', __ratio: 1 });
push('R2', 2.5, 6.5, 'line-chart', {
  points: ['1', '1.6', '2.9', '5.2', '9.4', '17', '37'],
  labels: ['1月', '', '', '', '', '', '12月'],
  title: '每天 1% 的累积', unit: '×',
});
push('R3', 6.5, 10.5, 'bar-compare', {
  aLabel: '每天退步', aValue: 0.03, bLabel: '每天进步', bValue: 37, unit: '×', title: '一年之后',
});
push('R4', 10.5, 14.5, 'icon-row', {
  items: ['持续投入', '时间够长', '不中途退出'],
  icons: ['coin', 'clock', 'shield'],
  title: '三个条件',
});
push('R5', 14.5, 18.5, 'keyword-punch', { text: '时间', label: 'TIME', align: 'center' },
  { transitionIn: { type: 'fade', durationInFrames: 12 } });

const storyboard = {
  version: 1,
  meta: { title: '配方第二批', runId: 'recipes-v2', aspect: '9:16', width: 1080, height: 1920, fps: FPS, language: 'zh' },
  rhythm: { avgShotSec: 3.5, maxShotSec: 6, grammarChangeEverySec: 6, maxRepeatRecipe: 2, hookMaxSec: 3 },
  shots,
};
mkdirSync('production/work/recipes2', { recursive: true });
writeFileSync('production/work/recipes2/storyboard.json', `${JSON.stringify(storyboard, null, 2)}\n`, 'utf8');
console.log(`${shots.length} shots, ${shots.at(-1).endFrame} frames`);
