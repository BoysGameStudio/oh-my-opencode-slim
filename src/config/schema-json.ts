/**
 * Post-processing for the published JSON Schema, shared by
 * `bun run generate-schema` and its sync test so both emit the same file.
 *
 * Zod's input-mode emitter decides `required` by resolving past a `.catch()`
 * wrapper to its inner type (`inputOptin` in zod/v4/core/json-schema-
 * processors). A `.catch()`-wrapped object with a fallback is therefore
 * emitted as `required` even though a missing key yields the fallback at
 * parse time — the opposite of the intent that defaulted fields stay
 * optional. A property that carries a `default` is optional by definition,
 * so drop it from its parent's `required` list (a no-op for `.default()`
 * fields, which zod already omits).
 */
export function dropDefaultedRequired(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) dropDefaultedRequired(item);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const record = node as Record<string, unknown>;
  const { properties, required } = record;
  if (
    Array.isArray(required) &&
    typeof properties === 'object' &&
    properties !== null
  ) {
    const props = properties as Record<string, unknown>;
    const kept = required.filter((key) => {
      const prop = typeof key === 'string' ? props[key] : undefined;
      return !(
        typeof prop === 'object' &&
        prop !== null &&
        Object.hasOwn(prop, 'default')
      );
    });
    if (kept.length > 0) record.required = kept;
    else delete record.required;
  }
  for (const value of Object.values(record)) dropDefaultedRequired(value);
}
