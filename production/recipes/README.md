# recipes/

Parameterized motion-graphic sources. One directory per recipe:

```
recipes/stat-impact/
├── index.jsx      the Remotion component, plain JS/JSX, no imports
├── schema.json    id, display name, natural box, editable params
└── thumb.png      optional preview for the editor
```

`index.jsx` follows the same code contract as hand-authored motion graphics in
OpenChatCut (`src/agent/skills/create-motion-graphics/SKILL.md`). The parts that
matter most:

- No `import` statements. `React`, `useCurrentFrame`, `useVideoConfig`,
  `interpolate`, `interpolateColors`, `spring`, `Easing`, `random`,
  `AbsoluteFill`, `Sequence`, `Img`, `Video`, `Audio`, `staticFile` are injected.
- No `Remotion.xxx` access; hooks are standalone globals.
- Define `const Component = ({ item }) => …`; no `export default`.
- Root element is `<div style={rootStyle}>` with `position: absolute; inset: 0`.
- Read every visible value from `item.props`. Never hardcode text or colour.
- Guard `<Img>` / `<Video>` against empty sources.
- Use only fonts returned by `search_fonts`; local system fonts fall back at
  render time.

`schema.json` shape:

```json
{
  "id": "stat-impact",
  "name": "数字冲击",
  "box": { "width": 720, "height": 420 },
  "params": {
    "value": { "type": "number", "required": true },
    "unit":  { "type": "string", "default": "%" },
    "label": { "type": "string", "required": true, "maxChars": 12 },
    "accent": { "type": "color", "default": "#ff5a1f" }
  }
}
```

The compiler reads `box` for placement and merges `params` defaults under the
shot's own values.

## One source, two consumers

The same directory serves both surfaces:

| Consumer | How it reads the recipe |
|---|---|
| The editor, for manual placement | Packaged as an `openchatcut-plugin@1` pack (`src/plugins/types.ts`) — an MG entry is `code` + `props`, exactly this shape |
| The compiler, for automatic placement | Reads `index.jsx` and inlines it as `item.code` |

Because the compiler inlines `code` rather than looking it up, recipes work in
headless runs even though plugin packs are absent from the offline catalog
(`server/external-agent/offline-catalogs.ts`).

## Budget

`openchatcut-plugin@1` caps a pack at 64 items, 256 KB per code blob, and 12
editable props per item. Stay inside those limits so a recipe set can ship as a
pack without being split.

## Do not start here

Build one recipe, render a still, and confirm the placement maths before
authoring a set. A wrong layout convention would have to be fixed in every
recipe at once.

---

## Registry

Recipes are loaded by `production/recipes/load.ts`, which reads every
subdirectory holding `schema.json` + `index.jsx`. `occ compile` calls
`checkParams` for each `mg` shot before compiling, so a wrong param name or an
over-long string fails with the shot id and field name instead of rendering as a
silent default.

## Current

| Recipe | Box | Use | Covers |
|---|---|---|---|
| `keyword-punch` | 900×520 | 关键词砸在画面上，用于转折或结论 | 单句断言 |
| `number-count` | 900×520 | 数字从起点滚到终点 | 比例、倍数、金额 |
| `list-reveal` | 900×760 | 2–4 条要点逐条推出 | 步骤、理由、并列 |
| `compare-stack` | 960×820 | 上下一组对照 | 前后、对错、表里 |
| `quote-card` | 900×700 | 慢下来的一句话，动作小、停留久 | 引用、格言、金句 |
| `progress-bar` | 900×420 | 用长度表示比例，数字与条形同步 | 完成度、占比、达成率 |
| `timeline-dots` | 960×420 | 把过程摊成阶段并指出当前在哪 | 步骤、演进、阶段 |
| `big-word-fill` | 1080×1920 | 一个字占满画面，全片最强的一次冲击 | 单点强调（一条视频最多一次） |
| `line-chart` | 900×560 | 折线自绘，末端标出终值 | 趋势、增长、衰减 |
| `bar-compare` | 900×520 | 两条并排比长度，比例即结论 | 倍数、落差、A 是 B 的几倍 |
| `icon-row` | 960×520 | 2–4 项并列，每项一个图标 | 要素、特征、条件 |
| `chapter-card` | 1080×1920 | 章节分隔卡，序号 + 标题 | 长视频的导航 |

Twelve recipes cover the shapes a spoken-word video needs: a claim, a number, a
list, a contrast, a pause, a proportion, a sequence, a single hit, a trend, a
ratio, a set of parts, and a chapter break.

`chapter-card` and `big-word-fill` are full-frame (box = canvas), so the footage
policy never puts a clip under them — it would be invisible.

Eight is the working minimum for a long video: a 15-minute talk produced 259
shots, and with four recipes the most common one took 49% of them. The four
added here cover the shapes the first four could not: a pause, a length, a
sequence, and a single hit.

## Overlays, not cards

A recipe paints only its own box, so on a bare timeline it floats over
transparency. A shot that should read as a full-frame card sets
`shot.background`; the compiler then emits a `solid` item underneath and moves
the visual to the overlay track. Keep the background at the shot level rather
than inside the recipe — the same recipe should be able to sit on footage as
easily as on a flat colour.
