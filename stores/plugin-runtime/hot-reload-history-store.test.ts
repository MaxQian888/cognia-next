import {
  recordHotReloadEvent,
  useHotReloadHistoryStore,
  type HotReloadEntry,
} from "./hot-reload-history-store"

function snapshot(): readonly HotReloadEntry[] {
  return useHotReloadHistoryStore.getState().entries
}

beforeEach(() => {
  useHotReloadHistoryStore.getState().clear()
})

const baseEntry: HotReloadEntry = {
  pluginId: "plg-1",
  source: "cli-bridge",
  kind: "install",
  status: "success",
  timestamp: 1000,
}

describe("hot-reload-history-store", () => {
  it("records events newest-first", () => {
    recordHotReloadEvent({ ...baseEntry, timestamp: 1000 })
    recordHotReloadEvent({ ...baseEntry, pluginId: "plg-2", timestamp: 2000 })
    const entries = snapshot()
    expect(entries).toHaveLength(2)
    expect(entries[0].pluginId).toBe("plg-2")
    expect(entries[1].pluginId).toBe("plg-1")
  })

  it("dedupes same-plugin same-kind events inside the 500ms window", () => {
    recordHotReloadEvent({ ...baseEntry, timestamp: 1000 })
    // Bridge fires both `cli-bridge:plugin-installed` and global
    // `plugin-hot-reload` on a reload-via-install — both arrive within
    // ~1ms, so the panel should only show one row.
    recordHotReloadEvent({ ...baseEntry, timestamp: 1050 })
    expect(snapshot()).toHaveLength(1)
  })

  it("does NOT dedupe across different kinds", () => {
    recordHotReloadEvent({ ...baseEntry, timestamp: 1000, kind: "install" })
    recordHotReloadEvent({ ...baseEntry, timestamp: 1050, kind: "uninstall" })
    expect(snapshot()).toHaveLength(2)
  })

  it("does NOT dedupe outside the dedupe window", () => {
    recordHotReloadEvent({ ...baseEntry, timestamp: 1000 })
    recordHotReloadEvent({ ...baseEntry, timestamp: 2000 })
    expect(snapshot()).toHaveLength(2)
  })

  it("caps history at 20 entries (oldest dropped)", () => {
    for (let i = 0; i < 25; i++) {
      recordHotReloadEvent({
        ...baseEntry,
        pluginId: `plg-${i}`,
        timestamp: 1000 + i * 1000,
      })
    }
    const entries = snapshot()
    expect(entries).toHaveLength(20)
    expect(entries[0].pluginId).toBe("plg-24")
    expect(entries[entries.length - 1].pluginId).toBe("plg-5")
  })

  it("clear() empties the buffer", () => {
    recordHotReloadEvent(baseEntry)
    recordHotReloadEvent({ ...baseEntry, timestamp: 5000 })
    expect(snapshot()).toHaveLength(2)
    useHotReloadHistoryStore.getState().clear()
    expect(snapshot()).toHaveLength(0)
  })
})
