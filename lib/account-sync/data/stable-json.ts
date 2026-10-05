/**
 * Value comparison for change capture: JSON semantics with object keys in a
 * fixed order, so re-serializing an object does not look like an edit.
 * `undefined` and `null` compare equal; on the wire both mean "unset".
 */

function normalize(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (Array.isArray(value)) return value.map(normalize)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as object).sort()) {
      const entry = (value as Record<string, unknown>)[key]
      if (entry !== undefined) out[key] = normalize(entry)
    }
    return out
  }
  return value
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return stableJson(a) === stableJson(b)
}
