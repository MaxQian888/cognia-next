/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import {
  __setPepperStoreForTests,
  clearDeviceKey,
  deriveDevicePepper,
  getOrCreateDeviceKey,
  isDefaultPepperStoreInstalled,
  supportsDevicePepper,
} from "./device-pepper"

// `fake-indexeddb` does not structured-clone a CryptoKey the way a real
// browser does, so the persistence layer is swapped for one that preserves
// object identity. Everything else, including the non-extractability that is
// the point of the module, runs against the real WebCrypto implementation.
const memory = new Map<string, CryptoKey>()

beforeEach(() => {
  memory.clear()
  __setPepperStoreForTests({
    get: async (key) => memory.get(key) ?? null,
    put: async (key, value) => {
      memory.set(key, value)
    },
    delete: async (key) => {
      memory.delete(key)
    },
  })
})

afterEach(() => {
  __setPepperStoreForTests(null)
})

describe("device pepper", () => {
  it("reports support where WebCrypto and IndexedDB both exist", () => {
    expect(supportsDevicePepper()).toBe(true)
  })

  it("uses the real IndexedDB store in production", () => {
    // Guards the seam: without this, the persistence path the app actually
    // takes would be the one path no test ever exercises.
    __setPepperStoreForTests(null)
    expect(isDefaultPepperStoreInstalled()).toBe(true)
  })

  it("mints a key that script cannot read the bytes of", async () => {
    // The entire security property. An extractable key would leave the pepper
    // one `exportKey` call away from an XSS payload or a database dump.
    const key = await getOrCreateDeviceKey("acct-nonextractable")
    expect(key.extractable).toBe(false)
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow()
  })

  it("returns the same key on a second call", async () => {
    const first = await getOrCreateDeviceKey("acct-stable")
    const second = await getOrCreateDeviceKey("acct-stable")
    expect(await deriveDevicePepper("acct-stable")).toEqual(await deriveDevicePepper("acct-stable"))
    expect(first.algorithm).toEqual(second.algorithm)
  })

  it("derives a stable 32-byte pepper", async () => {
    const a = await deriveDevicePepper("acct-bytes")
    const b = await deriveDevicePepper("acct-bytes")
    expect(a).toHaveLength(32)
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it("derives a DIFFERENT pepper per account", async () => {
    // One account's quick unlock must not be openable with another's device
    // material, even on the same machine.
    const a = await deriveDevicePepper("acct-one")
    const b = await deriveDevicePepper("acct-two")
    expect(Array.from(a)).not.toEqual(Array.from(b))
  })

  it("produces a pepper that is not all zeroes", async () => {
    const pepper = await deriveDevicePepper("acct-entropy")
    expect(pepper.some((byte) => byte !== 0)).toBe(true)
  })

  it("mints fresh material after the key is cleared", async () => {
    // Clearing is how deleting an account makes its existing wraps
    // permanently unopenable.
    const before = await deriveDevicePepper("acct-cleared")
    await clearDeviceKey("acct-cleared")
    const after = await deriveDevicePepper("acct-cleared")
    expect(Array.from(after)).not.toEqual(Array.from(before))
  })

  it("survives clearing an account that has no key yet", async () => {
    await expect(clearDeviceKey("acct-never-used")).resolves.toBeUndefined()
  })
})
