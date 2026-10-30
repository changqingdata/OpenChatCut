// Loads recipe directories into the registry the compiler expects.
//
// A recipe is `index.jsx` (the Remotion component) plus `schema.json` (its box
// and editable params). Reading them off disk keeps the compiler pure — it
// receives a plain Map, never a path.
//
// The types and the two pure helpers live in `src/pipeline/recipes.ts`, because
// the compiler and QC need them and neither may touch the filesystem. This file
// is the disk half only: read, validate, hand over.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validateTemplate } from '../../src/template-host.ts';
import type { Recipe, RecipeRegistry, RecipeSchema } from '../../src/pipeline/recipes.ts';
import { schemaDefaults } from '../../src/pipeline/recipes.ts';

export type { Recipe, RecipeParam, RecipeRegistry, RecipeSchema } from '../../src/pipeline/recipes.ts';
export { checkParams, schemaDefaults } from '../../src/pipeline/recipes.ts';

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
    ...(schema.landscapeBox ? { landscapeBox: schema.landscapeBox } : {}),
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
