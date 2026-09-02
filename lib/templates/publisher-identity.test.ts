import type { KeyringStore } from "@/lib/credentials/keyring-store"
import { decodeBase64 } from "@/lib/share/encoding"
import {
  createPublisherSigner,
  getOrCreatePublisherIdentity,
  getPublisherIdentity,
  publisherFingerprint,
  publisherIdentityIsPersistent,
  rotatePublisherIdentity,
  signManifest,
} from "./publisher-identity"

function memoryStore(persistent = true): KeyringStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    async save(key, value) {
      map.set(key, value)
    },
    async load(key) {
      return map.get(key) ?? null
    },
    async delete(key) {
      map.delete(key)
    },
    isPersistent() {
      return persistent
    },
  }
}

describe("publisher identity", () => {
  it("mints one key pair and reuses it", async () => {
    const store = memoryStore()
    const first = await getOrCreatePublisherIdentity({ store, now: () => 1000 })
    const second = await getOrCreatePublisherIdentity({ store, now: () => 2000 })
    expect(second).toEqual(first)
    expect(store.map.size).toBe(1)
    expect(decodeBase64(first.publicKey)).toHaveLength(32)
    expect(first.createdAt).toBe(1000)
  })

  it("derives the fingerprint the plugin ledger uses (sha256 of the raw key)", async () => {
    const store = memoryStore()
    const identity = await getOrCreatePublisherIdentity({ store })
    expect(identity.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(await publisherFingerprint(identity.publicKey)).toBe(identity.fingerprint)
  })

  it("keeps the private key out of the public view but inside the store", async () => {
    const store = memoryStore()
    const identity = await getOrCreatePublisherIdentity({ store })
    expect(identity).not.toHaveProperty("privateKey")
    expect(store.map.get("active")).toContain("privateKey")
  })

  it("defaults the publisher name to a fingerprint prefix and honours an override", async () => {
    const store = memoryStore()
    const identity = await getOrCreatePublisherIdentity({ store })
    expect(identity.publisher).toBe(`cognia:${identity.fingerprint.slice(0, 12)}`)

    const named = memoryStore()
    expect(
      (await getOrCreatePublisherIdentity({ store: named, publisher: "Acme" })).publisher
    ).toBe("Acme")
  })

  it("signs 64 bytes that verify against the stored public key", async () => {
    const store = memoryStore()
    const identity = await getOrCreatePublisherIdentity({ store })
    const payload = new TextEncoder().encode('{"id":"pkg"}')
    const signature = await signManifest(payload, { store })
    expect(signature).toHaveLength(64)

    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(decodeBase64(identity.publicKey)) as unknown as BufferSource,
      "Ed25519",
      false,
      ["verify"]
    )
    await expect(
      crypto.subtle.verify(
        "Ed25519",
        key,
        Uint8Array.from(signature) as unknown as BufferSource,
        Uint8Array.from(payload) as unknown as BufferSource
      )
    ).resolves.toBe(true)
  })

  it("refuses to sign when no identity was created", async () => {
    await expect(signManifest(new Uint8Array([1]), { store: memoryStore() })).rejects.toThrow(
      /No template publisher identity/
    )
  })

  it("rotation replaces the key pair and keeps the name", async () => {
    const store = memoryStore()
    const before = await getOrCreatePublisherIdentity({ store, publisher: "Acme" })
    const after = await rotatePublisherIdentity({ store })
    expect(after.publisher).toBe("Acme")
    expect(after.publicKey).not.toBe(before.publicKey)
    expect(after.fingerprint).not.toBe(before.fingerprint)
  })

  it("reports a session-only store as not persistent", () => {
    expect(publisherIdentityIsPersistent({ store: memoryStore(false) })).toBe(false)
    expect(publisherIdentityIsPersistent({ store: memoryStore(true) })).toBe(true)
  })

  it("treats a corrupt record as absent rather than throwing", async () => {
    const store = memoryStore()
    await store.save("active", "{not json")
    expect(await getPublisherIdentity({ store })).toBeNull()
  })

  it("builds a signer that reports the same key it signs with", async () => {
    const store = memoryStore()
    const signer = await createPublisherSigner({ store, publisher: "Acme" })
    expect(signer.publisher).toBe("Acme")
    expect(signer.publicKey).toBe((await getPublisherIdentity({ store }))!.publicKey)
    expect(await signer.sign(new TextEncoder().encode("manifest"))).toHaveLength(64)
  })
})
