/**
 * SSR / static-export behaviour of the credential-book adapter.
 *
 * Its own file because jsdom's `window` is non-configurable — the only honest
 * way to test the no-window path is to run in the node environment, where the
 * global genuinely does not exist. Mirrors `companion-storage.ssr.test.ts`.
 *
 * @jest-environment node
 */
import type { CompanionConfig } from "@/lib/tauri/companion-storage"

import { CredentialBookCompanionStorage } from "./adapter"
import { createCredentialBook } from "./book"
import {
  emptyHostBook,
  type HostBookEnvelope,
  type HostCredentialStore,
  type HostRecordStore,
} from "./stores"
import type { CompanionHostCredential, CompanionHostKey } from "./types"

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

function config(): CompanionConfig {
  return {
    baseUrl: "https://studio.local:27890",
    devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
    deviceKeyThumbprint: "device-thumbprint",
    deviceId: "dev-1",
    serverVersion: "0.2.0",
  }
}

function harness() {
  const book = createCredentialBook({ records: memoryRecords(), credentials: memoryCredentials() })
  return {
    book,
    storage: new CredentialBookCompanionStorage({ book, accountNamespace: () => "acct_a" }),
  }
}

describe("CredentialBookCompanionStorage with no window", () => {
  it("confirms the environment really has no window", () => {
    expect(typeof window).toBe("undefined")
  })

  it("no-ops on save rather than throwing, matching the storage it replaced", async () => {
    const { book, storage } = harness()
    await expect(storage.save(config())).resolves.toBeUndefined()
    expect(await book.list()).toEqual([])
  })

  it("no-ops on clear", async () => {
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
    await expect(storage.clear()).resolves.toBeUndefined()
    expect(await book.list()).toHaveLength(1)
  })

  it("still reads a pairing that is already in the book", async () => {
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
    await book.saveCredential(
      { hostId: "dev-1", accountNamespace: "acct_a" },
      { devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" } }
    )
    expect((await storage.load())?.devicePrivateKeyJwk?.d).toBe("device-private")
  })
})
