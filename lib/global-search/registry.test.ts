import {
  __resetGlobalSearchRegistryForTesting,
  getGlobalSearchProvider,
  getGlobalSearchRegistryRevision,
  listGlobalSearchProviders,
  providersForKinds,
  registerGlobalSearchProvider,
  subscribeGlobalSearchProviders,
  unregisterGlobalSearchProvider,
} from "./registry"
import type { GlobalSearchProvider } from "./types"

const make = (id: string, kind: GlobalSearchProvider["kind"]): GlobalSearchProvider => ({
  id,
  kind,
  search: () => ({ items: [] }),
})

describe("global-search registry", () => {
  beforeEach(() => __resetGlobalSearchRegistryForTesting())

  it("registers, lists in order, and unregisters via the returned fn", () => {
    const off = registerGlobalSearchProvider(make("a", "session"))
    registerGlobalSearchProvider(make("b", "message"))
    expect(listGlobalSearchProviders().map((p) => p.id)).toEqual(["a", "b"])
    expect(getGlobalSearchProvider("a")?.kind).toBe("session")
    off()
    expect(listGlobalSearchProviders().map((p) => p.id)).toEqual(["b"])
    expect(getGlobalSearchProvider("a")).toBeUndefined()
  })

  it("replaces a provider registered under the same id", () => {
    registerGlobalSearchProvider(make("a", "session"))
    registerGlobalSearchProvider(make("a", "team"))
    expect(listGlobalSearchProviders()).toHaveLength(1)
    expect(getGlobalSearchProvider("a")?.kind).toBe("team")
  })

  it("filters by kind", () => {
    registerGlobalSearchProvider(make("a", "session"))
    registerGlobalSearchProvider(make("b", "message"))
    registerGlobalSearchProvider(make("c", "skill"))
    expect(providersForKinds(["message", "skill"]).map((p) => p.id)).toEqual(["b", "c"])
  })

  it("notifies subscribers and bumps the revision on change only", () => {
    const listener = jest.fn()
    const off = subscribeGlobalSearchProviders(listener)
    const r0 = getGlobalSearchRegistryRevision()
    registerGlobalSearchProvider(make("a", "session"))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getGlobalSearchRegistryRevision()).toBe(r0 + 1)
    unregisterGlobalSearchProvider("missing")
    expect(listener).toHaveBeenCalledTimes(1)
    unregisterGlobalSearchProvider("a")
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    registerGlobalSearchProvider(make("z", "team"))
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
