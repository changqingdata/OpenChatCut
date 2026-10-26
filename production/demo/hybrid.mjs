// A hand-written hybrid storyboard: real footage under real graphics.
//
// This exists to prove the underlay path end to end without spending a model
// call. Shot boundaries follow the subtitle cues exactly — a demo whose captions
// argue one thing while the picture argues another proves nothing.
//
//   node production/demo/hybrid.mjs
import { mkdirSync, writeFileSync } from 'node:fs';

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;

/** Frame for a subtitle timestamp, so cuts land where the sentence changes. */
const at = (seconds) => Math.round(seconds * FPS);

const shots = [];

function shot(id, startSec, endSec, intent, body) {
  shots.push({
    id,
    startFrame: at(startSec),
    endFrame: at(endSec),
    narration: { text: '', startMs: Math.round(startSec * 1000), endMs: Math.round(endSec * 1000) },
    intent,
    ...body,
  });
}

// Cues 1–2 — "关于复利 / 有一个流传很广的说法"
// Footage first: the opening three seconds decide whether this reads as a video.
shot('S01', 0, 3.233, '让观众立刻知道今天只讲一个词：复利', {
  underlay: { query: 'person writing in notebook', note: '开场用实拍建立"这是视频"' },
  visual: {
    kind: 'mg',
    recipe: 'keyword-punch',
    params: { text: '复利', label: 'COMPOUND', align: 'center' },
    layout: { anchor: 'tc', widthRatio: 0.86 },
  },
});

// Cues 3–4 — "每天进步 1% / 一年后 37 倍"
shot('S02', 3.233, 8.0, '每天 1% 一年是 37 倍，把反差砸出来', {
  background: '#0B0B0C',
  visual: {
    kind: 'mg',
    recipe: 'number-count',
    params: { value: 37, from: 1, unit: '×', label: '一年之后', note: '每天进步 1%' },
    layout: { anchor: 'mc', widthRatio: 0.9 },
  },
});

// Cues 5–6 — "每天退步 1% / 几乎归零"
shot('S03', 8.0, 12.233, '同样的 1% 反着走只剩 0.03 倍', {
  background: '#0B0B0C',
  visual: {
    kind: 'mg',
    recipe: 'number-count',
    params: { value: 0.03, from: 1, decimals: 2, unit: '×', label: '一年之后', note: '每天退步 1%', accent: '#D2604A' },
    layout: { anchor: 'mc', widthRatio: 0.9 },
  },
});

// Cue 7 — "关键在于". One second of footage with no graphics: a breath, and a
// reminder that the picture is not always a card.
shot('S04', 12.233, 13.333, '给观众一个呼吸，把两个数字的落差拉开', {
  underlay: { query: 'city skyline sunset clouds', note: '纯素材过渡镜，不叠图形' },
});

// Cues 8–9 — "不是利率 / 而是时间"
shot('S05', 13.333, 16.266, '核心变量不是收益率，而是时间', {
  background: '#0B0B0C',
  visual: {
    kind: 'mg',
    recipe: 'compare-stack',
    params: { topLabel: '表面', topText: '利率高低', bottomLabel: '本质', bottomText: '时间长短' },
    layout: { anchor: 'mc', widthRatio: 0.9 },
  },
});

// Cues 10–11 — "起步早的人 / 优势会随时间成指数级放大"
// Footage plus one word. The overlay sits high so the caption band stays clear.
shot('S06', 16.266, 21.0, '时间才是那个放大器', {
  underlay: { query: 'hourglass sand falling', note: '把"时间"这个抽象词落成可见的东西' },
  visual: {
    kind: 'mg',
    recipe: 'keyword-punch',
    params: { text: '时间', label: 'TIME', align: 'center' },
    layout: { anchor: 'tc', widthRatio: 0.8 },
  },
});

// Cue 12 — "所以重要的不是一次做多少"
shot('S07', 21.0, 23.7, '把这一句放慢，让人读进去', {
  background: '#0B0B0C',
  visual: {
    kind: 'mg',
    recipe: 'quote-card',
    params: { text: '重要的不是一次做多少，而是能不能坚持。', author: '复利', source: '最后一句' },
    layout: { anchor: 'ml', widthRatio: 0.86 },
  },
});

// Cue 13 — "而是能不能坚持去做". The single strongest hit, used once.
shot('S08', 23.7, 25.533, '落到唯一行动：坚持', {
  visual: {
    kind: 'mg',
    recipe: 'big-word-fill',
    params: { text: '坚持', caption: 'KEEP GOING' },
    layout: { anchor: 'full', widthRatio: 1 },
  },
});

const storyboard = {
  version: 1,
  meta: {
    title: '混剪测试',
    runId: 'hybrid',
    aspect: '9:16',
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    language: 'zh',
  },
  rhythm: { avgShotSec: 3.2, maxShotSec: 6, grammarChangeEverySec: 6, maxRepeatRecipe: 2, hookMaxSec: 3.5 },
  music: { category: '益智灵动' },
  shots,
};

mkdirSync('production/work/hybrid', { recursive: true });
const out = 'production/work/hybrid/storyboard.json';
writeFileSync(out, `${JSON.stringify(storyboard, null, 2)}\n`, 'utf8');
const last = shots[shots.length - 1];
console.log(`${out}: ${shots.length} shots, ${last.endFrame} frames (${(last.endFrame / FPS).toFixed(2)}s)`);
