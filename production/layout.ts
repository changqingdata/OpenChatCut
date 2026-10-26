// Anchor + relative width → canvas pixels.
//
// Kept in its own module because the convention is the one piece of the
// compiler that cannot be proven by a unit test: `transform.x` / `transform.y`
// are percentages of the canvas, applied as a translation on an already
// centred layer. The arithmetic below is pinned by compile.verify.ts; whether
// it matches what the renderer draws must be confirmed with a real still frame
// once the end-to-end path exists.

import type { Anchor, LayoutSpec } from './types.ts';

export interface Rect {
  /** Canvas pixels, top-left origin. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Transform {
  scale: number;
  x: number;
  y: number;
}

const ANCHOR_FRACTION: Record<Anchor, readonly [number, number]> = {
  tl: [0, 0], tc: [0.5, 0], tr: [1, 0],
  ml: [0, 0.5], mc: [0.5, 0.5], mr: [1, 0.5],
  bl: [0, 1], bc: [0.5, 1], br: [1, 1],
  full: [0.5, 0.5],
};

const DEFAULT_INSET = 48;

export interface ResolveOptions {
  /**
   * Pixels reserved at the bottom of the canvas.
   *
   * Burned-in captions sit in a band across the bottom of the frame. Without
   * knowing that, a bottom-anchored recipe lands exactly on top of them — which
   * is what `bc` did on the first automated run: the graphic and the subtitle
   * printed over each other. The compiler passes this whenever captions are on.
   */
  bottomInset?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Resolve a layout against a canvas, given the element's natural size.
 *
 * `widthRatio` drives the width; height follows the natural aspect so a recipe
 * keeps its proportions. Edge anchors keep `safeInset` pixels of margin.
 */
export function resolveRect(
  layout: LayoutSpec,
  canvasWidth: number,
  canvasHeight: number,
  naturalWidth: number,
  naturalHeight: number,
  options: ResolveOptions = {},
): Rect {
  const inset = layout.safeInset ?? DEFAULT_INSET;
  const bottomInset = Math.max(0, options.bottomInset ?? 0);
  const ratio = clamp(layout.widthRatio, 0.05, 1);

  const width = layout.anchor === 'full' ? canvasWidth : canvasWidth * ratio;
  const height = layout.anchor === 'full'
    ? canvasHeight
    : naturalWidth > 0
      ? width * (naturalHeight / naturalWidth)
      : naturalHeight;

  const [fx, fy] = ANCHOR_FRACTION[layout.anchor];

  // `full` always fills the frame; edge anchors are clamped inward by the inset.
  let x = fx * canvasWidth - fx * width;
  let y = fy * canvasHeight - fy * height;

  if (layout.anchor !== 'full') {
    x = clamp(x, inset, Math.max(inset, canvasWidth - width - inset));
    // The vertical limit accounts for the caption band, so a bottom anchor stops
    // above it and a tall middle box is pushed up rather than clipped by it.
    const maxY = Math.max(inset, canvasHeight - bottomInset - height - inset);
    y = clamp(y, inset, maxY);
  }

  return {
    x: x + (layout.offsetX ?? 0),
    y: y + (layout.offsetY ?? 0),
    width,
    height,
  };
}

/**
 * Convert a resolved rect into the item transform the editor understands.
 *
 * Two things the renderer does that this has to account for:
 *
 * 1. The layer is **centred** in the canvas before transforms apply, so the
 *    translation is the distance between the rect centre and the canvas centre.
 * 2. A motion-graphic's natural box is **auto-fitted** to the canvas first —
 *    `ItemLayer` scales it by `min(canvasW/boxW, canvasH/boxH)` and centres the
 *    result. So `scale` must be measured against that fitted width, not against
 *    the raw box width, or a box that is already full-width would be scaled
 *    twice.
 */
export function transformFromRect(
  rect: Rect,
  canvasWidth: number,
  canvasHeight: number,
  box: { width: number; height: number },
): Transform {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const fitted = Math.min(canvasWidth / box.width, canvasHeight / box.height);
  const naturalOnCanvas = box.width * fitted;
  const scale = naturalOnCanvas > 0 ? rect.width / naturalOnCanvas : 1;
  return {
    scale: Number(scale.toFixed(4)),
    x: Number((((centerX - canvasWidth / 2) / canvasWidth) * 100).toFixed(3)),
    y: Number((((centerY - canvasHeight / 2) / canvasHeight) * 100).toFixed(3)),
  };
}
