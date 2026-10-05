import { createMemoryKeyring } from "./memory-keyring"

describe("createMemoryKeyring", () => {
  it("stores, deletes and reports persistence", async () => {
    const store = createMemoryKeyring()
    await store.save("a", "1")
    expect(await store.load("a")).toBe("1")
    await store.delete("a")
    expect(await store.load("a")).toBeNull()
    expect(store.isPersistent!()).toBe(true)
    store.persistent = false
    expect(store.isPersistent!()).toBe(false)
  })
})
