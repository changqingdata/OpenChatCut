export interface PropSpec {
  key: string;
  type: string;
  defaultValue: unknown;
  /** Optional display label (falls back to key). */
  label?: string;
  /** For type=select: option values or {label,value} rows. */
  options?: Array<string | { label: string; value: string }>;
  /** For type=number: soft range hints. */
  min?: number;
  max?: number;
  step?: number;
  /**
   * For type=text: how many characters the layout was designed for.
   *
   * Advisory in the inspector (it does not truncate) and authoritative in QC,
   * where `text-near-limit` uses it to predict an overflow before anyone renders
   * a frame. Only recipes that declare it get the check — an unknown limit is
   * not a zero limit.
   */
  maxLength?: number;
  /** For type=array: how many entries, and how long each may be. */
  maxItems?: number;
  itemMaxLength?: number;
}

export interface Tpl {
  id: string;
  name: string;
  category: string;
  /** Optional template-level description. */
  description?: string;
  /** Optional catalog tags. */
  tags?: string[];
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  props: Record<string, unknown>;
  propSchema: PropSpec[];
  thumb: string | null;
  code: string;

  /**
   * How this template expects to occupy the frame.
   *
   * `scene` (the default, and what all 235 upstream templates are) is a
   * composition that fills the canvas: 1920×1080 or 1080×1920, authored at that
   * size, dropped in and left alone.
   *
   * `card` is a design unit — 900×520, 960×460 — that the compiler places with
   * an anchor and a width ratio, on top of footage, clearing the caption band.
   * A card is *not* a scene that happens to be small: dropping one in unscaled
   * makes the fit maths blow it up to nearly full frame (min(1920/900,
   * 1080/520) = 2.08), which is why the placement layer checks this field.
   */
  kind?: 'scene' | 'card';
  /** A card's design box; equals width/height, kept explicit for the compiler. */
  box?: { width: number; height: number };
  /** A card's alternate design box for a landscape canvas. */
  landscapeBox?: { width: number; height: number };
  /** True when the card owns the whole frame instead of sitting on it. */
  fullFrame?: boolean;
  /**
   * What kind of shot this template can carry: `thing` / `relation` / `number` /
   * `process` / `quote` / `attention`. Unknown when absent — and unknown is not
   * a mismatch, so QC stays quiet rather than guessing.
   */
  jobs?: string[];
  /** Sound effect this template earns, placed by the pipeline. */
  sfx?: { category: string; query?: string; volume?: number };
}
