import {
  InMemoryPluginLifecycleStateAdapter,
  PluginLifecycleRevisionError,
  createPersistentPluginLifecycleStateAdapter,
  deriveLegacyPluginIntent,
} from "./lifecycle-state"

describe("plugin lifecycle state", () => {
  it("derives legacy intent without auto-enabling an explicitly disabled plugin", () => {
    expect(deriveLegacyPluginIntent({ enabled: true, status: "installed" })).toBe("enabled")
    expect(deriveLegacyPluginIntent({ enabled: false, status: "disabled" })).toBe("disabled")
    expect(deriveLegacyPluginIntent({ enabled: false, status: "installed" })).toBe("auto")
  })

  it("rejects a stale compare-and-set write", async () => {
    const adapter = new InMemoryPluginLifecycleStateAdapter()
    const initial = await adapter.read("example")
    const updated = await adapter.write("example", initial.revision, { intent: "enabled" })

    await expect(
      adapter.write("example", initial.revision, { intent: "disabled" })
    ).rejects.toBeInstanceOf(PluginLifecycleRevisionError)
    expect(updated.revision).toBe(initial.revision + 1)
    await expect(adapter.read("example")).resolves.toMatchObject({ intent: "enabled" })
  })

  it("migrates a legacy host row and persists lifecycle state without a schema bump", async () => {
    const rows = new Map<string, Record<string, unknown>>([
      ["example", { enabled: false, status: "disabled" }],
    ])
    const adapter = createPersistentPluginLifecycleStateAdapter({
      readRow: async (pluginId) => rows.get(pluginId),
      writeLifecycle: async (pluginId, lifecycle) => {
        rows.set(pluginId, { ...rows.get(pluginId), lifecycle })
      },
    })

    const migrated = await adapter.read("example")
    expect(migrated).toMatchObject({ intent: "disabled", actual: "inactive", revision: 0 })
    const written = await adapter.write("example", 0, { actual: "dirty" })

    expect(written.revision).toBe(1)
    expect(rows.get("example")?.lifecycle).toEqual(written)
  })

  it("uses the host atomic compare-and-write seam when provided", async () => {
    const compareAndWriteLifecycle = jest.fn(async () => false)
    const adapter = createPersistentPluginLifecycleStateAdapter({
      readRow: async () => ({ enabled: false, status: "installed" }),
      writeLifecycle: jest.fn(async () => undefined),
      compareAndWriteLifecycle,
    })

    await expect(adapter.write("example", 0, { intent: "enabled" })).rejects.toBeInstanceOf(
      PluginLifecycleRevisionError
    )
    expect(compareAndWriteLifecycle).toHaveBeenCalledWith(
      "example",
      0,
      expect.objectContaining({ intent: "enabled", revision: 1 })
    )
  })
})
