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
| QC | not started |

## Three lanes

A shot is not one picture. It is a stack:

```
V3  graphics   recipes and text — always
V2  scrim      a dark wash, only over footage, so white type stays readable
V1  base       footage or a solid card
```

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
