import { createAuthSecretsAdapter, type SecretsBackend } from "./auth-secrets-adapter"

function memoryBackend(): SecretsBackend & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k),
  }
}

describe("auth-secrets-adapter", () => {
  it("set stores the value and tracks it in the index", async () => {
    const backend = memoryBackend()
    const adapter = createAuthSecretsAdapter(backend)
    await adapter.set("auth:github:s1", "tok")
    expect(await adapter.get("auth:github:s1")).toBe("tok")
    expect(await adapter.list("auth:")).toEqual(["auth:github:s1"])
  })

  it("list filters by prefix", async () => {
    const backend = memoryBackend()
    const adapter = createAuthSecretsAdapter(backend)
    await adapter.set("auth:github:s1", "a")
    await adapter.set("auth:acme:s2", "b")
    await adapter.set("other:x", "c")
    expect((await adapter.list("auth:")).sort()).toEqual(["auth:acme:s2", "auth:github:s1"])
    expect(await adapter.list("auth:acme")).toEqual(["auth:acme:s2"])
  })

  it("delete removes the value and the index entry", async () => {
    const backend = memoryBackend()
    const adapter = createAuthSecretsAdapter(backend)
    await adapter.set("auth:github:s1", "a")
    await adapter.delete("auth:github:s1")
    expect(await adapter.get("auth:github:s1")).toBeUndefined()
    expect(await adapter.list("auth:")).toEqual([])
  })

  it("does not duplicate index entries on repeated set", async () => {
    const backend = memoryBackend()
    const adapter = createAuthSecretsAdapter(backend)
    await adapter.set("auth:github:s1", "a")
    await adapter.set("auth:github:s1", "b")
    expect(await adapter.list("auth:")).toEqual(["auth:github:s1"])
    expect(await adapter.get("auth:github:s1")).toBe("b")
  })

  it("degrades to empty list when the index is corrupt", async () => {
    const backend = memoryBackend()
    backend.store.set("auth:__index__", "{not json")
    const adapter = createAuthSecretsAdapter(backend)
    expect(await adapter.list("auth:")).toEqual([])
  })

  it("get returns undefined (not null) for a missing key", async () => {
    const adapter = createAuthSecretsAdapter(memoryBackend())
    expect(await adapter.get("nope")).toBeUndefined()
  })
})
