# agent 优先的管道改造方案

状态：**Phase 0–3 已实施**（`dev`）。基线 `062e37e7`，备份分支 `snapshot/pre-agent-pipeline`。

前提：视频制作的主力驱动者是一个外部 agent（自带推理、代码、生图、看图能力，能自我批判）。
本文只回答一个问题：**在这个前提下，管道该留什么、砍什么、补什么。**

---

## 一、审查结论

### 1.1 现在有两条通道，能力不对等

| | MCP（`occ mcp`） | skill（`occ-video`） |
|---|---|---|
| 服务对象 | 外部 agent | 内置 agent（`run_skill_script`） |
| 工具数 | 3（config / qc / run） | 12 个动作 + 宿主工具 |
| 能停在中途 | 否，`pipeline_run` 一口气跑完 | 是，分步主线 |
| 分镜锁 | **无** | 有（`.lock.json` + `storyboard-edited`） |
| 看画面 | 无 | `view_timeline_frames`（需用户先打开工程） |
| 环境自检 | 无 | `doctor` |

结论：**能力强的通道绑死在宿主 API 上（`run_skill_script` / `read_project` / `target_project`），外部 agent 用不了；能力弱的通道恰好是外部 agent 唯一能用的。**

### 1.2 红线只存在于一半通道上

`storyboard-edited` 的实现全部在 `production/skill-host/`：

- `step.mjs:123` 校验 hash
- `_child.mjs:50` 生成锁

`cli/commands/compile.ts` 不检查锁，MCP 走 `make-video → occ compile`，**因此 MCP 通道上手改分镜不会被拒**。

这不是设计取舍，是两条通道各自演化造成的遗漏。而且它恰好挡住了导演模式最需要的动作。

### 1.3 SKILL.md 的核心指令与导演模式冲突

原文（第 127 行）：

> **不要手改 `storyboard.json`。** … 要改就带着 QC 的抱怨重跑第①步

第 145 行：

> **修法只有一条**：把 QC 的具体抱怨写进 `--brief` 重跑

这是**监工模式**的教条：agent 只能提要求，不能改结果。导演模式要的正好相反——**改分镜是主要动作，brief 只是起点**。

只要这份文档不拆，外部 agent 读了就会自我限制在监工模式。

### 1.4 静帧的服务对象错位

`remotion/render.mjs:423`：

```js
scale: (list.length > 6 ? 480 : 640) / composition.width
```

固定 480/640 宽，且 `occ still` 没有 `--width`。这是为**内置 agent** 设计的——它根本看不见图，静帧只是写给用户看的，所以要省流量。

外部 agent 能读图。480 够看版式，不够看字；而"字有没有被压到"恰恰是最常见的错误。

### 1.5 单镜重渲已经存在（上一轮判断有误）

`occ render --from <frame> --to <frame>` 已在 `cli/commands/render.ts` 的 FLAGS 里，`frameRange` 一路传到 `renderTimeline`。

不需要新做，只需要在 MCP 层暴露。我上一轮说"这是我最想要的"，是没查证。

### 1.6 没有 catalog

15 个配方的用途、参数、字数上限，现在只存在于两处：`schema.json`（机器可读）和 `generate.ts` 的规则 8（自然语言）。**外部 agent 两处都拿不到**——它不会去读仓库里的 JSON。

`production/recipes/gallery.mjs` 已经能生成 15 个配方的参考帧，但没有接进任何工具。

### 1.7 配方没有能力声明

`schema.json` 有 `box` / `params` / `sfx`，没有"这个配方适合什么类型的镜头"。所以无法回答"这镜的 `job` 是展示过程，哪个配方能表达过程"，也无法在 QC 里查"选错实现器"。

### 1.8 没有风格字段

`meta` 里没有 `style`。风格目前散落在：配方默认色、`scrim` 的渐变停靠点、字幕模板。skill 里写"克制、深色、金融感"，**没有任何东西会执行它**。

---

## 二、三条路线

| | A 只留 skill | B 双通道补强 | C 单一 MCP 面 + 瘦管道 |
|---|---|---|---|
| 删掉 | compile / qc / validate | 不删 | `generate.ts`、`make-video` 的编排 |
| agent 产出 | 直接写 Remotion 代码 | 分镜（受锁限制） | 分镜（可自由编辑） |
| 可复现 | ✗ 每条片子是一次性代码 | ✓ | ✓ |
| 自检裁判 | ✗ 自己评自己 | ✓ | ✓ |
| 配方复用 | ✗ 每条重写 | ✓ | ✓ |
| 文档 | 1 份 | 2 份，会漂 | 1 份 |
| 主要风险 | 退化成一次性生成器 | 两套能力长期不同步 | 迁移期两条路径并存 |

