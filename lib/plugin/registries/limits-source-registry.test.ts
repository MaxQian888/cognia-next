import type { PluginLimitsSourceDef } from "@/types/plugin/plugin-limits-source"
import {
  __resetLimitsSourcesForTesting,
  getLimitsSource,
  getLimitsSourceEntry,
  listLimitsSourceEntries,
  listLimitsSourceIds,
  registerLimitsSource,
  unregisterLimitsSourceById,
  unregisterLimitsSourcesByPlugin,
} from "./limits-source-registry"

function makeSource(
  id: string,
  overrides: Partial<PluginLimitsSourceDef> = {}
): PluginLimitsSourceDef {
  return {
    id,
    key: id,
    name: `Source ${id}`,
    matches: (q) => q.providerKey === id,
    fetch: async (ctx) => ({
      provider: id,
      accountId: ctx.accountId,
      fetchedAt: ctx.now,
      meters: [],
    }),
    ...overrides,
  }
}

describe("limits-source-registry", () => {
  beforeEach(() => {
    __resetLimitsSourcesForTesting()
  })

  it("registers a source and retrieves it via get / getEntry / list", () => {
    const s = makeSource("gh:lim")
    const previous = registerLimitsSource("gh:lim", s, { pluginId: "gh" })
    expect(previous).toBeUndefined()
    expect(getLimitsSource("gh:lim")).toBe(s)
    expect(getLimitsSourceEntry("gh:lim")).toEqual({ entry: s, pluginId: "gh" })
    expect(listLimitsSourceIds()).toEqual(["gh:lim"])
    expect(listLimitsSourceEntries()).toEqual([{ id: "gh:lim", entry: s, pluginId: "gh" }])
  })

  it("unregisterByPlugin drops every source from the given pluginId", () => {
    registerLimitsSource("a", makeSource("a"), { pluginId: "plug" })
    registerLimitsSource("b", makeSource("b"), { pluginId: "plug" })
    expect(unregisterLimitsSourcesByPlugin("plug")).toBe(2)
    expect(listLimitsSourceIds()).toEqual([])
  })

  it("unregisterByPlugin leaves entries from other plugins alone", () => {
    registerLimitsSource("a", makeSource("a"), { pluginId: "A" })
    const b = makeSource("b")
    registerLimitsSource("b", b, { pluginId: "B" })
    expect(unregisterLimitsSourcesByPlugin("A")).toBe(1)
    expect(getLimitsSource("b")).toBe(b)
  })

  it("unregisterById removes only the matching entry", () => {
    registerLimitsSource("a", makeSource("a"))
    registerLimitsSource("b", makeSource("b"))
    expect(unregisterLimitsSourceById("a")).toBe(true)
    expect(getLimitsSource("a")).toBeUndefined()
    expect(getLimitsSource("b")).toBeDefined()
    expect(unregisterLimitsSourceById("a")).toBe(false)
  })

  it("__resetLimitsSourcesForTesting clears everything", () => {
    registerLimitsSource("a", makeSource("a"), { pluginId: "p1" })
    __resetLimitsSourcesForTesting()
    expect(listLimitsSourceIds()).toEqual([])
  })
})
