/** @jest-environment jsdom */
/**
 * Generic keyring-store backend selection + round-trip. Mirrors the
 * battle-tested behaviour of `turn-credentials.ts` but parameterized by
 * namespace and storing opaque strings.
 */

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => false),
  isCapacitor: jest.fn(() => false),
  transport: { call: jest.fn() },
}))

import { createKeyringStore } from "./keyring-store"
import { isCapacitor, isTauri, transport } from "@/lib/tauri"

const mockIsTauri = isTauri as jest.Mock
const mockIsCapacitor = isCapacitor as jest.Mock
const mockCall = transport.call as jest.Mock

beforeEach(() => {
  mockIsTauri.mockReturnValue(false)
  mockIsCapacitor.mockReturnValue(false)
  mockCall.mockReset()
})

describe("createKeyringStore — in-memory backend (web/dev fallback)", () => {
  it("round-trips save/load under a keyId", async () => {
    const store = createKeyringStore("ns-a")
    await store.save("k1", "value-1")
    expect(await store.load("k1")).toBe("value-1")
  })

  it("returns null for an absent keyId", async () => {
    const store = createKeyringStore("ns-a")
    expect(await store.load("missing")).toBeNull()
  })

  it("delete is idempotent", async () => {
    const store = createKeyringStore("ns-a")
    await store.save("k1", "v")
    await store.delete("k1")
    expect(await store.load("k1")).toBeNull()
    await store.delete("k1") // no throw
  })

  it("overwrite replaces the previous value", async () => {
    const store = createKeyringStore("ns-a")
    await store.save("k1", "old")
    await store.save("k1", "new")
    expect(await store.load("k1")).toBe("new")
  })

  it("isolates values across stores with different namespaces", async () => {
    const a = createKeyringStore("ns-a")
    const b = createKeyringStore("ns-b")
    await a.save("k1", "in-a")
    // Distinct in-memory instances → b does not see a's value.
    expect(await b.load("k1")).toBeNull()
  })
})

describe("createKeyringStore — Tauri OS keyring backend", () => {
  beforeEach(() => {
    mockIsTauri.mockReturnValue(true)
  })

  it("writes through keyring_secret_set with the namespace + key", async () => {
    mockCall.mockResolvedValue(undefined)
    const store = createKeyringStore("provider-ns")
    await store.save("k1", "tok")
    expect(mockCall).toHaveBeenCalledWith("keyring_secret_set", {
      input: { namespace: "provider-ns", key: "k1", value: "tok" },
    })
  })

  it("reads through keyring_secret_get and passes the value through", async () => {
    mockCall.mockResolvedValue("tok")
    const store = createKeyringStore("provider-ns")
    expect(await store.load("k1")).toBe("tok")
    expect(mockCall).toHaveBeenCalledWith("keyring_secret_get", {
      input: { namespace: "provider-ns", key: "k1" },
    })
  })

  it("maps an empty keyring read to null", async () => {
    mockCall.mockResolvedValue(null)
    const store = createKeyringStore("provider-ns")
    expect(await store.load("k1")).toBeNull()
  })

  it("clears through keyring_secret_clear", async () => {
    mockCall.mockResolvedValue(undefined)
    const store = createKeyringStore("provider-ns")
    await store.delete("k1")
    expect(mockCall).toHaveBeenCalledWith("keyring_secret_clear", {
      input: { namespace: "provider-ns", key: "k1" },
    })
  })
})

describe("createKeyringStore — Capacitor SecureStorage backend", () => {
  beforeEach(() => {
    mockIsCapacitor.mockReturnValue(true)
  })

  it("persists through window.Capacitor.Plugins.SecureStoragePlugin under a namespaced key", async () => {
    const realCap = (window as { Capacitor?: unknown }).Capacitor
    const secure = new Map<string, string>()
    try {
      ;(
        window as unknown as {
          Capacitor: { isNativePlatform: () => boolean; Plugins: Record<string, unknown> }
        }
      ).Capacitor = {
        isNativePlatform: () => true,
        Plugins: {
          SecureStoragePlugin: {
            async set(opts: { key: string; value: string }) {
              secure.set(opts.key, opts.value)
              return { value: true }
            },
            async get(opts: { key: string }) {
              if (!secure.has(opts.key)) throw new Error(`absent: ${opts.key}`)
              return { value: secure.get(opts.key)! }
            },
            async remove(opts: { key: string }) {
              secure.delete(opts.key)
              return { value: true }
            },
          },
        },
      }
      const store = createKeyringStore("webrtc-turn-provider")
      await store.save("k-dev", "secret-token")
      expect(secure.get("webrtc-turn-provider.k-dev")).toBe("secret-token")
      expect(await store.load("k-dev")).toBe("secret-token")
      await store.delete("k-dev")
      expect(await store.load("k-dev")).toBeNull()
    } finally {
      if (realCap === undefined) delete (window as { Capacitor?: unknown }).Capacitor
      else (window as { Capacitor?: unknown }).Capacitor = realCap
    }
  })
})