**推荐 C。** A 的问题不是"代码少"，是删掉了裁判（详见上一轮讨论：删掉 `qc.ts`，agent 就永远觉得自己对）。B 的问题是现状已经证明会漂——锁只在一半通道上就是漂的结果。

C 的本质：**一条通道、一个契约、一套裁判。** skill 不再是独立实现，而是 MCP 的薄适配层（或者直接废弃）。

---

## 三、推荐架构

### 3.1 原则

> **暴露 IR，不要暴露时间线。**

| agent 可以精细编辑 | agent 不能碰 |
|---|---|
| 分镜（镜头、配方、参数、检索词、时长、转场） | 时间线（轨道、item、transform） |

前者是创作，后者是编译产物。一旦 agent 开始往轨道上摆片段，"可复现"和"可重编"同时消失。

### 3.2 工具面（实施后 10 个）

| 工具 | 输入 | 输出 | 为什么需要 |
|---|---|---|---|
| `start` | audio / srt / brief / name / size / preview | 工程 + 分镜 + 时间线 + **预览帧** + findings + score | 一句话入口。没有它，"给我看一版"要先渲全片 |
| `catalog` | — / `--recipe` / `--size` | 配方（jobs / 参数 / 参考帧）、**分镜 shape 与 rules**、画布、策略、音乐类目 | agent 只会用它认识的配方；不给 shape 就只能猜字段名 |
| `check` | storyboard | `{valid, errors, findings, score}` | 裁判必须一次给全，否则 agent 只跑它记得的那个 |
| `apply` | storyboard / audio | 时间线（含字幕、A1/A2/A3），**不渲染** | 给"改剧本"和"出片"之间的便宜中点 |
| `revise` | storyboard / 编辑操作 | 新分镜 + 重新加锁 | 手改 JSON 容易破坏 `frame-gap`，要等 QC 才暴露 |
| `still` | project / frames / **width** | 图片路径列表 | agent 的眼睛。默认 640，允许 1080 看字 |
| `render` | project / out / **from-to** | mp4 | 单镜预览已有能力，只需暴露 |
| `run` | audio / srt / brief / name | mp4 | 不看直接出片；`start` 去掉预览加上渲染 |
| `qc` / `config` | — | — | 兼容与排障 |

原计划的 `draft` 没有单独做，它变成了 `start` 的前半段：草稿分镜只有在**配上预览帧**时才有用，单独返回一份 JSON 不解决"人没法看"的问题。

### 3.3 锁的语义要改

现在：锁 = 禁止编辑。
应该：锁 = 禁止**未经校验的**编辑。

```
生成 → 带 hash
手改 → hash 不符 → compile 拒绝（storyboard-edited）
revise 编辑 → 重新校验 → 重算 hash → 放行
手改 + --allow-edited → 放行，但 check 标记 unverified-edit
```

这样红线还在（没有未校验的编辑进渲染），但导演模式能工作。

**同时把校验从 `skill-host` 下沉到 `cli/commands/compile.ts`**，两条通道才有同一套规则。

### 3.4 配方加能力声明

`schema.json` 增加：

```json
"jobs": ["number", "relation"]
```

取值与导演层的 `job` 对齐：`thing` / `relation` / `number` / `process` / `quote` / `attention`。

`catalog` 暴露它；`check` 增加 `job-mismatch`（shot 有 `job` 而配方不支持 → warn）。

这是"实现器能力"的最小落地，纯查表，零成本，能立刻抓到"用 compare-stack 讲一句没有对比的话"。

### 3.5 风格字段

`meta.style: { palette?, mood?, fontPair?, grain? }`。

第一阶段**只存不读**也算完成——先让字段存在，后续三处（配方默认色、素材检索色偏、字幕模板）再逐个接。

---

## 四、分阶段计划

每个阶段独立可回滚，且都有可验证的产出。

**实施结果（实测）：**

| 指标 | 改造前 | 改造后 |
|---|---|---|
| 改一镜到看到帧 | 改 brief 重跑模型 ~40s + 全片渲染 ~80s ≈ 2 分钟 | `revise` 1s + `apply` 4s + `still` 13s ≈ **18 秒** |
| 单镜预览 | 只能全片渲染 | `render --from/--to`，76 帧 ≈ 22s |
| 一次自检 | 需要跑 qc + 自己算分数 | `check` 1s，三样一起给 |
| 手改分镜 | MCP 通道不拦（红线只在 skill 通道） | 两条通道都拦，`revise` 是唯一合法入口 |

