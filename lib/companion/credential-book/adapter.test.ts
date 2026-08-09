/**
 * @jest-environment jsdom
 */
import type { CompanionConfig } from "@/lib/tauri/companion-storage"

import {
  buildRoomDescriptorV2,
  generatePersistableV2SigningIdentity,
  generateV2SigningKeyPair,
} from "@/lib/signaling/v2-crypto"

import { CredentialBookCompanionStorage, toCompanionConfig } from "./adapter"
import { createCredentialBook } from "./book"
import {
  emptyHostBook,
  type HostBookEnvelope,
  type HostCredentialStore,
  type HostRecordStore,
} from "./stores"
import type {
  CompanionCredentialBook,
  CompanionHostCredential,
  CompanionHostKey,
  CompanionHostRecord,
} from "./types"

const DEVICE_KEY: JsonWebKey = { kty: "EC", crv: "P-256", d: "device-key" }

function memoryRecords(): HostRecordStore {
  let book: HostBookEnvelope = emptyHostBook()
  return {
    async read() {
      return JSON.parse(JSON.stringify(book)) as HostBookEnvelope
    },
    async write(next) {
      book = JSON.parse(JSON.stringify(next)) as HostBookEnvelope
    },
  }
}

function memoryCredentials(): HostCredentialStore {
  const entries = new Map<string, CompanionHostCredential>()
  const id = (key: CompanionHostKey) => `${key.accountNamespace}/${key.hostId}`
  return {
    async load(key) {
      return entries.get(id(key)) ?? null
    },
    async save(key, credential) {
      entries.set(id(key), credential)
    },
    async remove(key) {
      entries.delete(id(key))
    },
  }
}

function config(patch: Partial<CompanionConfig> = {}): CompanionConfig {
  return {
    baseUrl: "https://studio.local:27890",
    devicePrivateKeyJwk: DEVICE_KEY,
    deviceKeyThumbprint: "thumbprint-a",
    deviceId: "dev-1",
    serverVersion: "0.2.0",
    serverFingerprint: "aa11",
    ...patch,
  }
}

function harness(
  accountNamespace: () => string | null = () => "acct_a",
  activeHostId?: () => string | null | undefined
) {
  const book = createCredentialBook({
    records: memoryRecords(),
    credentials: memoryCredentials(),
  })
  return {
    book,
    storage: new CredentialBookCompanionStorage({ book, accountNamespace, activeHostId }),
  }
}

describe("toCompanionConfig", () => {
  const record: CompanionHostRecord = {
    hostId: "host-1",
    accountNamespace: "acct_a",
    label: "Studio",
    endpoints: {
      baseUrl: "https://studio.local:27890",
      lanBaseUrl: "https://lan",
      tunnelBaseUrl: "https://tunnel",
    },
    tlsPin: "aa11",
    cursorNamespace: "acct_a:host-1",
    deviceId: "dev-1",
    deviceKeyThumbprint: "thumbprint-a",
    serverVersion: "0.2.0",
    rendezvousId: "r1",
    connection: {
      status: "unknown",
      generation: 0,
      lastOkAt: null,
      lastErrorAt: null,
      lastError: null,
    },
    createdAt: 1,
    updatedAt: 1,
  }

  it("flattens a record and credential back into the legacy shape", async () => {
    expect(await toCompanionConfig(record, { devicePrivateKeyJwk: DEVICE_KEY })).toEqual({
      targetId: "host-1",
      baseUrl: "https://studio.local:27890",
      lanBaseUrl: "https://lan",
      tunnelBaseUrl: "https://tunnel",
      devicePrivateKeyJwk: DEVICE_KEY,
      deviceKeyThumbprint: "thumbprint-a",
      deviceId: "dev-1",
      serverVersion: "0.2.0",
      serverFingerprint: "aa11",
      rendezvousId: "r1",
      accountId: "acct_a",
    })
  })

  it("omits optional fields that the record does not carry", async () => {
    const bare = { ...record, tlsPin: null, endpoints: { baseUrl: "https://x" } }
    delete (bare as Partial<CompanionHostRecord>).rendezvousId
    const flat = await toCompanionConfig(bare, { devicePrivateKeyJwk: DEVICE_KEY })
    expect("serverFingerprint" in flat).toBe(false)
    expect("lanBaseUrl" in flat).toBe(false)
    expect("rendezvousId" in flat).toBe(false)
  })

  async function room(): Promise<{
    descriptor: Awaited<ReturnType<typeof buildRoomDescriptorV2>>
    privateKeyJwk: JsonWebKey
  }> {
    const mobile = await generatePersistableV2SigningIdentity()
    const desktop = await generateV2SigningKeyPair()
    const descriptor = await buildRoomDescriptorV2({
      roomNonce: "AAECAwQFBgcICQoLDA0ODw",
      desktopSigningKey: desktop.encodedPublicKey,
      mobileSigningKey: mobile.encodedPublicKey,
      notAfter: Date.now() + 60_000,
    })
    return { descriptor, privateKeyJwk: mobile.privateKeyJwk }
  }

  it("imports the signing key into a CryptoKey when the host has a signaling room", async () => {
    const { descriptor, privateKeyJwk } = await room()
    const flat = await toCompanionConfig(
      { ...record, signalingRoomDescriptor: descriptor },
      { devicePrivateKeyJwk: DEVICE_KEY, signalingPrivateKeyJwk: privateKeyJwk }
    )
    expect(flat.signalingRoomDescriptor).toEqual(descriptor)
    expect(flat.signalingPrivateKeyJwk).toEqual(privateKeyJwk)
    expect(flat.signalingPrivateKey).toBeDefined()
    expect((flat.signalingPrivateKey as CryptoKey).type).toBe("private")
  })

  it("carries the room but no key when the credential has none", async () => {
    const { descriptor } = await room()
    const flat = await toCompanionConfig(
      { ...record, signalingRoomDescriptor: descriptor },
      { devicePrivateKeyJwk: DEVICE_KEY }
    )
    expect(flat.signalingRoomDescriptor).toEqual(descriptor)
    expect("signalingPrivateKey" in flat).toBe(false)
  })

  it("only carries the signing key when the host has a signaling room", async () => {
    const jwk = { kty: "EC" } as JsonWebKey
    const withoutRoom = await toCompanionConfig(record, {
      devicePrivateKeyJwk: DEVICE_KEY,
      signalingPrivateKeyJwk: jwk,
    })
    expect("signalingPrivateKeyJwk" in withoutRoom).toBe(false)
  })
})

