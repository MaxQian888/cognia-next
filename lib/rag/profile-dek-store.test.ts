import {
  ProfileDekProtocolError,
  RetrievalVaultLockedError,
  createProfileDekStore,
} from "./profile-dek-store"

function secretStore() {
  const values = new Map<string, string>()
  return {
    values,
    store: {
      isPersistent: () => true,
      save: async (key: string, value: string) => void values.set(key, value),
      load: async (key: string) => values.get(key) ?? null,
      delete: async (key: string) => void values.delete(key),
    },
  }
}

describe("ProfileDekStore", () => {
  it("fails locked instead of creating an in-memory or plaintext fallback", async () => {
    const fixture = secretStore()
    const store = createProfileDekStore({
      secretStore: fixture.store,
      requireUnlocked: () => false,
    })

    await expect(store.getOrCreate("profile-1")).rejects.toBeInstanceOf(RetrievalVaultLockedError)
    expect(fixture.values.size).toBe(0)
  })

  it("creates one non-extractable AES-256-GCM DEK and reloads it by key id", async () => {
    const fixture = secretStore()
    const store = createProfileDekStore({
      secretStore: fixture.store,
      requireUnlocked: () => true,
    })

    const first = await store.getOrCreate("profile-1")
    const second = await store.getOrCreate("profile-1")

    expect(first.keyId).toBe(second.keyId)
    expect(first.key.extractable).toBe(false)
    expect(first.key.algorithm).toEqual({ name: "AES-GCM", length: 256 })
    expect(fixture.values.size).toBe(2) // active pointer + versioned key material
  })

  it("accepts paired ciphertext keys only for authenticated protocol v1 clients", async () => {
    const fixture = secretStore()
    const store = createProfileDekStore({
      secretStore: fixture.store,
      requireUnlocked: () => true,
    })
    const rawKey = crypto.getRandomValues(new Uint8Array(32))

    await expect(
      store.importPaired("profile-1", "dek-remote", rawKey, {
        authenticated: true,
        protocolVersion: 0,
      })
    ).rejects.toBeInstanceOf(ProfileDekProtocolError)
    await expect(
      store.importPaired("profile-1", "dek-remote", rawKey, {
        authenticated: false,
        protocolVersion: 1,
      })
    ).rejects.toThrow("authenticated")

    await store.importPaired("profile-1", "dek-remote", rawKey, {
      authenticated: true,
      protocolVersion: 1,
    })
    await expect(store.getOrCreate("profile-1")).resolves.toMatchObject({ keyId: "dek-remote" })
  })
})
