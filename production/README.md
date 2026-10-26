# production/

The production layer: everything this fork adds on top of OpenChatCut. Nothing
here is imported by the upstream app at runtime, and nothing here modifies
upstream files. That separation is what keeps `git rebase upstream/main` cheap.

```
types.ts            Storyboard IR — the only input the pipeline accepts
validate.ts         pre-compile checks; rejects a bad storyboard before it touches a project
layout.ts           anchor + widthRatio → canvas rect → item transform
compile.ts          Storyboard → ProjectDoc (pure, deterministic)
compile.verify.ts   contract test for the above
recipes/            parameterized motion-graphic sources
work/               runtime output per run (gitignored, never committed)
tsconfig.json       standalone type-check config for this directory
```

## Rules

1. **No Node-only code in `src/`.** `src/` is bundled by Vite; `fs`, `path`,
   and `child_process` there break the build. This directory runs through `tsx`
   and is never bundled.
2. **Import upstream modules; never edit them from here.** If a change to
   upstream is unavoidable, record it in `../PATCHES.md`.
3. **Type-only imports.** `import type { ProjectDoc } from '../src/editor/projectTypes.ts'`
   keeps the dependency at compile time. Import from the specific module, not
   from `src/editor/types.ts` — that barrel drags in the React tree.
4. **Compile is pure.** No network, no filesystem, no clock, no randomness.
   Same storyboard in, byte-identical ProjectDoc out.

## Commands

```bash
npx tsx production/compile.verify.ts     # contract test
npx tsc -p production                     # type-check this directory only
```

`npm run lint` covers this directory too, since oxlint scans the repository.

## Status

| Piece | State |
|---|---|
| IR types | done — `solid`, `text`, `mg`, `mg-code` as `visual`; footage as `underlay` |
| Validation | done — frame ranges, beats, intents, layout bounds, unresolved footage |
| Layout | done — anchored placement, **verified against rendered frames**, pinned by a nine-anchor table |
| Compiler | `solid` / `text` / `mg-code` / `mg` (with a registry) |
| Compiler | footage + scrim + graphics on three lanes (V1 / V2 / V3) |
| Recipes | 8, with schema validation and param checking |
| Material | private audio (music, SFX), Pexels, Pixabay |
| Footage density | policy module — ratio, spacing, essentials; retunable without a model call |
| CLI | `occ storyboard`, `occ footage resolve`, `occ compile`, `occ still`, `occ assets`, `occ render` |
| Storyboard generation | done — chapters, repair, footage intent |
| QC | `production/qc.ts` — nine rules, run by `occ qc` and after every generation |

## Three lanes

A shot is not one picture. It is a stack:

```
V3  graphics   recipes and text — always
V2  scrim      a vertical gradient, only over footage
V1  base       footage or a solid card
```

The wash is a gradient rather than a flat block because text does not sit
everywhere: it clusters at the top (overlays) and the bottom (captions), while
the middle is where the picture is actually looked at. Heavy at both edges, light
through the centre — `production/scrim.ts`.

Bottom-anchored recipes are held above the caption band (16% of canvas height) by
`layout.ts`, which the compiler enables whenever captions are on. Without it a
`bc` recipe prints straight over the subtitle.

The wash flattens on a wide canvas (`scrimStopsFor`). The gradient assumes the
type sits at the top and the captions at the bottom, leaving a quiet centre; on
16:9 the graphic is a band across the centre, so the centre *is* the text zone and
has to be washed harder.

## QC

`production/qc.ts` is arithmetic over the IR — no model, no network, no render. A
check that costs money will not be run on every generation, and a check that
cannot be reproduced cannot be trusted.

| Code | Severity | Fires when |
|---|---|---|
| `frame-gap` | error | a shot leaves frames uncovered — renders as black |
| `shot-too-short` | warn | a shot is under 1.2s |
| `cut-burst` | warn | more than 4 cuts inside 6s |
| `recipe-repeat` | warn | 3 consecutive shots use one recipe |
| `recipe-dominance` | warn | one recipe is over 45% of a 6+ shot video |
| `recipe-variety` | note | fewer than 4 recipes across 8+ shots |
| `footage-adjacent` | warn | two footage shots in a row |
| `footage-duplicate-clip` | warn | the same asset used twice |
| `footage-duplicate-query` | note | the same search used twice |
| `anchor-under-captions` | note | a card asks for a bottom anchor |
| `text-near-limit` | note | a long text field is within 15% of its limit |

Severity is a claim about consequence: `error` means the video is broken, `warn`
means it will look wrong, `note` means worth knowing.

Run on the 15-minute storyboard it reported exactly what a manual review had
found — `keyword-punch` at 49% of 259 shots, three separate runs of three
consecutive repeats, and ten cards anchored under the captions.

```
occ qc --storyboard sb.json [--strict] [--json]
```

`occ storyboard --generate` runs it automatically and fails on errors;
`make-video.mjs` runs it before the compile so a broken storyboard fails in a
second rather than after a two-minute render.

## Canvas shapes

Portrait and landscape both work, with three rules that differ:

| | Portrait 1080×1920 | Landscape 1920×1080 |
|---|---|---|
| recipe width | `widthRatio × width` | capped by the height left after the caption band |
| wash | gradient, mid 0.24 | flatter, mid 0.42 |
| footage search | `9:16` | `16:9`, derived from the canvas |

`widthRatio` is a share of the width, which breaks on 16:9: 0.85 of 1920 is 1632px
and a 900×520 recipe at that width is 943px tall — taller than the 811 the frame
leaves. The cap keeps the box inside both side margins; on portrait it never
binds.

Graphics always go to V3 rather than V2. If the scrim shared V2 with them the
two would fight for one lane, and a shot that gained footage later would silently
move its recipe to a different track.

`Shot.underlay` carries footage; `Shot.visual` carries graphics. Either can be
absent — footage alone is a legitimate transition shot, and graphics alone is the
card the first eight recipes were built for.

## The layout maths was confirmed by rendering `bl` and `tr` placements and checking
the box edges land at the expected pixel positions. Two corrections came out of
that pass:

- A motion-graphic's natural box is auto-fitted to the canvas width before the
  item transform applies, so `scale` is measured against the **fitted** width.
  Measuring against the raw box scaled full-width boxes twice.
- Edge anchors clamp to the safe inset on the anchored side, so a box wider than
  the canvas minus two insets falls back to the left inset instead of overflowing.
