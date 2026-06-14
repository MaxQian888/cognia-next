import type { PluginImRateSourceDef } from "@/types/plugin/plugin-im-rate-source"
import {
  __resetImRateSourcesForTesting,
  getImRateSource,
  getImRateSourceEntry,
  listImRateSourceEntries,
  listImRateSourceIds,
  registerImRateSource,
  unregisterImRateSourceById,
  unregisterImRateSourcesByPlugin,
} from "./im-rate-source-registry"

function makeSource(
  id: string,
  overrides: Partial<PluginImRateSourceDef> = {}
): PluginImRateSourceDef {
  return {
    id,
    key: id,
    name: `Source ${id}`,
    matches: (q) => q.adapterId === id,
    evaluate: async () => null,
    ...overrides,
  }
}

describe("im-rate-source-registry", () => {
  beforeEach(() => {
    __resetImRateSourcesForTesting()
  })

  it("registers a source and retrieves it via get / getEntry / list", () => {
    const s = makeSource("tg:rate")
    const previous = registerImRateSource("tg:rate", s, { pluginId: "tg" })
    expect(previous).toBeUndefined()
    expect(getImRateSource("tg:rate")).toBe(s)
    expect(getImRateSourceEntry("tg:rate")).toEqual({ entry: s, pluginId: "tg" })
    expect(listImRateSourceIds()).toEqual(["tg:rate"])
    expect(listImRateSourceEntries()).toEqual([{ id: "tg:rate", entry: s, pluginId: "tg" }])
  })

  it("unregisterByPlugin drops every source from the given pluginId", () => {
    registerImRateSource("a", makeSource("a"), { pluginId: "plug" })
    registerImRateSource("b", makeSource("b"), { pluginId: "plug" })
    expect(unregisterImRateSourcesByPlugin("plug")).toBe(2)
    expect(listImRateSourceIds()).toEqual([])
  })

  it("unregisterByPlugin leaves entries from other plugins alone", () => {
    registerImRateSource("a", makeSource("a"), { pluginId: "A" })
    const b = makeSource("b")
    registerImRateSource("b", b, { pluginId: "B" })
    expect(unregisterImRateSourcesByPlugin("A")).toBe(1)
    expect(getImRateSource("b")).toBe(b)
  })

  it("unregisterById removes only the matching entry", () => {
    registerImRateSource("a", makeSource("a"))
    registerImRateSource("b", makeSource("b"))
    expect(unregisterImRateSourceById("a")).toBe(true)
    expect(getImRateSource("a")).toBeUndefined()
    expect(getImRateSource("b")).toBeDefined()
    expect(unregisterImRateSourceById("a")).toBe(false)
  })

  it("__resetImRateSourcesForTesting clears everything", () => {
    registerImRateSource("a", makeSource("a"), { pluginId: "p1" })
    __resetImRateSourcesForTesting()
    expect(listImRateSourceIds()).toEqual([])
  })
})
