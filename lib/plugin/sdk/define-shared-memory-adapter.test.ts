import { defineSharedMemoryAdapter } from "./define-shared-memory-adapter"

describe("defineSharedMemoryAdapter", () => {
  it("returns the adapter definition unchanged (pure pass-through)", () => {
    const write = jest.fn(async () => undefined)
    const read = jest.fn(async () => undefined)
    const listChanges = jest.fn(async () => ({ entries: [], cursor: 0 }))
    const del = jest.fn(async () => undefined)
    const def = defineSharedMemoryAdapter({
      id: "p:remote",
      name: "Remote store",
      write,
      read,
      listChanges,
      delete: del,
    })
    expect(def).toMatchObject({ id: "p:remote", name: "Remote store" })
    expect(def.write).toBe(write)
    expect(def.listChanges).toBe(listChanges)
  })
})
