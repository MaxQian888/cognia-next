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

  it("exports raw DEK material only across an authenticated v1 pairing transport", async () => {
    const fixture = secretStore()
    const store = createProfileDekStore({
      secretStore: fixture.store,
      requireUnlocked: () => true,
      now: () => 10,
    })
    const created = await store.getOrCreate("profile-1")

    await expect(
      store.exportForPairing("profile-1", {
        authenticated: false,
        protocolVersion: 1,
      })
    ).rejects.toThrow("authenticated pairing transport")
    await expect(
      store.exportForPairing("profile-1", {
        authenticated: true,
        protocolVersion: 0,
      })
    ).rejects.toBeInstanceOf(ProfileDekProtocolError)

    const exported = await store.exportForPairing("profile-1", {
      authenticated: true,
      protocolVersion: 1,
    })
    expect(exported.profileId).toBe("profile-1")
    expect(exported.keyId).toBe(created.keyId)
    expect(exported.rawKey).toHaveLength(32)
  })

  it("wraps a profile DEK with a backup passphrase and imports it without plaintext material", async () => {
    const sourceSecrets = secretStore()
    const source = createProfileDekStore({
      secretStore: sourceSecrets.store,
      requireUnlocked: () => true,
      now: () => 10,
    })
    const original = await source.getOrCreate("profile-1")
    const wrapped = await source.exportPortable("profile-1", "correct horse battery staple")
    const serialized = JSON.stringify(wrapped)

    expect(serialized).not.toContain(
      sourceSecrets.values.get(`material:profile-1:${original.keyId}`)
    )
    expect(wrapped).toMatchObject({ version: 1, profileId: "profile-1", keyId: original.keyId })

    const targetSecrets = secretStore()
    const target = createProfileDekStore({
      secretStore: targetSecrets.store,
      requireUnlocked: () => true,
    })
    await expect(target.importPortable(wrapped, "wrong passphrase")).rejects.toBeDefined()
    await target.importPortable(wrapped, "correct horse battery staple")
    await expect(target.load("profile-1", original.keyId)).resolves.toMatchObject({
      profileId: "profile-1",
      keyId: original.keyId,
    })
  })

  it("discovers legacy keys and validates a portable batch before changing the target", async () => {
    const sourceSecrets = secretStore()
    const source = createProfileDekStore({
      secretStore: sourceSecrets.store,
      requireUnlocked: () => true,
      now: () => 10,
    })
    const first = await source.getOrCreate("profile-1")
    const second = await source.getOrCreate("profile-2")
    const envelopes = await Promise.all([
      source.exportPortable("profile-1", "backup-passphrase"),
      source.exportPortable("profile-2", "backup-passphrase"),
    ])

    // Simulate keys created before the profile registry existed.
    sourceSecrets.values.delete("profiles")
    await expect(source.listProfileIds(["profile-2", "profile-1", "missing"])).resolves.toEqual([
      "profile-1",
      "profile-2",
    ])

    const targetSecrets = secretStore()
    const target = createProfileDekStore({
      secretStore: targetSecrets.store,
      requireUnlocked: () => true,
    })
    const existingTargetKey = await target.getOrCreate("profile-1")
    const tampered = { ...envelopes[1], ciphertext: `${envelopes[1].ciphertext}broken` }
    await expect(
      target.importPortableBatch([envelopes[0], tampered], "backup-passphrase", {
        activate: "if-missing",
      })
    ).rejects.toBeDefined()
    await expect(target.load("profile-1", first.keyId)).resolves.toBeNull()
    await expect(target.load("profile-2", second.keyId)).resolves.toBeNull()

    await target.importPortableBatch(envelopes, "backup-passphrase", {
      activate: "if-missing",
    })
    await expect(target.listProfileIds()).resolves.toEqual(["profile-1", "profile-2"])
    await expect(target.getOrCreate("profile-1")).resolves.toMatchObject({
      keyId: existingTargetKey.keyId,
    })
    await expect(target.load("profile-1", first.keyId)).resolves.toMatchObject({
      keyId: first.keyId,
    })
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
    expect(fixture.values.size).toBe(3) // registry + active pointer + versioned key material
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
