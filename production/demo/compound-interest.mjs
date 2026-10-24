// Builds the storyboard for the 25s "复利" demo clip.
//
// Written as a script rather than raw JSON so the motion-graphic source stays
// readable — inline JSX in a JSON string is unmaintainable and error-prone.
//
//   node production/demo/compound-interest.mjs <assetId> <src> <durationFrames>
//
// Output: production/work/demo/storyboard.json

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(here, '../work/demo/storyboard.json');

const [, , assetId, src, durationArg] = process.argv;
if (!assetId || !src || !durationArg) {
  console.error('usage: node compound-interest.mjs <assetId> <src> <durationFrames>');
  process.exit(1);
}
const durationFrames = Number(durationArg);

const W = 1080;
const H = 1920;

const PALETTE = {
  bg: '#0B0B0C',
  ink: '#F2EFE9',
  muted: '#8A857C',
  accent: '#E8B04B',
  warn: '#D2604A',
};

const DISPLAY = "'Smiley Sans', 'Noto Sans SC', sans-serif";
const TEXT = "'Noto Sans SC', sans-serif";

/** Full-frame title card. */
const titleCard = `
const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;

  const enter = interpolate(frame, [0, fps * 0.75], [0, 1], { extrapolateRight: 'clamp' });
  const rise = (1 - enter) * 34;
  const rule = interpolate(frame, [fps * 0.2, fps * 1.3], [0, 132], { extrapolateRight: 'clamp' });
  const kicker = interpolate(frame, [fps * 0.5, fps * 1.4], [0, 1], { extrapolateRight: 'clamp' });

  const rootStyle = {
    position: 'absolute', inset: 0, backgroundColor: p.bg,
    display: 'flex', flexDirection: 'column', justifyContent: 'center',
    padding: '0 104px', boxSizing: 'border-box',
  };
  const ruleStyle = { width: rule, height: 6, backgroundColor: p.accent, marginBottom: 56 };
  const titleStyle = {
    fontFamily: p.displayFont, fontSize: 168, lineHeight: 1.04, fontWeight: 400,
    color: p.ink, letterSpacing: '-0.02em', opacity: enter,
    transform: 'translateY(' + rise + 'px)',
  };
  const kickerStyle = {
    marginTop: 44, fontFamily: p.bodyFont, fontSize: 34, fontWeight: 500,
    letterSpacing: '0.42em', color: p.muted, opacity: kicker,
  };

  return (
    <div style={rootStyle}>
      <div style={ruleStyle} />
      <div style={titleStyle}>{p.title}</div>
      <div style={kickerStyle}>{p.kicker}</div>
    </div>
  );
};
`;

/** Big number with a counting value and a caption above/below. */
const statCard = `
const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;

  const enter = interpolate(frame, [0, fps * 0.5], [0, 1], { extrapolateRight: 'clamp' });
  const count = interpolate(frame, [fps * 0.25, fps * 1.5], [p.from, p.to], { extrapolateRight: 'clamp' });
  const shown = p.decimals > 0 ? count.toFixed(p.decimals) : Math.round(count).toString();
  const rise = (1 - enter) * 26;

  const rootStyle = {
    position: 'absolute', inset: 0, backgroundColor: p.bg,
    display: 'flex', flexDirection: 'column', justifyContent: 'center',
    padding: '0 104px', boxSizing: 'border-box',
  };
  const labelStyle = {
    fontFamily: p.bodyFont, fontSize: 44, fontWeight: 500, color: p.muted,
    letterSpacing: '0.04em', opacity: enter,
  };
  const valueRow = {
    display: 'flex', alignItems: 'baseline', marginTop: 28,
    opacity: enter, transform: 'translateY(' + rise + 'px)',
  };
  const valueStyle = {
    fontFamily: p.displayFont, fontSize: 300, lineHeight: 0.92, fontWeight: 400,
    color: p.accent, letterSpacing: '-0.04em',
  };
  const unitStyle = {
    fontFamily: p.displayFont, fontSize: 130, fontWeight: 400, color: p.accent,
    marginLeft: 12,
  };
  const footStyle = {
    marginTop: 40, fontFamily: p.bodyFont, fontSize: 40, color: p.ink, opacity: enter,
  };

  return (
    <div style={rootStyle}>
      <div style={labelStyle}>{p.label}</div>
      <div style={valueRow}>
        <span style={valueStyle}>{shown}</span>
        <span style={unitStyle}>{p.unit}</span>
      </div>
      <div style={footStyle}>{p.foot}</div>
    </div>
  );
};
`;

/** Two-line statement, second line in the accent colour. */
const statementCard = `
const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;

  const first = interpolate(frame, [0, fps * 0.5], [0, 1], { extrapolateRight: 'clamp' });
  const second = interpolate(frame, [fps * 0.45, fps * 1.0], [0, 1], { extrapolateRight: 'clamp' });
  const shift = (1 - second) * 24;

  const rootStyle = {
    position: 'absolute', inset: 0, backgroundColor: p.bg,
    display: 'flex', flexDirection: 'column', justifyContent: 'center',
    padding: '0 104px', boxSizing: 'border-box',
  };
  const lineOne = {
    fontFamily: p.displayFont, fontSize: 108, lineHeight: 1.18, fontWeight: 400,
    color: p.muted, opacity: first,
  };
  const lineTwo = {
    fontFamily: p.displayFont, fontSize: 132, lineHeight: 1.16, fontWeight: 400,
    color: p.accent, opacity: second, transform: 'translateY(' + shift + 'px)',
    marginTop: 12,
  };

  return (
    <div style={rootStyle}>
      <div style={lineOne}>{p.lineOne}</div>
      <div style={lineTwo}>{p.lineTwo}</div>
    </div>
  );
};
`;

