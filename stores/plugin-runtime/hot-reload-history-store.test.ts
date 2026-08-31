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

  it("does NOT dedupe a status change inside the window", () => {
    // A reload writes `in-progress` then its outcome milliseconds later. A
    // dedupe key without `status` would swallow the outcome and leave the
    // panel spinning forever.
    recordHotReloadEvent({
      ...baseEntry,
      kind: "hot-reload",
      status: "in-progress",
      timestamp: 1000,
    })
    recordHotReloadEvent({ ...baseEntry, kind: "hot-reload", status: "success", timestamp: 1050 })
    const entries = snapshot()
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe("success")
  })

  it("settles an in-progress row in place instead of adding a second row", () => {
    recordHotReloadEvent({
      ...baseEntry,
      pluginId: "plg-a",
      kind: "hot-reload",
      status: "in-progress",
      timestamp: 1000,
    })
    recordHotReloadEvent({ ...baseEntry, pluginId: "plg-b", kind: "install", timestamp: 2000 })
    recordHotReloadEvent({
      ...baseEntry,
      pluginId: "plg-a",
      kind: "hot-reload",
      status: "failed",
      timestamp: 3000,
      note: "activation timed out",
    })
    const entries = snapshot()
    expect(entries).toHaveLength(2)
    // Position is preserved: the settled row stays where the attempt was.
    expect(entries[1]).toMatchObject({
      pluginId: "plg-a",
      status: "failed",
      note: "activation timed out",
    })
    expect(entries[0].pluginId).toBe("plg-b")
  })

  it("does NOT settle an in-progress row older than the settle window", () => {
    recordHotReloadEvent({
      ...baseEntry,
      kind: "hot-reload",
      status: "in-progress",
      timestamp: 1000,
    })
    recordHotReloadEvent({
      ...baseEntry,
      kind: "hot-reload",
      status: "success",
      timestamp: 1000 + 60_001,
    })
    const entries = snapshot()
    expect(entries).toHaveLength(2)
    expect(entries[0].status).toBe("success")
    expect(entries[1].status).toBe("in-progress")
  })

  it("does NOT settle another plugin's in-progress row", () => {
    recordHotReloadEvent({
      ...baseEntry,
      pluginId: "plg-a",
      kind: "hot-reload",
      status: "in-progress",
      timestamp: 1000,
    })
    recordHotReloadEvent({
      ...baseEntry,
      pluginId: "plg-b",
      kind: "hot-reload",
      status: "success",
      timestamp: 2000,
    })
    const entries = snapshot()
    expect(entries).toHaveLength(2)
    expect(entries.find((e) => e.pluginId === "plg-a")?.status).toBe("in-progress")
  })

  it("clear() empties the buffer", () => {
    recordHotReloadEvent(baseEntry)
    recordHotReloadEvent({ ...baseEntry, timestamp: 5000 })
    expect(snapshot()).toHaveLength(2)
    useHotReloadHistoryStore.getState().clear()
    expect(snapshot()).toHaveLength(0)
  })
})
