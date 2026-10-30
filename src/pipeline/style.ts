// The project's brand, as props.
//
// `doc.designStyle` is a list of colour and font roles — free-form names, because
// real styles say "accent copper" and "Chinese heading". The templates take
// concrete props (`accent`, `displayFont`). This is the mapping between the two,
// and it exists so a brand change is a document change rather than fifteen
// component edits.
//
// Precedence at compile time: schema default < this < the shot's own params. So a
// card dragged from the library still renders standalone (it has defaults), a
// compiled shot follows the brand, and a director who wants one shot different
// still wins.
import type { DesignStyle } from '../editor/designTypes.ts';
import { colorOf, fontOf } from '../editor/designTypes.ts';

/**
 * Role candidates per prop, most specific first.
 *
 * The presets in the app are not consistent — one style calls it "accent
 * copper", another "accent", a third "primary" — and a style that has none of
 * them simply leaves the prop alone.
 */
const COLOR_ROLES: Record<string, readonly string[]> = {
  bg: ['background', 'bg', 'surface'],
  ink: ['text', 'foreground', 'ink'],
  accent: ['accent', 'accent copper', 'primary'],
  muted: ['text secondary', 'secondary', 'muted'],
};

const FONT_ROLES: Record<string, readonly string[]> = {
  displayFont: ['heading', 'display'],
  bodyFont: ['body', 'text'],
};

const firstColor = (style: DesignStyle, roles: readonly string[]): string | undefined => {
  for (const role of roles) {
    const value = colorOf(style, role);
    if (value) return value;
  }
  return undefined;
};

const firstFont = (style: DesignStyle, roles: readonly string[]): string | undefined => {
  for (const role of roles) {
    const family = fontOf(style, role);
    if (family) return family;
  }
  return undefined;
};

/**
 * Brand values for the props a template actually declares.
 *
 * `declared` is the template's own key list: injecting `accent` into a component
 * that has no `accent` prop would put a value in the document that nothing reads,
 * and the inspector would show a colour that does nothing.
 */
export function styleProps(style: DesignStyle | undefined, declared: Iterable<string>): Record<string, unknown> {
  if (!style) return {};
  const keys = new Set(declared);
  const props: Record<string, unknown> = {};
  for (const [prop, roles] of Object.entries(COLOR_ROLES)) {
    if (!keys.has(prop)) continue;
    const value = firstColor(style, roles);
    if (value) props[prop] = value;
  }
  for (const [prop, roles] of Object.entries(FONT_ROLES)) {
    if (!keys.has(prop)) continue;
    const value = firstFont(style, roles);
    if (value) props[prop] = value;
  }
  return props;
}

/**
 * The wash colour behind white type.
 *
 * It follows the brand rather than being always black: a light style with dark
 * type needs a light wash, and hard-coding near-black made that combination
 * unreadable. Undefined means "leave the component's default".
 */
export function styleWash(style: DesignStyle | undefined): string | undefined {
  if (!style) return undefined;
  return firstColor(style, COLOR_ROLES.bg!);
}
