// Demo for the third batch: annotation, flow chain, stacked share.
//
//   node production/demo/recipes-v3.mjs
import { mkdirSync, writeFileSync } from 'node:fs';

const FPS = 30;
const at = (s) => Math.round(s * FPS);
const shots = [];
const push = (id, startSec, endSec, recipe, rawParams) => {
  const { __anchor, __ratio, ...params } = rawParams;
  shots.push({
    id,
    startFrame: at(startSec),
    endFrame: at(endSec),
    narration: { text: '', startMs: Math.round(startSec * 1000), endMs: Math.round(endSec * 1000) },
    intent: id,
    background: '#0B0B0C',
    visual: { kind: 'mg', recipe, params, layout: { anchor: __anchor ?? 'mc', widthRatio: __ratio ?? 0.9 } },
  });
};

push('A1', 0, 3, 'annotation', {
  x: 0.5, y: 0.42, size: 0.34, shape: 'circle', label: '就是这里',
  __anchor: 'mc', __ratio: 0.86,
});
push('A2', 3, 7, 'flow-chain', {
  steps: ['每天 1%', '一年 37 倍', '差距拉开'],
  labels: ['原因', '机制', '结果'],
  title: '复利怎么发生的',
});
push('A3', 7, 11, 'stack-share', {
  parts: ['房租', '吃饭', '交通', '其他'],
  values: ['30', '25', '18', '27'],
  title: '钱花在哪', unit: '%',
});

const storyboard = {
  version: 1,
  meta: { title: '配方第三批', runId: 'recipes-v3', aspect: '9:16', width: 1080, height: 1920, fps: FPS, language: 'zh' },
  rhythm: { avgShotSec: 3.5, maxShotSec: 6, grammarChangeEverySec: 6, maxRepeatRecipe: 2, hookMaxSec: 3 },
  shots,
};
mkdirSync('production/work/recipes3', { recursive: true });
writeFileSync('production/work/recipes3/storyboard.json', `${JSON.stringify(storyboard, null, 2)}\n`, 'utf8');
console.log(`${shots.length} shots, ${shots.at(-1).endFrame} frames`);
