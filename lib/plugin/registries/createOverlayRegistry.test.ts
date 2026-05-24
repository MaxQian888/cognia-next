import { createOverlayRegistry, type OverlayRegistry } from "./createOverlayRegistry"

// Typed payload so the test exercises the generic parameter rather than
// relying on `any`. Matches the shape callers in M1·T3 will use (a small
// config object keyed by id).
interface TestEntry {
  value: string
}

describe("createOverlayRegistry", () => {
  let registry: OverlayRegistry<TestEntry>

  beforeEach(() => {
    registry = createOverlayRegistry<TestEntry>({ name: "test" })
  })

  describe("register", () => {
    it("returns undefined on first registration and the previous entry on re-register", () => {
      const first = registry.register("a", { value: "one" }, { pluginId: "p1" })
      expect(first).toBeUndefined()

      const second = registry.register("a", { value: "two" }, { pluginId: "p2" })
      expect(second).toBeDefined()
      // `register` MUST return the *previous* entry, not the new one — this
      // is how higher-level wrappers detect collisions.
      expect(second?.entry.value).toBe("one")
      expect(second?.pluginId).toBe("p1")

      // The new entry now lives in the store.
      expect(registry.get("a")?.value).toBe("two")
      expect(registry.getEntry("a")?.pluginId).toBe("p2")
    })

    it("treats missing pluginId as anonymous registration", () => {
      registry.register("anon", { value: "x" })
      expect(registry.getEntry("anon")).toEqual({
        entry: { value: "x" },
        pluginId: undefined,
      })
    })
  })

  describe("get / getEntry / list / entries", () => {
    it("reflects current registrations and returns undefined / empty for unknown ids", () => {
      // Empty state.
      expect(registry.get("missing")).toBeUndefined()
      expect(registry.getEntry("missing")).toBeUndefined()
      expect(registry.list()).toEqual([])
      expect(registry.entries()).toEqual([])

      registry.register("a", { value: "one" }, { pluginId: "p1" })
      registry.register("b", { value: "two" }, { pluginId: "p2" })

      expect(registry.get("a")).toEqual({ value: "one" })
      expect(registry.getEntry("a")).toEqual({
        entry: { value: "one" },
        pluginId: "p1",
      })
      expect(registry.list()).toEqual(["a", "b"])
      expect(registry.entries()).toEqual([
        { id: "a", entry: { value: "one" }, pluginId: "p1" },
        { id: "b", entry: { value: "two" }, pluginId: "p2" },
      ])

      // Unknown id remains absent.
      expect(registry.get("c")).toBeUndefined()
      expect(registry.getEntry("c")).toBeUndefined()
    })
  })

  describe("unregisterById", () => {
    it("returns true when an entry is removed, false when the id wasn't present", () => {
      registry.register("a", { value: "one" })
      expect(registry.unregisterById("a")).toBe(true)
      expect(registry.get("a")).toBeUndefined()

      // Second call for the same id (now missing).
      expect(registry.unregisterById("a")).toBe(false)

      // Never-registered id.
      expect(registry.unregisterById("never-existed")).toBe(false)
    })
  })

  describe("unregisterByPlugin", () => {
    it("removes every entry tagged with the given pluginId and returns the count", () => {
      registry.register("a", { value: "one" }, { pluginId: "p1" })
      registry.register("b", { value: "two" }, { pluginId: "p1" })
      registry.register("c", { value: "three" }, { pluginId: "p2" })
      registry.register("d", { value: "four" }) // anonymous

      const removed = registry.unregisterByPlugin("p1")
      expect(removed).toBe(2)

      // p1's entries are gone.
      expect(registry.get("a")).toBeUndefined()
      expect(registry.get("b")).toBeUndefined()
      // Other pluginIds untouched.
      expect(registry.get("c")).toEqual({ value: "three" })
      // Anonymous entry untouched.
      expect(registry.get("d")).toEqual({ value: "four" })
    })

    it("returns 0 when no entries match", () => {
      registry.register("a", { value: "one" }, { pluginId: "p1" })
      expect(registry.unregisterByPlugin("nobody")).toBe(0)
      // Existing entry still present.
      expect(registry.get("a")).toEqual({ value: "one" })
    })
  })

  describe("__resetForTesting", () => {
    it("clears every entry regardless of pluginId tag", () => {
      registry.register("a", { value: "one" }, { pluginId: "p1" })
      registry.register("b", { value: "two" }, { pluginId: "p2" })
      registry.register("c", { value: "three" }) // anonymous

      registry.__resetForTesting()

      expect(registry.list()).toEqual([])
      expect(registry.entries()).toEqual([])
      expect(registry.get("a")).toBeUndefined()
      expect(registry.get("b")).toBeUndefined()
      expect(registry.get("c")).toBeUndefined()
    })
  })

  describe("keyFn", () => {
    it("derives the storage key from the registration arguments", () => {
      const reg = createOverlayRegistry<TestEntry>({
        keyFn: (id, _entry, opts) => `${opts?.pluginId}:${id}`,
      })
      reg.register("t1", { value: "one" }, { pluginId: "p1" })
      reg.register("t1", { value: "two" }, { pluginId: "p2" })

      // Same logical id but different pluginId → distinct composite keys.
      expect(reg.list()).toEqual(["p1:t1", "p2:t1"])
      expect(reg.get("p1:t1")).toEqual({ value: "one" })
      expect(reg.get("p2:t1")).toEqual({ value: "two" })
      // Lookup by the bare logical id misses (caller must use derived key).
      expect(reg.get("t1")).toBeUndefined()
    })
  })

  describe("conflictPolicy: first-wins-cross-plugin", () => {
    it("keeps the incumbent when a different plugin re-uses a key and fires onConflict", () => {
      const conflicts: Array<{ key: string; existing?: string; incoming?: string }> = []
      const reg = createOverlayRegistry<TestEntry>({
        name: "tools",
        conflictPolicy: "first-wins-cross-plugin",
        onConflict: (info) =>
          conflicts.push({
            key: info.key,
            existing: info.existingPluginId,
            incoming: info.incomingPluginId,
          }),
      })

      const first = reg.register("a", { value: "one" }, { pluginId: "p1" })
      expect(first).toBeUndefined()

      // p2 tries to take "a" — rejected, p1 keeps it.
      const rejected = reg.register("a", { value: "two" }, { pluginId: "p2" })
      expect(rejected?.entry.value).toBe("one")
      expect(reg.get("a")).toEqual({ value: "one" })
      expect(reg.getEntry("a")?.pluginId).toBe("p1")
      expect(conflicts).toEqual([{ key: "a", existing: "p1", incoming: "p2" }])
    })

    it("lets the same plugin refresh its own entry (hot-reload / snapshot restore)", () => {
      const onConflict = jest.fn()
      const reg = createOverlayRegistry<TestEntry>({
        conflictPolicy: "first-wins-cross-plugin",
        onConflict,
      })

      reg.register("a", { value: "one" }, { pluginId: "p1" })
      reg.register("a", { value: "refreshed" }, { pluginId: "p1" })

      expect(reg.get("a")).toEqual({ value: "refreshed" })
      expect(onConflict).not.toHaveBeenCalled()
    })

    it("does not fire onConflict for the default last-wins policy", () => {
      const onConflict = jest.fn()
      const reg = createOverlayRegistry<TestEntry>({ onConflict })
      reg.register("a", { value: "one" }, { pluginId: "p1" })
      reg.register("a", { value: "two" }, { pluginId: "p2" })
      // last-wins overwrites and never reports.
      expect(reg.get("a")).toEqual({ value: "two" })
      expect(onConflict).not.toHaveBeenCalled()
    })
  })

  describe("metadata", () => {
    it("stamps metadata onto stored entries surfaced via getEntry / entries", () => {
      let n = 0
      const reg = createOverlayRegistry<TestEntry>({
        metadata: () => ({ order: ++n }),
      })
      reg.register("a", { value: "one" }, { pluginId: "p1" })
      reg.register("b", { value: "two" }, { pluginId: "p2" })

      expect(reg.getEntry("a")?.meta).toEqual({ order: 1 })
      expect(reg.entries().map((e) => e.meta)).toEqual([{ order: 1 }, { order: 2 }])
    })
  })

  describe("isolation between instances", () => {
    it("two registries created from the factory share no state", () => {
      const a = createOverlayRegistry<TestEntry>()
      const b = createOverlayRegistry<TestEntry>()

      a.register("shared-id", { value: "from-a" }, { pluginId: "plug" })
      b.register("shared-id", { value: "from-b" }, { pluginId: "plug" })

      // Each registry holds its own value under the same id.
      expect(a.get("shared-id")).toEqual({ value: "from-a" })
      expect(b.get("shared-id")).toEqual({ value: "from-b" })

      // Removing from one does not affect the other.
      a.unregisterById("shared-id")
      expect(a.get("shared-id")).toBeUndefined()
      expect(b.get("shared-id")).toEqual({ value: "from-b" })

      // Same for unregisterByPlugin.
      const removed = b.unregisterByPlugin("plug")
      expect(removed).toBe(1)
      // a was already empty, so a.unregisterByPlugin would return 0.
      expect(a.unregisterByPlugin("plug")).toBe(0)
    })
  })
})
