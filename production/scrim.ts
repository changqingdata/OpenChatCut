// The wash over footage.
//
// A flat scrim is the wrong shape for the job. Text does not sit everywhere on
// the frame — it clusters at the top (recipe overlays) and at the bottom (the
// burned-in captions) — while the middle is where the picture actually gets
// looked at. A uniform wash therefore has to be dark enough for the worst case,
// which means it dims the part of the clip nobody needed protecting.
//
// A vertical gradient spends the darkness where the text is and leaves the
// middle alone: heavy at both edges, light through the centre.
//
// It has to be a motion graphic rather than a `solid` item, because `solid`
// paints one colour. The item is sized to the canvas so it needs no transform.

import type { TimelineItem } from '../src/editor/clipTypes.ts';

/**
 * Opacity at the four stops, top to bottom.
 *
 * The middle value is the one to be careful with: too low and a recipe's small
 * label disappears over a bright clip, too high and the footage stops reading as
 * footage. 0.24 is the point where a white number still holds on a white-ish
 * frame without the picture going grey.
 */
export const SCRIM_STOPS = { top: 0.55, mid: 0.24, bottom: 0.68 } as const;

/**
 * Inline template for the wash.
 *
 * Written as a string because the compiler inlines motion-graphic source into
 * the item; the renderer compiles it the same way it compiles a recipe. Plain
 * string concatenation, not template interpolation — a `${` here would be
 * resolved by the compiler at build time, not by the renderer.
 */
export const SCRIM_CODE = [
  'const Component = ({ item }) => {',
  '  const p = item.props;',
  '  const wash = (v) => "rgba(11,11,12," + v + ")";',
  '  const background = "linear-gradient(180deg, "',
  '    + wash(p.top) + " 0%, "',
  '    + wash(p.mid) + " 32%, "',
  '    + wash(p.mid) + " 64%, "',
  '    + wash(p.bottom) + " 100%)";',
  '  return <div style={{ position: "absolute", inset: 0, background }} />;',
  '};',
].join('\n');

export function buildScrimItem(
  shot: { id: string; startFrame: number; endFrame: number },
  canvas: { width: number; height: number },
  track: string,
  stops: { top: number; mid: number; bottom: number } = SCRIM_STOPS,
): TimelineItem {
  return {
    id: `it-scrim-${shot.id}`,
    kind: 'motion-graphic',
    track,
    startFrame: shot.startFrame,
    durationInFrames: shot.endFrame - shot.startFrame,
    name: `${shot.id} scrim`,
    code: SCRIM_CODE,
    props: { ...stops },
    width: canvas.width,
    height: canvas.height,
  };
}
