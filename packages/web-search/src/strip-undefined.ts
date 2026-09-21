/**
 * Copy `o` dropping keys whose value is `undefined`. Call-time options are
 * always emitted fully populated (often with `undefined` placeholders); a
 * naive spread would clobber provider `defaultOptions` with those undefineds.
 *
 * A leaf module on purpose: both `search-service` and `search-type-router`
 * need it, and the router is imported BY the service — housing the helper in
 * either would close an import cycle.
 */
export function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [key, value] of Object.entries(o)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value
  }
  return out
}
