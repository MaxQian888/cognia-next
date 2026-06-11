import type { PluginCompactionStrategyDef } from "@/types/plugin/plugin-compaction-strategy"
import {
  registerCompactionStrategy,
  unregisterCompactionStrategyById,
  unregisterCompactionStrategiesByPlugin,
  getCompactionStrategy,
  getCompactionStrategyEntry,
  listCompactionStrategyIds,
  listCompactionStrategyEntries,
  __resetCompactionStrategiesForTesting,
} from "./compaction-strategy-registry"

const strat = (
  id: string,
  over: Partial<PluginCompactionStrategyDef> = {}
): PluginCompactionStrategyDef => ({
  id,
  label: id,
  summaryPrompt: `prompt for ${id}`,
  keepRecent: 8,
  fraction: 0.8,
  ...over,
})

describe("compaction-strategy-registry", () => {
  beforeEach(() => __resetCompactionStrategiesForTesting())

  it("registers and retrieves a strategy", () => {
    registerCompactionStrategy("p:keyfacts", strat("p:keyfacts"), { pluginId: "p" })
    expect(getCompactionStrategy("p:keyfacts")?.summaryPrompt).toBe("prompt for p:keyfacts")
    expect(getCompactionStrategyEntry("p:keyfacts")?.pluginId).toBe("p")
    expect(listCompactionStrategyIds()).toEqual(["p:keyfacts"])
    expect(listCompactionStrategyEntries()).toHaveLength(1)
  })

  it("drops a single strategy by id", () => {
    registerCompactionStrategy("p:a", strat("p:a"), { pluginId: "p" })
    expect(unregisterCompactionStrategyById("p:a")).toBe(true)
    expect(getCompactionStrategy("p:a")).toBeUndefined()
  })

  it("drops every strategy contributed by a plugin", () => {
    registerCompactionStrategy("p:a", strat("p:a"), { pluginId: "p" })
    registerCompactionStrategy("p:b", strat("p:b"), { pluginId: "p" })
    registerCompactionStrategy("q:c", strat("q:c"), { pluginId: "q" })
    expect(unregisterCompactionStrategiesByPlugin("p")).toBe(2)
    expect(listCompactionStrategyIds()).toEqual(["q:c"])
  })
})
