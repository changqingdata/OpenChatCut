// Loads recipe directories into the registry the compiler expects.
//
// A recipe is `index.jsx` (the Remotion component) plus `schema.json` (its box
// and editable params). Reading them off disk keeps the compiler pure — it
// receives a plain Map, never a path.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validateTemplate } from '../../src/template-host.ts';
import type { Recipe, RecipeRegistry } from '../compile.ts';

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
  /**
   * Optional sound effect this recipe earns. Placement is decided by the
   * pipeline, not here — a recipe only says what would suit it.
   */
  sfx?: { category: string; query?: string; volume?: number };
  params: Record<string, RecipeParam>;
}

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

export async function readRecipeSchema(dir: string): Promise<RecipeSchema> {
  const raw = await readFile(join(dir, 'schema.json'), 'utf8');
  const schema = JSON.parse(raw) as RecipeSchema;
  if (!schema.id) throw new Error(`${dir}: schema.json has no id`);
  if (!(schema.box?.width > 0) || !(schema.box?.height > 0)) {
    throw new Error(`${dir}: schema.json needs a positive box`);
  }
  return schema;
}

export async function loadRecipe(dir: string): Promise<{ recipe: Recipe; schema: RecipeSchema }> {
  const schema = await readRecipeSchema(dir);
  const code = await readFile(join(dir, 'index.jsx'), 'utf8');
  // Static checks only: the blocklist and the JSX transform. Evaluation happens
  // in the renderer, so a broken recipe fails there with a clear message rather
  // than here with a stack trace.
  validateTemplate(code);
  const recipe: Recipe = {
    id: schema.id,
    code,
    box: schema.box,
    ...(schema.fullFrame ? { fullFrame: true } : {}),
    defaultProps: schemaDefaults(schema),
  };
  return { recipe, schema };
}

/** Every subdirectory of `root` that holds a schema.json + index.jsx. */
export async function loadRecipeRegistry(root: string): Promise<{
  registry: RecipeRegistry;
  schemas: Map<string, RecipeSchema>;
}> {
  const registry = new Map<string, Recipe>();
  const schemas = new Map<string, RecipeSchema>();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { registry, schemas };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    try {
      const loaded = await loadRecipe(dir);
      registry.set(loaded.recipe.id, loaded.recipe);
      schemas.set(loaded.recipe.id, loaded.schema);
    } catch (error) {
      throw new Error(`recipe "${entry.name}" failed to load: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { registry, schemas };
}
