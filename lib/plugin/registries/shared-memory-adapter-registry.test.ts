import type {
  PluginSharedMemoryAdapterDef,
  SharedMemoryAdapterChangeSet,
} from "@/types/plugin/plugin-shared-memory-adapter"
import {
  __resetSharedMemoryAdaptersForTesting,
  getSharedMemoryAdapter,
  getSharedMemoryAdapterEntry,
  listSharedMemoryAdapterEntries,
  listSharedMemoryAdapterIds,
  registerSharedMemoryAdapter,
  unregisterSharedMemoryAdapterById,
  unregisterSharedMemoryAdaptersByPlugin,
} from "./shared-memory-adapter-registry"

function makeAdapter(
  id: string,
  overrides: Partial<PluginSharedMemoryAdapterDef> = {}
): PluginSharedMemoryAdapterDef {
  return {
    id,
    name: `Adapter ${id}`,
    write: async () => {},
    read: async () => undefined,
    listChanges: async (): Promise<SharedMemoryAdapterChangeSet> => ({ entries: [], cursor: 0 }),
    delete: async () => {},
    ...overrides,
  }
}

describe("shared-memory-adapter-registry", () => {
  beforeEach(() => {
    __resetSharedMemoryAdaptersForTesting()
  })

  it("registers an adapter and retrieves it via get / getEntry / list", () => {
    const a = makeAdapter("gh:mem")
    const previous = registerSharedMemoryAdapter("gh:mem", a, { pluginId: "gh" })
    expect(previous).toBeUndefined()
    expect(getSharedMemoryAdapter("gh:mem")).toBe(a)
    expect(getSharedMemoryAdapterEntry("gh:mem")).toEqual({ entry: a, pluginId: "gh" })
    expect(listSharedMemoryAdapterIds()).toEqual(["gh:mem"])
    expect(listSharedMemoryAdapterEntries()).toEqual([{ id: "gh:mem", entry: a, pluginId: "gh" }])
  })

  it("unregisterByPlugin drops every adapter from the given pluginId", () => {
    registerSharedMemoryAdapter("a", makeAdapter("a"), { pluginId: "plug" })
    registerSharedMemoryAdapter("b", makeAdapter("b"), { pluginId: "plug" })
    expect(unregisterSharedMemoryAdaptersByPlugin("plug")).toBe(2)
    expect(listSharedMemoryAdapterIds()).toEqual([])
  })

  it("unregisterByPlugin leaves entries from other plugins alone", () => {
    registerSharedMemoryAdapter("a", makeAdapter("a"), { pluginId: "A" })
    const b = makeAdapter("b")
    registerSharedMemoryAdapter("b", b, { pluginId: "B" })
    expect(unregisterSharedMemoryAdaptersByPlugin("A")).toBe(1)
    expect(getSharedMemoryAdapter("b")).toBe(b)
  })

  it("unregisterById removes only the matching entry", () => {
    registerSharedMemoryAdapter("a", makeAdapter("a"))
    registerSharedMemoryAdapter("b", makeAdapter("b"))
    expect(unregisterSharedMemoryAdapterById("a")).toBe(true)
    expect(getSharedMemoryAdapter("a")).toBeUndefined()
    expect(getSharedMemoryAdapter("b")).toBeDefined()
    expect(unregisterSharedMemoryAdapterById("a")).toBe(false)
  })

  it("__resetSharedMemoryAdaptersForTesting clears everything", () => {
    registerSharedMemoryAdapter("a", makeAdapter("a"), { pluginId: "p1" })
    __resetSharedMemoryAdaptersForTesting()
    expect(listSharedMemoryAdapterIds()).toEqual([])
  })
})
