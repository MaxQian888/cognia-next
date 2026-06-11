import type { PluginBalanceAdapterDef } from "@/types/plugin/plugin-balance-adapter"
import {
  __resetBalanceAdaptersForTesting,
  getBalanceAdapter,
  getBalanceAdapterEntry,
  listBalanceAdapterEntries,
  listBalanceAdapterIds,
  registerBalanceAdapter,
  unregisterBalanceAdapterById,
  unregisterBalanceAdaptersByPlugin,
} from "./balance-adapter-registry"

function makeAdapter(
  id: string,
  overrides: Partial<PluginBalanceAdapterDef> = {}
): PluginBalanceAdapterDef {
  return {
    id,
    key: id,
    name: `Adapter ${id}`,
    matches: (q) => q.providerKey === id,
    request: (q) => ({ url: `https://example/${q.providerKey}`, headers: {} }),
    parse: () => ({ fetchedAt: 0, providerKey: id, accountId: "a", kind: "credit", raw: {} }),
    ...overrides,
  }
}

describe("balance-adapter-registry", () => {
  beforeEach(() => {
    __resetBalanceAdaptersForTesting()
  })

  it("registers an adapter and retrieves it via get / getEntry / list", () => {
    const a = makeAdapter("gh:bal")
    const previous = registerBalanceAdapter("gh:bal", a, { pluginId: "gh" })
    expect(previous).toBeUndefined()
    expect(getBalanceAdapter("gh:bal")).toBe(a)
    expect(getBalanceAdapterEntry("gh:bal")).toEqual({ entry: a, pluginId: "gh" })
    expect(listBalanceAdapterIds()).toEqual(["gh:bal"])
    expect(listBalanceAdapterEntries()).toEqual([{ id: "gh:bal", entry: a, pluginId: "gh" }])
  })

  it("unregisterByPlugin drops every adapter from the given pluginId", () => {
    registerBalanceAdapter("a", makeAdapter("a"), { pluginId: "plug" })
    registerBalanceAdapter("b", makeAdapter("b"), { pluginId: "plug" })
    expect(unregisterBalanceAdaptersByPlugin("plug")).toBe(2)
    expect(listBalanceAdapterIds()).toEqual([])
  })

  it("unregisterByPlugin leaves entries from other plugins alone", () => {
    registerBalanceAdapter("a", makeAdapter("a"), { pluginId: "A" })
    const b = makeAdapter("b")
    registerBalanceAdapter("b", b, { pluginId: "B" })
    expect(unregisterBalanceAdaptersByPlugin("A")).toBe(1)
    expect(getBalanceAdapter("b")).toBe(b)
  })

  it("unregisterById removes only the matching entry", () => {
    registerBalanceAdapter("a", makeAdapter("a"))
    registerBalanceAdapter("b", makeAdapter("b"))
    expect(unregisterBalanceAdapterById("a")).toBe(true)
    expect(getBalanceAdapter("a")).toBeUndefined()
    expect(getBalanceAdapter("b")).toBeDefined()
    expect(unregisterBalanceAdapterById("a")).toBe(false)
  })

  it("__resetBalanceAdaptersForTesting clears everything", () => {
    registerBalanceAdapter("a", makeAdapter("a"), { pluginId: "p1" })
    __resetBalanceAdaptersForTesting()
    expect(listBalanceAdapterIds()).toEqual([])
  })
})