/** Exponential curve drawn on with a stroke dash animation. */
const curveCard = `
const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;

  const enter = interpolate(frame, [0, fps * 0.4], [0, 1], { extrapolateRight: 'clamp' });
  const draw = interpolate(frame, [fps * 0.3, fps * 1.8], [0, 1], { extrapolateRight: 'clamp' });
  const dash = 1400 * (1 - draw);

  const points = [];
  for (let i = 0; i <= 40; i += 1) {
    const t = i / 40;
    const x = 120 + t * 840;
    const y = 1180 - (Math.pow(t, 3.1) * 780);
    points.push(x.toFixed(1) + ',' + y.toFixed(1));
  }
  const d = 'M' + points.join(' L');

  const rootStyle = {
    position: 'absolute', inset: 0, backgroundColor: p.bg, opacity: enter,
  };
  const labelStyle = {
    position: 'absolute', left: 120, top: 300,
    fontFamily: p.displayFont, fontSize: 96, fontWeight: 400, color: p.ink,
  };
  const axisStyle = {
    position: 'absolute', left: 120, top: 1200, width: 840, height: 4,
    backgroundColor: p.muted, opacity: 0.5,
  };
  const tickStyle = {
    position: 'absolute', left: 120, top: 1232,
    fontFamily: p.bodyFont, fontSize: 30, color: p.muted, letterSpacing: '0.2em',
  };

  return (
    <div style={rootStyle}>
      <div style={labelStyle}>{p.label}</div>
      <svg width="1080" height="1920" viewBox="0 0 1080 1920" style={{ position: 'absolute', inset: 0 }}>
        <path d={d} fill="none" stroke={p.accent} strokeWidth="10"
          strokeLinecap="round" strokeLinejoin="round" strokeDasharray="1400" strokeDashoffset={dash} />
      </svg>
      <div style={axisStyle} />
      <div style={tickStyle}>{p.axis}</div>
    </div>
  );
};
`;

const shot = (id, beatId, startFrame, endFrame, intent, code, props, box) => ({
  id,
  beatId,
  startFrame,
  endFrame,
  narration: { text: '', startMs: Math.round((startFrame / 30) * 1000), endMs: Math.round((endFrame / 30) * 1000) },
  intent,
  visual: {
    kind: 'mg-code',
    code,
    box,
    layout: { anchor: 'full', widthRatio: 1 },
  },
  _props: props,
});

const common = { bg: PALETTE.bg, ink: PALETTE.ink, muted: PALETTE.muted, accent: PALETTE.accent, displayFont: DISPLAY, bodyFont: TEXT };

const shots = [
  shot('S01', 'b1', 0, 92, '开场点题，让观众知道这条视频讲什么', titleCard,
    { ...common, title: '关于复利', kicker: 'COMPOUNDING' }, { width: W, height: H }),
  shot('S02', 'b2', 97, 240, '把抽象的 1% 变成一个具体的倍数', statCard,
    { ...common, label: '每天进步 1%', from: 1, to: 37, decimals: 0, unit: '×', foot: '一年后，你是原来的 37 倍' }, { width: W, height: H }),
  shot('S03', 'b3', 244, 367, '用对称的反例制造张力：退步也会复利', statCard,
    { ...common, accent: PALETTE.warn, label: '每天退步 1%', from: 1, to: 0.03, decimals: 2, unit: '×', foot: '一年后，几乎归零' }, { width: W, height: H }),
  shot('S04', 'b4', 369, 488, '把注意力从「利率」转到「时间」', statementCard,
    { ...common, lineOne: '复利的核心不是利率', lineTwo: '而是时间' }, { width: W, height: H }),
  shot('S05', 'b5', 500, 620, '让「指数级」变成看得见的形状', curveCard,
    { ...common, label: '优势随时间放大', axis: '时间 →' }, { width: W, height: H }),
  shot('S06', 'b5', 630, 766, '收束到一句可执行的结论', statementCard,
    { ...common, lineOne: '重要的不是一次做多少', lineTwo: '而是能不能坚持去做' }, { width: W, height: H }),
];

const beats = [
  { id: 'b1', role: 'hook', text: '关于复利', startMs: 0, endMs: 3100, shotIds: ['S01'] },
  { id: 'b2', role: 'context', text: '每天进步 1%', startMs: 3230, endMs: 8000, shotIds: ['S02'] },
  { id: 'b3', role: 'proof', text: '退步 1% 会归零', startMs: 8130, endMs: 12230, shotIds: ['S03'] },
  { id: 'b4', role: 'turn', text: '核心不是利率，是时间', startMs: 12300, endMs: 16270, shotIds: ['S04'] },
  { id: 'b5', role: 'cta', text: '坚持才是变量', startMs: 16670, endMs: 25530, shotIds: ['S05', 'S06'] },
];

// `_props` is a builder-side convenience: fold it into the mg-code visual's props.
for (const entry of shots) {
  const props = entry._props;
  delete entry._props;
  entry.visual.props = props;
}

const storyboard = {
  version: 1,
  meta: {
    title: '复利 · 25 秒口播',
    runId: 'demo-compound-interest',
    aspect: '9:16',
    width: W,
    height: H,
    fps: 30,
    language: 'zh',
  },
  rhythm: { avgShotSec: 4.2, maxShotSec: 8, grammarChangeEverySec: 6, maxRepeatRecipe: 1, hookMaxSec: 3.5 },
  audio: { assetId, src, durationFrames },
  beats,
  shots,
};

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, JSON.stringify(storyboard, null, 2), 'utf8');
console.log(`storyboard → ${outFile} (${shots.length} shots, ${durationFrames} frames)`);
