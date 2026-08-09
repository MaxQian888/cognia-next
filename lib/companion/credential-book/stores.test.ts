/**
 * @jest-environment jsdom
 */
import {
  ACTIVE_HOST_KEY,
  HOST_BOOK_KEY,
  LocalStorageHostRecordStore,
  SecureStorageHostCredentialStore,
  SecureStorageHostRecordStore,
  VaultHostCredentialStore,
  emptyHostBook,
  parseHostBook,
  type HostBookEnvelope,
} from "./stores"
import type { CompanionHostKey, CompanionHostRecord } from "./types"

const KEY: CompanionHostKey = { hostId: "host-1", accountNamespace: "acct_a" }
const DEVICE_KEY: JsonWebKey = { kty: "EC", crv: "P-256", d: "device-a" }
const DEVICE_KEY_B: JsonWebKey = { kty: "EC", crv: "P-256", d: "device-b" }

function record(): CompanionHostRecord {
  return {
    hostId: "host-1",
    accountNamespace: "acct_a",
    label: "Studio",
    endpoints: { baseUrl: "https://10.0.0.1:27890" },
    tlsPin: "aa11",
    cursorNamespace: "acct_a:host-1",
    deviceId: "dev-1",
    deviceKeyThumbprint: "thumbprint-a",
    serverVersion: "0.2.0",
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
}

function book(): HostBookEnvelope {
  return { version: 2, hosts: { "acct_a:host-1": record() }, active: { acct_a: "acct_a:host-1" } }
}

describe("parseHostBook", () => {
  it("treats absence as an empty book", () => {
    expect(parseHostBook(null)).toEqual(emptyHostBook())
  })

  it("round-trips a valid book", () => {
    expect(parseHostBook(JSON.stringify(book()))).toEqual(book())
  })

  it("defaults a missing active map", () => {
    const raw = JSON.stringify({ version: 2, hosts: {} })
    expect(parseHostBook(raw).active).toEqual({})
  })

  it.each([
    ["invalid JSON", "{oops", /not valid JSON/],
    ["a non-object root", "[]", /not an object/],
    ["an unsupported version", JSON.stringify({ version: 9, hosts: {} }), /is not supported/],
    ["a missing host map", JSON.stringify({ version: 2 }), /no host map/],
    ["a non-object host map", JSON.stringify({ version: 2, hosts: [] }), /no host map/],
  ])("throws on %s rather than silently resetting", (_label, raw, matcher) => {
    expect(() => parseHostBook(raw)).toThrow(matcher)
  })
})

describe("LocalStorageHostRecordStore", () => {
  beforeEach(() => localStorage.clear())

  it("round-trips through localStorage", async () => {
    const store = new LocalStorageHostRecordStore()
    await store.write(book())
    expect(await store.read()).toEqual(book())
  })

  it("returns an empty book when nothing was written", async () => {
    expect(await new LocalStorageHostRecordStore().read()).toEqual(emptyHostBook())
  })

  it("removes both keys when the last host goes", async () => {
    const store = new LocalStorageHostRecordStore()
    await store.write(book())
    localStorage.setItem(ACTIVE_HOST_KEY, "stale")
    await store.write(emptyHostBook())
    expect(localStorage.getItem(HOST_BOOK_KEY)).toBeNull()
    expect(localStorage.getItem(ACTIVE_HOST_KEY)).toBeNull()
  })

  it("propagates corruption instead of reporting no pairings", async () => {
    localStorage.setItem(HOST_BOOK_KEY, "{oops")
    await expect(new LocalStorageHostRecordStore().read()).rejects.toThrow(/not valid JSON/)
  })
})

describe("VaultHostCredentialStore", () => {
  function vault(accountId = "acct_a") {
    const secrets = new Map<string, string>()
    return {
      secrets,
      accountId,
      async storeSecret(name: string, value: string) {
        secrets.set(name, value)
      },
      async loadSecret(name: string) {
        return secrets.get(name) ?? null
      },
      async deleteSecret(name: string) {
        secrets.delete(name)
      },
    }
  }

  it("round-trips a token and a signing key", async () => {
    const session = vault()
    const store = new VaultHostCredentialStore(() => session)
    const jwk: JsonWebKey = { kty: "EC", crv: "P-256", d: "x", x: "y", z: "z" } as JsonWebKey
    await store.save(KEY, { devicePrivateKeyJwk: DEVICE_KEY, signalingPrivateKeyJwk: jwk })
    expect(await store.load(KEY)).toEqual({
      devicePrivateKeyJwk: DEVICE_KEY,
      signalingPrivateKeyJwk: jwk,
    })
  })

  it("returns null when the host has no token", async () => {
    expect(await new VaultHostCredentialStore(() => vault()).load(KEY)).toBeNull()
  })

  it("clears a stale signing key when saving without one", async () => {
    const session = vault()
    const store = new VaultHostCredentialStore(() => session)
    await store.save(KEY, {
      devicePrivateKeyJwk: DEVICE_KEY,
      signalingPrivateKeyJwk: {} as JsonWebKey,
    })
    await store.save(KEY, { devicePrivateKeyJwk: DEVICE_KEY_B })
    expect(await store.load(KEY)).toEqual({ devicePrivateKeyJwk: DEVICE_KEY_B })
  })

  it("removes both secrets", async () => {
    const session = vault()
    const store = new VaultHostCredentialStore(() => session)
    await store.save(KEY, {
      devicePrivateKeyJwk: DEVICE_KEY,
      signalingPrivateKeyJwk: {} as JsonWebKey,
    })
    await store.remove(KEY)
    expect(session.secrets.size).toBe(0)
  })

  it("refuses to work with a locked Vault", async () => {
    const store = new VaultHostCredentialStore(() => null)
    await expect(store.load(KEY)).rejects.toThrow(/must be unlocked/)
  })

  it("refuses to reach another account's credential", async () => {
    const store = new VaultHostCredentialStore(() => vault("acct_other"))
    await expect(store.load(KEY)).rejects.toThrow(/cannot be reached from the acct_other Vault/)
    await expect(store.save(KEY, { devicePrivateKeyJwk: DEVICE_KEY })).rejects.toThrow(
      /cannot be reached/
    )
    await expect(store.remove(KEY)).rejects.toThrow(/cannot be reached/)
  })

  it("names secrets per host so two hosts never share a slot", async () => {
    const session = vault()
    const store = new VaultHostCredentialStore(() => session)
    await store.save(KEY, { devicePrivateKeyJwk: DEVICE_KEY })
    await store.save({ ...KEY, hostId: "host-2" }, { devicePrivateKeyJwk: DEVICE_KEY_B })
    expect(await store.load(KEY)).toEqual({ devicePrivateKeyJwk: DEVICE_KEY })
    expect(await store.load({ ...KEY, hostId: "host-2" })).toEqual({
      devicePrivateKeyJwk: DEVICE_KEY_B,
    })
  })
})

describe("SecureStorage stores", () => {
  function plugin() {
    const values = new Map<string, string>()
    return {
      values,
      async set({ key, value }: { key: string; value: string }) {
        values.set(key, value)
        return { value: true }
      },
      async get({ key }: { key: string }) {
        if (!values.has(key)) throw new Error("not found")
        return { value: values.get(key)! }
      },
      async remove({ key }: { key: string }) {
        values.delete(key)
        return { value: true }
      },
    }
  }

  it("round-trips a credential through the keystore", async () => {
    const native = plugin()
    const store = new SecureStorageHostCredentialStore(async () => native)
    await store.save(KEY, {
      devicePrivateKeyJwk: DEVICE_KEY,
      signalingPrivateKeyJwk: {} as JsonWebKey,
    })
    expect(await store.load(KEY)).toEqual({
      devicePrivateKeyJwk: DEVICE_KEY,
      signalingPrivateKeyJwk: {},
    })
  })

  it("treats a missing key as not paired", async () => {
    const store = new SecureStorageHostCredentialStore(async () => plugin())
    expect(await store.load(KEY)).toBeNull()
  })

  it("tolerates a host with no signing key", async () => {
    const native = plugin()
    const store = new SecureStorageHostCredentialStore(async () => native)
    await store.save(KEY, { devicePrivateKeyJwk: DEVICE_KEY })
    expect(await store.load(KEY)).toEqual({ devicePrivateKeyJwk: DEVICE_KEY })
  })

  it("removes both slots idempotently", async () => {
    const native = plugin()
    const store = new SecureStorageHostCredentialStore(async () => native)
    await store.save(KEY, { devicePrivateKeyJwk: DEVICE_KEY })
    await store.remove(KEY)
    await expect(store.remove(KEY)).resolves.toBeUndefined()
    expect(native.values.size).toBe(0)
  })

  it("round-trips the record book through the keystore", async () => {
    const native = plugin()
    const store = new SecureStorageHostRecordStore(async () => native)
    await store.write(book())
    expect(await store.read()).toEqual(book())
  })

  it("reports an empty book when the keystore has none", async () => {
    const store = new SecureStorageHostRecordStore(async () => plugin())
    expect(await store.read()).toEqual(emptyHostBook())
  })

  it("propagates a corrupt book rather than reporting no pairings", async () => {
    const native = plugin()
    await native.set({ key: HOST_BOOK_KEY, value: "{oops" })
    const store = new SecureStorageHostRecordStore(async () => native)
    await expect(store.read()).rejects.toThrow(/Companion host book/)
  })

  it("removes the book when the last host goes", async () => {
    const native = plugin()
    const store = new SecureStorageHostRecordStore(async () => native)
    await store.write(book())
    await store.write(emptyHostBook())
    expect(native.values.has(HOST_BOOK_KEY)).toBe(false)
  })

  it("stores no secret material in the record book", async () => {
    const native = plugin()
    const store = new SecureStorageHostRecordStore(async () => native)
    await store.write(book())
    expect(native.values.get(HOST_BOOK_KEY)).not.toContain("jwt")
  })
})
