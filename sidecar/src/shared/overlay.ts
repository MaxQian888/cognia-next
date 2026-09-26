/**
 * A view of `target` whose `overrides` shadow its own members (symbol keys
 * included). Every other member reads through, and methods stay bound to the
 * original so private fields and internal slots keep working.
 */
export function overlay<T extends object>(target: T, overrides: Record<PropertyKey, unknown>): T {
  return new Proxy(target, {
    get(original, property, receiver) {
      if (Object.hasOwn(overrides, property)) return overrides[property]
      const value: unknown = Reflect.get(original, property, receiver)
      return typeof value === "function" ? value.bind(original) : value
    },
  })
}