describe("CredentialBookCompanionStorage", () => {
  it("round-trips a pairing through the book", async () => {
    const { storage } = harness()
    await storage.save(config())
    expect(await storage.load()).toMatchObject({
      baseUrl: "https://studio.local:27890",
      devicePrivateKeyJwk: DEVICE_KEY,
      deviceId: "dev-1",
      accountId: "acct_a",
      targetId: "dev-1",
      serverFingerprint: "aa11",
    })
  })

  it("uses the active local account while preserving the remote tenant separately", async () => {
    const { book, storage } = harness(() => "acct_ambient")
    await storage.save(config({ accountId: "acct_stale", tenantId: "tenant_remote" }))
    expect(await book.get({ hostId: "dev-1", accountNamespace: "acct_stale" })).toBeNull()
    expect(await book.get({ hostId: "dev-1", accountNamespace: "acct_ambient" })).toMatchObject({
      tenantId: "tenant_remote",
    })
    expect(await storage.load()).toMatchObject({
      accountId: "acct_ambient",
      tenantId: "tenant_remote",
    })
  })

  it("falls back to the reserved namespace when no account is active", async () => {
    const { book, storage } = harness(() => null)
    await storage.save(config())
    expect(await book.get({ hostId: "dev-1", accountNamespace: "__local__" })).not.toBeNull()
    expect(await storage.load()).toMatchObject({ accountId: "__local__" })
  })

  it("saves the active pairing and makes it active", async () => {
    const { book, storage } = harness()
    await storage.save(config())
    await storage.save(config({ deviceId: "dev-2", baseUrl: "https://laptop.local" }))
    expect((await book.getActive("acct_a"))?.hostId).toBe("dev-2")
    expect((await storage.load())?.deviceId).toBe("dev-2")
  })

  it("loads the host selected by the runtime target instead of a stale book pointer", async () => {
    let activeHostId: string | null | undefined = "host-1"
    const { storage } = harness(
      () => "acct_a",
      () => activeHostId
    )
    await storage.save(config({ targetId: "host-1", deviceId: "dev-1" }))
    await storage.save(
      config({
        targetId: "host-2",
        deviceId: "dev-2",
        baseUrl: "https://second.local",
      })
    )

    activeHostId = "host-1"
    await expect(storage.load()).resolves.toMatchObject({
      targetId: "host-1",
      deviceId: "dev-1",
      baseUrl: "https://studio.local:27890",
    })

    activeHostId = "web-standalone"
    await expect(storage.load()).resolves.toBeNull()
  })

  it("keeps a user-edited label across a re-save", async () => {
    const { book, storage } = harness()
    await storage.save(config())
    const key = { hostId: "dev-1", accountNamespace: "acct_a" }
    const current = (await book.get(key))!
    await book.upsert({ ...current, label: "My Studio" })
    await storage.save(config({ baseUrl: "https://moved.local" }))
    expect((await book.get(key))?.label).toBe("My Studio")
  })

  it("removes a newly-written private key when the public upsert fails", async () => {
    const stable = createCredentialBook({
      records: memoryRecords(),
      credentials: memoryCredentials(),
    })
    let fail = true
    const book: CompanionCredentialBook = {
      ...stable,
      async upsert(draft) {
        if (fail) {
          fail = false
          throw new Error("record write failed")
        }
        return stable.upsert(draft)
      },
    }
    const storage = new CredentialBookCompanionStorage({
      book,
      accountNamespace: () => "acct_a",
    })

    await expect(storage.save(config())).rejects.toThrow("record write failed")
    const key = { hostId: "dev-1", accountNamespace: "acct_a" }
    expect(await stable.get(key)).toBeNull()
    expect(await stable.loadCredential(key)).toBeNull()
  })

  it("restores an existing pairing when activating its update fails", async () => {
    const stable = createCredentialBook({
      records: memoryRecords(),
      credentials: memoryCredentials(),
    })
    let failActivation = false
    const book: CompanionCredentialBook = {
      ...stable,
      async setActive(key) {
        if (failActivation) {
          failActivation = false
          throw new Error("active pointer write failed")
        }
        return stable.setActive(key)
      },
    }
    const storage = new CredentialBookCompanionStorage({
      book,
      accountNamespace: () => "acct_a",
    })
    await storage.save(config())
    failActivation = true

    await expect(
      storage.save(
        config({
          baseUrl: "https://replacement.example",
          devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "replacement" },
        })
      )
    ).rejects.toThrow("active pointer write failed")
    await expect(storage.load()).resolves.toMatchObject({
      baseUrl: "https://studio.local:27890",
      devicePrivateKeyJwk: DEVICE_KEY,
    })
  })

  it("reports no pairing when nothing is stored", async () => {
    expect(await harness().storage.load()).toBeNull()
  })

  it("reports no pairing when the credential cannot be reached", async () => {
    const book = createCredentialBook({
      records: memoryRecords(),
      credentials: {
        ...memoryCredentials(),
        async load() {
          throw new Error("Browser Vault must be unlocked")
        },
      },
    })
    const storage = new CredentialBookCompanionStorage({ book, accountNamespace: () => "acct_a" })
    await book.upsert({
      hostId: "dev-1",
      accountNamespace: "acct_a",
      label: "Studio",
      endpoints: { baseUrl: "https://x" },
      tlsPin: null,
      deviceId: "dev-1",
      deviceKeyThumbprint: "device-thumbprint",
      serverVersion: "0.2.0",
    })
    expect(await storage.load()).toBeNull()
    // …but the public record is still listed, so Settings can show the host.
    expect(await book.list("acct_a")).toHaveLength(1)
  })

  it("reports no pairing when the record exists but has no credential", async () => {
    const { book, storage } = harness()
    await book.upsert({
      hostId: "dev-1",
      accountNamespace: "acct_a",
      label: "Studio",
      endpoints: { baseUrl: "https://x" },
      tlsPin: null,
      deviceId: "dev-1",
      deviceKeyThumbprint: "device-thumbprint",
      serverVersion: "0.2.0",
    })
    expect(await storage.load()).toBeNull()
  })

  it("clears only the active pairing, not every host", async () => {
    const { book, storage } = harness()
    await storage.save(config())
    await storage.save(config({ deviceId: "dev-2" }))
    await storage.clear()
    expect((await book.list("acct_a")).map((r) => r.hostId)).toEqual(["dev-1"])
  })

  it("clears the runtime-selected host even when the book pointer names another host", async () => {
    const activeHostId: string | null | undefined = "host-1"
    const { book, storage } = harness(
      () => "acct_a",
      () => activeHostId
    )
    await storage.save(config({ targetId: "host-1", deviceId: "dev-1" }))
    await storage.save(config({ targetId: "host-2", deviceId: "dev-2" }))
    await storage.clear()

    expect((await book.list("acct_a")).map((record) => record.hostId)).toEqual(["host-2"])
    expect(await book.loadCredential({ accountNamespace: "acct_a", hostId: "host-1" })).toBeNull()
  })

  it("removes an explicitly named pairing without relying on either active pointer", async () => {
    const { book, storage } = harness()
    await storage.save(config({ targetId: "host-1", deviceId: "dev-1" }))
    await storage.save(config({ targetId: "host-2", deviceId: "dev-2" }))

    await storage.remove(config({ targetId: "host-1", deviceId: "dev-1", accountId: "acct_a" }))

    expect((await book.list("acct_a")).map((record) => record.hostId)).toEqual(["host-2"])
    expect(await book.loadCredential({ accountNamespace: "acct_a", hostId: "host-1" })).toBeNull()
  })

  it("clearing with nothing paired is a no-op", async () => {
    const { storage } = harness()
    await expect(storage.clear()).resolves.toBeUndefined()
  })

  it("does not clear another account's pairings", async () => {
    let activeAccount = "acct_a"
    const { book, storage } = harness(() => activeAccount)
    await storage.save(config())
    activeAccount = "acct_b"
    await storage.save(config({ deviceId: "dev-b" }))
    activeAccount = "acct_a"
    await storage.clear()
    expect(await book.list("acct_b")).toHaveLength(1)
  })
})

describe("book contract used by the adapter", () => {
  it("exposes exactly the operations the adapter relies on", () => {
    const book: CompanionCredentialBook = createCredentialBook({
      records: memoryRecords(),
      credentials: memoryCredentials(),
    })
    for (const method of [
      "list",
      "get",
      "upsert",
      "remove",
      "getActive",
      "setActive",
      "loadCredential",
      "saveCredential",
      "updateConnection",
    ] as const) {
      expect(typeof book[method]).toBe("function")
    }
  })
})
