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
