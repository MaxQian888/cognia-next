/**
 * Contract test: any object registered as a shared-memory adapter must
 * implement the required method surface. Used as a self-validation gate so a
 * malformed plugin contribution fails loudly rather than at runtime mid-sync.
 */

import type { PluginSharedMemoryAdapterDef } from "@/types/plugin/plugin-shared-memory-adapter"

const REQUIRED_METHODS = ["write", "read", "listChanges", "delete"] as const

export function assertValidSharedMemoryAdapter(adapter: PluginSharedMemoryAdapterDef): void {
  if (!adapter.id) throw new Error("shared-memory adapter missing id")
  if (!adapter.name) throw new Error(`shared-memory adapter ${adapter.id} missing name`)
  for (const m of REQUIRED_METHODS) {
    if (typeof adapter[m] !== "function") {
      throw new Error(`shared-memory adapter ${adapter.id} missing method ${m}`)
    }
  }
}

describe("shared-memory adapter contract", () => {
  const valid: PluginSharedMemoryAdapterDef = {
    id: "x",
    name: "X",
    write: async () => {},
    read: async () => undefined,
    listChanges: async () => ({ entries: [], cursor: 0 }),
    delete: async () => {},
  }

  it("accepts a fully-implemented adapter", () => {
    expect(() => assertValidSharedMemoryAdapter(valid)).not.toThrow()
  })

  it("rejects an adapter missing a required method", () => {
    const broken = { ...valid } as Partial<PluginSharedMemoryAdapterDef>
    delete broken.listChanges
    expect(() => assertValidSharedMemoryAdapter(broken as PluginSharedMemoryAdapterDef)).toThrow(
      /listChanges/
    )
  })

  it("rejects an adapter without an id", () => {
    const broken = { ...valid, id: "" }
    expect(() => assertValidSharedMemoryAdapter(broken)).toThrow(/missing id/)
  })
})
