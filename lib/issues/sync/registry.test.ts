import type { IssueSyncProvider } from "./types"
import {
  IssueSyncRegistry,
  getIssueSyncRegistry,
  registerIssueSyncProvider,
  resetIssueSyncRegistry,
} from "./registry"

function provider(id: string): IssueSyncProvider {
  return {
    id,
    label: id,
    pullFields: [],
    pushFields: [],
    resolveBindings: () => [],
    pull: async () => ({ items: [], notModified: true }),
  }
}

describe("IssueSyncRegistry", () => {
  beforeEach(resetIssueSyncRegistry)

  it("registers, lists in order, replaces on the same id and disposes", () => {
    const registry = new IssueSyncRegistry()
    const first = provider("a")
    const dispose = registry.register(first)
    registry.register(provider("b"))
    expect(registry.list().map((p) => p.id)).toEqual(["a", "b"])

    const replacement = provider("a")
    registry.register(replacement)
    expect(registry.get("a")).toBe(replacement)
    // Disposing the first registration must not remove the replacement.
    dispose()
    expect(registry.get("a")).toBe(replacement)
    registry.unregister("a")
    expect(registry.get("a")).toBeUndefined()
  })

  it("hands out one singleton until reset", () => {
    registerIssueSyncProvider(provider("x"))
    expect(getIssueSyncRegistry().get("x")).toBeDefined()
    resetIssueSyncRegistry()
    expect(getIssueSyncRegistry().get("x")).toBeUndefined()
  })
})
