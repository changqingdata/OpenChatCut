// What a recipe is, as data — the half that has no filesystem in it.
//
// Split out of `production/recipes/load.ts` when the core moved into `src/`:
// the compiler and QC need these types and the two pure helpers, and neither of
// them may reach for `fs`. The loader still lives outside `src/` because reading
// `index.jsx` off disk is a build/CLI concern, not a runtime one.

export interface RecipeParam {
  type: 'string' | 'number' | 'color' | 'font' | 'enum' | 'array';
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  maxChars?: number;
  /** `array` only: how many entries are allowed. */
  maxItems?: number;
  /** `array` only: per-entry character limit. */
  itemMaxChars?: number;
  values?: string[];
  description?: string;
}

export interface RecipeSchema {
  id: string;
  name: string;
  nameEn?: string;
  intent?: string;
  box: { width: number; height: number };
  /**
   * True when the recipe owns the whole frame (a background plus one idea).
   * The compiler then hands it the canvas instead of a card rect, so it has no
   * anchor to get wrong and no portrait box to be squeezed into.
   */
  fullFrame?: boolean;
  /** Design box for a landscape canvas; the component lays itself out for it. */
  landscapeBox?: { width: number; height: number };
  /**
   * What kind of shot this recipe can carry: `thing` / `relation` / `number` /
   * `process` / `quote` / `attention`.
   *
   * The director writes a `job` per shot; this is the other half of that
   * contract. Without it there is no way to tell "this recipe does not do that"
   * from "this recipe does it badly", which is exactly the mistake that put a
   * compare-stack on a sentence with nothing to compare.
   */
  jobs?: string[];
  /**
   * Optional sound effect this recipe earns. Placement is decided by the
   * pipeline, not here — a recipe only says what would suit it.
   */
  sfx?: { category: string; query?: string; volume?: number };
  params: Record<string, RecipeParam>;
}

/** A recipe ready to compile: schema defaults already resolved, code inlined. */
export interface Recipe {
  id: string;
  /** Remotion component source, inlined into the item. */
  code: string;
  /** Natural design box; placement scales this onto the canvas. */
  box: { width: number; height: number };
  /**
   * The recipe *is* the frame — a background plus one idea, nothing to place
   * beside it. Its design box is therefore the canvas, not a card: forcing it
   * through `resolveRect` on a landscape canvas turns a portrait box into a
   * 456×811 stamp floating in the middle of 1920×1080, which is what
   * `big-word-fill` did on the first 16:9 run.
   *
   * Components marked this way must size their internals from `item.width`
   * rather than from the box they were designed at.
   */
  fullFrame?: boolean;
  /**
   * Design box to use when the canvas is wider than tall.
   *
   * A recipe's box is its design unit: the layout is authored at that size and
   * scaled onto the canvas. A vertical stack authored at 960×820 can only ever
   * be a column — on 1920×1080 the height cap shrinks it to ~950px and half the
   * frame stays empty. Giving it a wide box and a wide arrangement inside is the
   * difference between "a portrait card on a landscape screen" and a layout.
   */
  landscapeBox?: { width: number; height: number };
  defaultProps?: Record<string, unknown>;
}

export type RecipeRegistry = ReadonlyMap<string, Recipe>;

/** Defaults declared in the schema, ready to merge under a shot's own params. */
export function schemaDefaults(schema: RecipeSchema): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [key, param] of Object.entries(schema.params)) {
    if (param.default !== undefined) defaults[key] = param.default;
  }
  return defaults;
}

/**
 * Validate a shot's params against the schema.
 *
 * Returns the merged params, or the list of problems. Unknown keys are reported
 * rather than silently dropped — a typo in a storyboard should not render as a
 * default value nobody notices.
 */
export function checkParams(
  schema: RecipeSchema,
  params: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const merged = { ...schemaDefaults(schema), ...params };

  for (const key of Object.keys(params)) {
    if (!(key in schema.params)) errors.push(`unknown param "${key}"`);
  }
  for (const [key, param] of Object.entries(schema.params)) {
    const value = merged[key];
    if (value === undefined || value === '') {
      if (param.required) errors.push(`missing required param "${key}"`);
      continue;
    }
    if (param.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`"${key}" must be a number`);
      else if (param.min !== undefined && value < param.min) errors.push(`"${key}" below min ${param.min}`);
      else if (param.max !== undefined && value > param.max) errors.push(`"${key}" above max ${param.max}`);
    } else if (param.type === 'enum') {
      if (param.values && !param.values.includes(String(value))) {
        errors.push(`"${key}" must be one of ${param.values.join(', ')}`);
      }
    } else if (param.type === 'array') {
      if (!Array.isArray(value)) {
        errors.push(`"${key}" must be an array of strings`);
      } else if (param.maxItems !== undefined && value.length > param.maxItems) {
        errors.push(`"${key}" has ${value.length} entries, over the ${param.maxItems} limit`);
      } else {
        value.forEach((entry, index) => {
          if (typeof entry !== 'string') errors.push(`"${key}[${index}]" must be a string`);
          else if (param.itemMaxChars !== undefined && entry.length > param.itemMaxChars) {
            errors.push(`"${key}[${index}]" is ${entry.length} chars, over the ${param.itemMaxChars} limit`);
          }
        });
      }
    } else if (typeof value !== 'string') {
      errors.push(`"${key}" must be a string`);
    } else if (param.maxChars !== undefined && value.length > param.maxChars) {
      errors.push(`"${key}" is ${value.length} chars, over the ${param.maxChars} limit`);
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: merged };
}
