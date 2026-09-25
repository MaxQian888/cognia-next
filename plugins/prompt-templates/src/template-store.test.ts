import { createTemplateStore, KEY_PREFIX } from "./template-store"

function makeStorage(seed: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(seed))
  return {
    map,
    storage: {
      get: async <T>(key: string) => map.get(key) as T | undefined,
      set: async (key: string, value: unknown) => {
        map.set(key, value)
      },
      remove: async (key: string) => {
        map.delete(key)
      },
      keys: async () => Array.from(map.keys()),
    },
  }
}

describe("template store", () => {
  it("lists and reads only template keys, sorted by name", async () => {
    const { storage } = makeStorage({
      "template:zebra": "z",
      unrelated: "nope",
      "template:alpha": "a",
    })
    const store = createTemplateStore(storage)
    await expect(store.list()).resolves.toEqual(["alpha", "zebra"])
    await expect(store.readAll()).resolves.toEqual([
      { name: "alpha", body: "a" },
      { name: "zebra", body: "z" },
    ])
  })

  it("stores and returns multi-line bodies verbatim", async () => {
    const { storage, map } = makeStorage()
    const store = createTemplateStore(storage)
    const body = "Line one\n\n  indented line two\n"
    await store.save("review", body)
    expect(map.get(`${KEY_PREFIX}review`)).toBe(body)
    await expect(store.read("review")).resolves.toBe(body)
  })

  it("treats a non-string stored value as missing", async () => {
    const { storage } = makeStorage({ "template:weird": 42 })
    await expect(createTemplateStore(storage).read("weird")).resolves.toBeUndefined()
  })

  it("reports whether a removal found anything", async () => {
    const { storage, map } = makeStorage({ "template:a": "x" })
    const store = createTemplateStore(storage)
    await expect(store.remove("missing")).resolves.toBe(false)
    await expect(store.remove("a")).resolves.toBe(true)
    expect(map.has("template:a")).toBe(false)
  })

  it("notifies subscribers after every save and effective removal", async () => {
    const { storage } = makeStorage()
    const store = createTemplateStore(storage)
    const listener = jest.fn()
    const unsubscribe = store.subscribe(listener)
    await store.save("a", "x")
    await store.remove("missing")
    await store.remove("a")
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    await store.save("b", "y")
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