**没达到预期的：** 方案里写「单镜迭代 <10 秒」，实测 13 秒。瓶颈不在渲染，在**每个 CLI 进程都要重新 webpack 打包一次**（`getServeUrl` 的缓存是进程级的）。要压到 3 秒，需要让 MCP 服务进程内复用打包结果——那要求把 stdout 在命令调用期间接管，风险高于收益，暂不做。

**已交付：**

- `production/storyboard-lock.ts` + `requireStoryboardLock` —— 锁下沉到 CLI，`compile` / `qc` / `check` 都拦；`storyboard` / `footage` 命令自己写锁
- `occ catalog [--recipe] [--full]` + `production/catalog/stills/*.jpg`（15 张，960px）
- 15 个配方 schema 的 `jobs` 能力声明；QC 新增 `job-mismatch`
- `occ check`（校验 + QC + 分数，一次给全）
- `occ apply`（密度 → 素材 → 编译 → 字幕 → A1/A2/A3，不渲染）
- `occ revise`（set / recipe / layout / retime / remove，自动重算覆盖并重新加锁）
- `still --width`；`render --from/--to` 暴露到 MCP
- MCP 3 → 9 个工具；`make-video` 428 → 338 行，编排改为调用 `apply`

### Phase 0 · 一致性修复（0.5 天）

| 动作 | 文件 |
|---|---|
| 锁下沉到 CLI | `cli/commands/compile.ts`、`production/skill-host/*` 改为复用 |
| `still --width` | `cli/commands/still.ts`、`remotion/render.mjs` |
| SKILL.md 拆成两份：`director` / `supervisor` | `production/skill/occ-video/SKILL.md` |

**验收**：MCP 通道手改分镜会被拒；`still --width 1080` 出 1080 宽图。

### Phase 1 · catalog（1–2 天）

- `gallery.mjs` 产出参考帧到 `production/catalog/stills/<recipe>.jpg`
- 新增 `occ catalog --json`：recipes + schema + still 路径 + policy 常量 + 音乐类目
- MCP 暴露

**验收**：只读 `catalog` 的 agent 能为一句话选出 ≥3 个候选配方并说明理由（人工判断）；`catalog` 返回体 < 8KB。

### Phase 2 · check 三合一（1–2 天）

- `occ check --storyboard` → `{valid, errors, findings, score}`
- `score.mjs` 的逻辑改为可被 CLI 调用（保留独立脚本）

**验收**：对 `复利横屏v4` 一次调用能复现 8 镜 / 8 配方 / 2 条 note / score 八列。

### Phase 3 · apply + revise + run --until（2–3 天）

- `occ apply`：从 `make-video` 抽出 compile + captions + A1/A2/A3
- `occ revise`：受约束编辑 + 重新加锁
- `make-video` 退化为 `apply + render` 的薄壳，或废弃

**验收**：`apply` 产出的时间线 item 数与 `make-video` 完全一致（复利v4 为 25 项：V1×8 / V2×2 / V3×10 / A1×1 / A2×1 / A3×3）。

### Phase 4 · draft 与 style（评估后再做）

- `draft` 复用 `generate.ts`，输出标注 `"draft": true`
- `meta.style` 只存不读

**验收**：`draft` 与 agent 手写分镜在同一语料上的 score 差距，决定是否值得保留。

---

## 五、不做什么

- **不让 agent 直接写整片 Remotion 代码。** 单镜 `mg-code` 可以，整片不行——那等于放弃可复现。
- **不做 AI 生图/生视频。** 先留 `meta.style` 字段，等 catalog 和 check 稳定。
- **不做自动修复回路。** 修复由 agent 决策，管道只提供判据。
- **不动 compile 的确定性。** 同分镜同结果这条是全部能力的地基。
- **不做"agent 编排节奏"。** 节奏是算术（时长、字幕带、音效预算、音乐拼接），让模型编排就失去可复现。

---

## 六、需要拍板

1. **skill 与 MCP 合并成一条通道？** 推荐合并，skill 只做 MCP 的薄适配。代价：内置 agent 的 `view_timeline_frames` 能力要另找路径。
2. **`generate.ts` 保留为 `draft` 还是彻底删？** 推荐保留为默认关闭的草稿器。代价：两套质量路径长期并存。
3. **锁改成"未校验编辑"语义可接受？** 推荐接受，否则导演模式无法工作。
4. **参考帧什么时候生成？** 构建时（跟着代码走）还是首次调用时（跟着环境走）。推荐构建时，因为配方变更本来就该重出参考帧。
