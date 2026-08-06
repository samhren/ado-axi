import { encode } from "@toon-format/toon";

/**
 * Field extractor definitions for transforming az JSON into flat TOON-friendly objects.
 */
export type FieldDef =
  | { type: "field"; key: string; as?: string }
  | { type: "pluck"; key: string; subkey: string; as?: string }
  | { type: "lower"; key: string; as?: string }
  | { type: "boolYesNo"; key: string; as?: string }
  | { type: "mapEnum"; key: string; map: Record<string, string>; fallback?: string; as?: string }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- custom extractors are polymorphic by design
  | { type: "custom"; as: string; fn: (item: any) => any };

export function field(key: string, as?: string): FieldDef {
  return { type: "field", key, as };
}
export function pluck(key: string, subkey: string, as?: string): FieldDef {
  return { type: "pluck", key, subkey, as };
}
export function lower(key: string, as?: string): FieldDef {
  return { type: "lower", key, as };
}
export function boolYesNo(key: string, as?: string): FieldDef {
  return { type: "boolYesNo", key, as };
}
export function mapEnum(
  key: string,
  map: Record<string, string>,
  fallback?: string,
  as?: string,
): FieldDef {
  return { type: "mapEnum", key, map, fallback, as };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- custom extractors are polymorphic by design
export function custom(as: string, fn: (item: any) => any): FieldDef {
  return { type: "custom", as, fn };
}

export function extract(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- items are JSON-parsed objects with dynamic keys
  item: Record<string, any>,
  schema: FieldDef[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const def of schema) {
    const outputKey = def.as ?? ("key" in def ? def.key : def.as);
    switch (def.type) {
      case "field":
        result[outputKey] = item[def.key] ?? null;
        break;
      case "pluck":
        result[outputKey] =
          (item[def.key] as Record<string, unknown> | undefined)?.[def.subkey] ?? null;
        break;
      case "lower":
        result[outputKey] =
          typeof item[def.key] === "string" ? (item[def.key] as string).toLowerCase() : item[def.key];
        break;
      case "boolYesNo":
        result[outputKey] = item[def.key] ? "yes" : "no";
        break;
      case "mapEnum": {
        const val = item[def.key];
        if (typeof val === "string" && val !== "" && val in def.map) {
          result[outputKey] = def.map[val];
        } else {
          result[outputKey] = def.fallback ?? val ?? "none";
        }
        break;
      }
      case "custom":
        result[outputKey] = def.fn(item);
        break;
      default: {
        const _exhaustive: never = def;
        throw new Error(`Unknown field type: ${(_exhaustive as FieldDef).type}`);
      }
    }
  }
  return result;
}

/** Render a labeled list of items as TOON. */
export function renderList(
  label: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- items are JSON-parsed objects with dynamic keys
  items: Record<string, any>[],
  schema: FieldDef[],
): string {
  const extracted = items.map((item) => extract(item, schema));
  return encode({ [label]: extracted });
}

/** Render a single labeled detail object as TOON. */
export function renderDetail(
  label: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- items are JSON-parsed objects with dynamic keys
  item: Record<string, any>,
  schema: FieldDef[],
): string {
  const extracted = extract(item, schema);
  return encode({ [label]: extracted });
}

/**
 * Render an already-shaped value under a label, without a field schema.
 * Used for composite documents (nested threads, grouped checks) that a flat
 * FieldDef list cannot express.
 */
export function renderBlock(label: string, value: unknown): string {
  return encode({ [label]: value });
}

/** Render help suggestions (manual formatting - encode() inlines primitive arrays). */
export function renderHelp(lines: string[]): string {
  if (lines.length === 0) return "";
  const indented = lines.map((l) => `  ${l}`).join("\n");
  return `help[${lines.length}]:\n${indented}`;
}

/**
 * Render an error in TOON format. `details` carries the structured specifics -
 * operation, endpoint, HTTP status, az exit code, the raw Azure message - so an
 * agent can act on a failure without re-running anything.
 */
export function renderError(
  message: string,
  code: string,
  suggestions: string[] = [],
  details: Record<string, unknown> = {},
): string {
  const populated = Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
  const blocks = [encode({ error: message, code, ...populated })];
  if (suggestions.length > 0) {
    blocks.push(renderHelp(suggestions));
  }
  return blocks.join("\n");
}

/** Combine multiple TOON blocks into a single output string, dropping empty ones. */
export function renderOutput(blocks: string[]): string {
  return blocks.filter(Boolean).join("\n");
}
