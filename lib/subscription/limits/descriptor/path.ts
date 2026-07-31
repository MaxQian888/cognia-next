// Pure value-extraction helpers for the declarative descriptor engine.
//
// A descriptor addresses fields in an arbitrary JSON response by dot-path
// ("data.balance", "rate_limit.primary_window.used_percent", "infos.0.total").
// `getAtPath` walks that path null-safely (array indices are plain segments);
// `coerceNum` mirrors the balance adapters' tolerant string|number → number
// parsing (CCSwitch `parse_f64_field` parity) so a provider that returns
// "12.34" reads the same as 12.34.

/**
 * Resolve a dot-path against a parsed JSON value. Each segment indexes either
 * an object key or (when numeric) an array position. Returns `undefined` the
 * moment the path leaves a traversable value — never throws.
 */
export function getAtPath(root: unknown, path: string): unknown {
  if (!path) return undefined
  let cur: unknown = root
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined
    if (Array.isArray(cur)) {
      const idx = Number(seg)
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined
      cur = cur[idx]
    } else {
      cur = (cur as Record<string, unknown>)[seg]
    }
  }
  return cur
}

/** Coerce a string|number value to a finite number, else `null`. */
export function coerceNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "string") {
    const n = Number(v.trim())
    return v.trim().length > 0 && Number.isFinite(n) ? n : null
  }
  return null
}

/** Read a numeric value at a dot-path (string|number tolerant). */
export function numAtPath(root: unknown, path: string | undefined): number | null {
  if (!path) return null
  return coerceNum(getAtPath(root, path))
}
