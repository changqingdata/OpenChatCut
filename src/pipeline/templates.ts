// The app's template catalog, seen as a recipe registry.
//
// The compiler was written against `Recipe` — a box, a code string, defaults —
// because at the time recipes were directories. Now the same fifteen things are
// also `Tpl` entries in the library, and the 235 upstream templates are `Tpl`
// entries too. This adapter is the whole distance between the two shapes, which
// means a storyboard may name any template in the library, not only ours.
import type { Tpl } from '../types.ts';
import type { Recipe, RecipeParam, RecipeRegistry, RecipeSchema } from './recipes.ts';

/**
 * A scene owns the canvas, so it compiles as `fullFrame`: no anchor, no card
 * rect, no width ratio — the component is handed the frame and lays itself out.
 * A card keeps its design box and gets placed by the compiler.
 */
export function recipeFromTemplate(template: Tpl): Recipe {
  const scene = template.kind === 'scene';
  return {
    id: template.id,
    code: template.code,
    box: template.box ?? { width: template.width, height: template.height },
    ...(scene ? { fullFrame: true } : {}),
    ...(template.landscapeBox ? { landscapeBox: template.landscapeBox } : {}),
    defaultProps: { ...template.props },
  };
}

export function recipeRegistryFromTemplates(templates: readonly Tpl[]): RecipeRegistry {
  const registry = new Map<string, Recipe>();
  for (const template of templates) registry.set(template.id, recipeFromTemplate(template));
  return registry;
}

/**
 * A template's params, in the shape QC reads.
 *
 * QC asks two questions of a schema: does this recipe claim it can draw this kind
 * of shot (`jobs`), and how many characters does a given field hold
 * (`maxChars`). Both live on the template already; this adapter just renames the
 * fields, so a project can run the same eighteen rules the CLI runs.
 */
export function schemaFromTemplate(template: Tpl): RecipeSchema {
  const params: Record<string, RecipeParam> = {};
  for (const spec of template.propSchema) {
    const common = {
      ...(spec.defaultValue !== undefined ? { default: spec.defaultValue } : {}),
      ...(spec.label ? { description: spec.label } : {}),
    };
    if (spec.type === 'number') {
      params[spec.key] = {
        type: 'number',
        ...common,
        ...(spec.min !== undefined ? { min: spec.min } : {}),
        ...(spec.max !== undefined ? { max: spec.max } : {}),
      };
    } else if (spec.type === 'color') {
      params[spec.key] = { type: 'color', ...common };
    } else if (spec.type === 'font') {
      params[spec.key] = { type: 'font', ...common };
    } else if (spec.type === 'select') {
      params[spec.key] = {
        type: 'enum',
        ...common,
        values: (spec.options ?? []).map((option) => (typeof option === 'string' ? option : option.value)),
      };
    } else if (spec.type === 'array') {
      params[spec.key] = {
        type: 'array',
        ...common,
        ...(spec.maxItems !== undefined ? { maxItems: spec.maxItems } : {}),
        ...(spec.itemMaxLength !== undefined ? { itemMaxChars: spec.itemMaxLength } : {}),
      };
    } else {
      // `text`, plus `boolean` — QC has no boolean rule, and a switch that is
      // typed as a string cannot trip a character limit because it has none.
      params[spec.key] = {
        type: 'string',
        ...common,
        ...(spec.maxLength !== undefined ? { maxChars: spec.maxLength } : {}),
      };
    }
  }
  return {
    id: template.id,
    name: template.name,
    box: template.box ?? { width: template.width, height: template.height },
    ...(template.fullFrame ? { fullFrame: true } : {}),
    ...(template.landscapeBox ? { landscapeBox: template.landscapeBox } : {}),
    ...(template.jobs ? { jobs: template.jobs } : {}),
    ...(template.sfx ? { sfx: template.sfx } : {}),
    params,
  };
}

/** Every template's schema, keyed by id — what `runQc` wants. */
export function schemasFromTemplates(templates: readonly Tpl[]): Map<string, RecipeSchema> {
  return new Map(templates.map((template) => [template.id, schemaFromTemplate(template)]));
}
