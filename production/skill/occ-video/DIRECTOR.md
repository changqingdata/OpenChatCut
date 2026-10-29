---
name: occ-video-director
description: 用 MCP 工具逐镜导演一条视频：读 catalog 认识手段，自己写分镜，check 自检，revise 改，apply 落时间线，still 看帧，render 出片。当用户要「按我的想法做」「这一镜换掉」「画面不对」这类逐镜控制时使用，而不是只说「做个视频」。
---

# 导演路径（从零写分镜）

**先确认你不需要这条路。** 如果用户只是说“用这段音频做条讲复利的视频”，用 `SKILL.md` 的 `start`：它建工程、写分镜、出预览，你只需要看图和改那一镜。

这条路适合的情况只有两种：

- 用户要逐镜控制（“第 3 镜换成硬币”“开场别用章节卡”）
- `start` 的初稿在结构上就不对，改一镜救不回来，需要重排整条

监工路径里，管道替你写分镜，你只能改 brief。这条路相反：**分镜是你写的，管道只负责把它精确地画出来，并告诉你哪里不对。**

分工：

| 你 | 管道 |
|---|---|
| 理解内容、决定每镜要什么画面 | 素材密度、三轨编译、字幕、混音、渲染 |
| 选配方、写参数、写检索词 | 布局数学、字幕安全区、横竖屏版式 |
| 看帧、判断好不好 | 校验、QC、分数 |

**唯一不能碰的是时间线。** 轨道、item、transform 是编译产物；碰了就没有「同一份分镜重渲出同一部片」这件事了。改分镜，不改场记单。

---

## 一次完整的循环

```
1. pipeline_catalog
   → 15 个配方，每个带 jobs（能画什么）、参数名、参考帧路径
   → 只看参考帧就能判断「这个版式适合 3 个字还是 12 个字」

2. 写分镜 JSON（见下节）
   每镜：job / mustShow / intent / 配方 + 参数 / 检索词 / 时长

3. pipeline_check
   → { valid, errors, findings, score }
   → errors 是「编译不了」，findings 是「会难看」，score 是「比上版好没好」

4. 改：pipeline_revise（ops 或整份替换）
   → 它重新校验、重新加锁；不合法就不写盘

5. pipeline_apply
   → 密度 → 素材 → 三轨 → 字幕 → A1/A2/A3
   → 不渲染，便宜

6. pipeline_still --width 1080
   → 看图。字有没有压字幕、卡片有没有半屏空，只有看才知道

7. 回到 4，只改那一镜

8. pipeline_render（或 --from/--to 只渲一段）
```

第 4 步和第 7 步是这条路存在的理由：**改一镜不需要重跑模型，也不需要重渲全片。**

---

## 分镜怎么写

一份分镜就是 `{ version, meta, shots[] }`。`meta` 的 `width/height` 必须等于工程画布，否则 `apply` 会拒（`canvas-mismatch`）。

每个镜头：

```json
{
  "id": "S03",
  "startFrame": 168,
  "endFrame": 244,
  "job": "number",
  "intent": "让观众记住 37 倍这个结果",
  "narration": { "text": "一年之后是三十七倍", "startMs": 5600, "endMs": 8100 },
  "visual": {
    "kind": "mg",
    "recipe": "bar-compare",
    "params": { "leftLabel": "1x", "leftValue": "1", "rightLabel": "37x", "rightValue": "37" },
    "layout": { "anchor": "mc", "widthRatio": 0.85 }
  },
  "underlay": { "subject": "硬币堆", "query": "stacked coins tall pile close up macro", "confidence": "high" },
  "background": "#0B0B0C"
}
```

几条硬规则：

- **`startFrame` 是切点。** `endFrame` 由下一镜的 `startFrame` 推出（`revise` 会重算），所以只要保证起点连续、第一镜从 0 开始。
- **`job` 决定选哪个配方。** 取值：`thing` / `relation` / `number` / `process` / `quote` / `attention`。配方的 `jobs` 列表是它的能力边界；写错了 `check` 会报 `job-mismatch`。
- **卡片写关键词，不复读字幕。** 字幕会把整句念出来，卡片再写同一句就是结巴（`text-echoes-caption`）。
- **检索词描述画面，不描述意思。** 物件 + 场景/动作 + 景别或光线，2–6 个英文词。抽象句子不要写检索词——写了会拿到一张无关的图库图。
- **素材密度不是你的决定。** 你提议 query，管道按 `targetRatio 0.34 / minGapShots 1` 决定谁真的上素材。写满 8 个 query 不会得到 8 段素材。
- **底部 16% 是字幕带。** 不要用 `bl` / `bc` / `br`，布局会被顶上去。

---

## 参考帧

`catalog` 返回的 `still` 是每个配方在 1920×1080 下的真实渲染。**先看图再选配方**——参数 schema 只告诉你「有 maxChars」，图告诉你「这个版式三个字才好看」。

参考帧由 `node production/catalog/build.mjs` 生成，配方改了要重跑。

---

## 失败怎么读

| 信号 | 意思 | 怎么办 |
|---|---|---|
| `check` 返回 `valid: false` | 编译不了（帧有洞、参数超限、画布不符） | 按 `errors` 逐条改，`revise` 会拒收 |
| `findings` 里有 `error` | 片子是坏的 | 必须修，别渲 |
| `findings` 里有 `warn` | 会难看 | 值得修，但能出 |
| `storyboard-edited` | 手改过分镜，没经过校验 | 用 `revise` 重新写入，或确认后加 `--allow-edited` |
| `canvas-mismatch` | 分镜画布 ≠ 工程画布 | 分镜要按目标工程写，`apply` 不会替你改尺寸 |
| `job-mismatch` | 配方画不了这一镜要的东西 | 换配方，或改 `job` |

---

## 不要做的事

- **不要为了「多样性」硬凑配方。** 没有对比的句子用 `compare-stack` 比单调更难看。
- **不要用 `still` 的默认宽度判断字。** 默认 480–640，够看版式，不够看字号；要看字给 `--width 1080`。
- **不要在一轮里改十镜。** 改一镜、看一帧、再改下一镜，比一次改完再渲便宜一个数量级。
- **不要指望 `render` 全片来验收。** `still` 两秒一张，全片渲染一分钟起。
