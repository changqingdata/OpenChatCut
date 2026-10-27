---
name: occ-video
description: 用 OpenChatCut 的确定性管道把「音频 + 字幕 + 一句话主题」做成成片（竖屏 1080x1920 / 横屏 1920x1080，短片或长片）。四步主线：storyboard 生成分镜 → footage 落素材 → compile 编译进时间线 → still 回看 / render 出片。当用户要做视频、口播成片、混剪、批量出片、或想知道某条片子为什么观感不对时使用。
---

# occ-video

这条管道把一个 Storyboard IR（纯数据）编译成时间线再渲染。**分镜是唯一的人工/模型判断点**，编译是纯函数、可复现，QC 是 15 条确定性规则。所以：想改片子，改的是分镜；不要改时间线，也不要改编译结果。

所有命令都通过 `run_skill_script` 调用同一个入口 `node scripts/step.mjs`。

## 0. 每次开工先自检

```
node scripts/step.mjs doctor
```

`ok: false` 时按 `checks[].detail` 修，别硬跑。最常见的两条：

- **media-dir 不对** → 素材全 404。默认档案的素材目录是从 `process.cwd()` 推的，所以命令必须在仓库根跑；`OPENCHATCUT_DATA_DIR` 一旦被继承就会把目录指偏。`step.mjs` 已经处理，不要自己绕开。
- **keys 为空** → `--generate` 会失败。要么让用户配 `.env.local`，要么走 `--prompt` / `--from` 让外部模型写分镜（零 API 成本）。

## 1. 一条命令（首选）

音频 + 字幕 + 一句话主题 → 成片，`make` 会把下面第 2 节的所有步骤串起来，中途 QC 不过会直接停下并告诉你原因。

```
node scripts/step.mjs run --wait 60000 -- make --audio <绝对路径.mp3> --srt <绝对路径.srt> --brief 复利 --name 复利v3 --generate --size 1080x1920
```

- `--generate` 调配置好的模型；不写它只会打印提示词然后退出。
- 名字里的空格写 `%20`；路径里有空格也写 `%20`。
- 一条短片约 60–120 秒，长片 7 分钟以上。返回 `status: "running"` 就接 `status latest`：

```
node scripts/step.mjs status latest --wait 90000
```

返回里的 `artifacts` 就是成片路径，`tail` 是完整日志。**成片必须亲眼看过再交付**，用第 2 节的 `still` 或直接打开 mp4。

## 2. 分步主线（需要精细控制时）

工作目录固定是 `production/work/<工程名>/`，下面用 `w/` 代指。

**① 生成分镜**

```
node scripts/step.mjs run -- storyboard --srt <字幕文件> --brief <一句话主题> --generate --out w/storyboard.json
```

`--brief` 决定内容走向。想约束得更死，就把要求写进 brief（"讲复利，8 个镜头，不要人物出镜"）。

**② 落素材**（可选，纯图形片子跳过）

```
node scripts/step.mjs run -- footage resolve <工程名> --storyboard w/storyboard.json --out w/storyboard.footage.json
```

素材密度是算术不是判断：`targetRatio 0.34`、`minGapShots 1`、`minFrames 36`。它只接受「主体明确且 confidence 不是 low」的镜头，抽象镜头会被自动排除。跑完看 `attributions.json` 里的 `subject` 是否符合你的理解——不符合就是模型命名错了，回去改 brief。

**③ 编译进时间线**

```
node scripts/step.mjs run -- compile <工程名> --storyboard w/storyboard.footage.json --replace --apply --json
```

`--replace` 会清空时间线，**音频和音乐要在最后一次 compile 之后再放**。

**④ 回看，再出片**

```
node scripts/step.mjs run -- still <工程名> --out <绝对路径>/stills --frames 15,120,240
node scripts/step.mjs run -- render <工程名> --out <绝对路径>/final.mp4
```

静帧是唯一可靠的验收手段：配方位置、字幕压字、素材发黑、渐变层过重，全部只能看出来，读代码看不出来。

## 2. 硬规则（违反会静默出错，不报错）

1. **参数里的空格写成 `%20`。** 调用方按空白切分命令，写 `--brief 复利 的力量` 会被切成两个参数。路径不用加引号——引号会被当字面量，`step.mjs` 会剥掉，但别依赖它。
2. **不要手改 `storyboard.json`。** 生成的分镜带 `.lock.json` 记录哈希，`compile` 发现哈希不符会直接拒绝（`storyboard-edited`）。要改就带着 QC 的抱怨重跑第①步，或确实手写分镜时加 `--allow-edited`。绕过校验器的手改会让 QC 形同虚设——这是整条管道唯一的红线。
3. **`--out` 一律绝对路径。** 相对路径会让 AAC 编码延迟探测失败，报成"音频错误"。
4. **长任务不要等。** 每次调用最多 120 秒，15 分钟长片渲染约 7 分钟。`run` 会在 `--wait`（默认 45 秒）内没跑完时返回 `status: "running"`，接着调：
   ```
   node scripts/step.mjs status latest --wait 90000
   ```
   即使调用被超时杀掉，`status latest` 也能接上——运行记录落在磁盘上。
5. **不要自己设 `OPENCHATCUT_DATA_DIR` / 不要 `cd` 到别处。** `step.mjs` 已经锁定工作目录和环境。

## 3. QC 报错怎么处理

`compile` 输出里带 QC 结果。规则分三级：

- `error`（`frame-gap`）：帧不连续，**必须**修，片子会卡帧。
- `warn`：`shot-too-short`（<24 帧）、`cut-burst`（连续快切）、`recipe-repeat`（同一配方+同一锚点重复）、`footage-low-confidence`、`rhythm-flat`。这些是观感问题，值得修。
- `note`：`recipe-variety`、`anchor-under-captions`、`text-near-limit`。知道就行。

**修法只有一条**：把 QC 的具体抱怨写进 `--brief` 重跑第①步。例如"上一版 recipe-repeat 了，换用不同配方，且不要连续三个镜头都用中间锚点"。不要手动删镜头——删完节奏和字幕对位就散了。

## 4. 命令速查

| 目的 | 命令（`run --` 之后） |
| --- | --- |
| 查环境 | `doctor`（不需要 `run`） |
| 一条命令出片 | `make --audio a.mp3 --srt a.srt --brief 主题 --name 工程名 --generate` |
| 只到时间线不出片 | `make … --no-render` |
| 有哪些工程 | `run -- project list --json` |
| 新建工程 | `run -- project new <名字> --size 1920x1080` |
| 只出提示词不调模型 | `run -- storyboard --srt f.srt --brief … --prompt --json`（提示词打到 stdout，`tail` 里是完整 `{cues,system,user}`） |
| 用外部模型的分镜 | `run -- storyboard --srt f.srt --brief … --from w/reply.json --out w/sb.json` |
| 单查 QC | `run -- qc --storyboard w/sb.json --json` |
| 放音乐 | `run -- assets place <工程名> --role music --category <类目> --min-duration <秒>` |
| 历史运行 | `runs`（不需要 `run`） |

## 5. 一句话流程

```
doctor → make --generate → status latest → 看片
```

精细控制时：`storyboard --generate → footage resolve → compile --replace --apply → still 看三帧 → render`。

任何一步失败，先读 `tail` 里的结构化错误（`{code, step, cause, hint}`），`hint` 通常就是修法。
