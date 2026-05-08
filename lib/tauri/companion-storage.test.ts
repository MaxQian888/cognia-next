/**
 * @jest-environment jsdom
 */

import {
  CompanionConfig,
  LocalStorageCompanionStorage,
  SecureStorageCompanionStorage,
  __setCompanionStorageForTests,
  companionStorage,
  pickCompanionStorage,
} from "./companion-storage"

const MOCK: CompanionConfig = {
  baseUrl: "https://192.168.1.42:7890",
  deviceJwt: "jwt.token.value",
  deviceId: "device-abc",
  serverVersion: "0.1.0",
}

afterEach(() => {
  window.localStorage.clear()
  delete (window as { Capacitor?: unknown }).Capacitor
  __setCompanionStorageForTests(null)
})

describe("LocalStorageCompanionStorage", () => {
  const storage = new LocalStorageCompanionStorage()

  it("returns null when nothing is stored", async () => {
    expect(await storage.load()).toBeNull()
  })

  it("save + load round-trips the config", async () => {
    await storage.save(MOCK)
    expect(await storage.load()).toEqual(MOCK)
  })

  it("clear removes the stored value", async () => {
    await storage.save(MOCK)
    await storage.clear()
    expect(await storage.load()).toBeNull()
  })

  it("returns null on malformed JSON", async () => {
    window.localStorage.setItem("cognia.companion.config.v1", "{not json")
    expect(await storage.load()).toBeNull()
  })

  it("treats SSR (no window) as empty", async () => {
    // Simulate the server-rendering branch by stashing then deleting window.
    const realWindow = globalThis.window
    // @ts-expect-error — exercising the SSR guard.
    delete globalThis.window
    try {
      const ssrStorage = new LocalStorageCompanionStorage()
      expect(await ssrStorage.load()).toBeNull()
      await ssrStorage.save(MOCK) // no-op
      await ssrStorage.clear() // no-op
    } finally {
      globalThis.window = realWindow
    }
  })
})

describe("SecureStorageCompanionStorage", () => {
  function makePluginMock(initial: Map<string, string> = new Map()) {
    const store = new Map(initial)
    return {
      store,
      plugin: {
        async set(opts: { key: string; value: string }) {
          store.set(opts.key, opts.value)
          return { value: true }
        },
        async get(opts: { key: string }) {
          if (!store.has(opts.key)) {
            throw new Error(`key not found: ${opts.key}`)
          }
          return { value: store.get(opts.key)! }
        },
        async remove(opts: { key: string }) {
          if (!store.has(opts.key)) {
            throw new Error(`key not found: ${opts.key}`)
          }
          store.delete(opts.key)
          return { value: true }
        },
      },
    }
  }

  it("returns null when the key is absent (plugin throws)", async () => {
    const { plugin } = makePluginMock()
    const storage = new SecureStorageCompanionStorage(async () => plugin)
    expect(await storage.load()).toBeNull()
  })

  it("save + load round-trips through the plugin", async () => {
    const { plugin, store } = makePluginMock()
    const storage = new SecureStorageCompanionStorage(async () => plugin)

    await storage.save(MOCK)
    expect(store.get("cognia.companion.config.v1")).toBe(JSON.stringify(MOCK))
    expect(await storage.load()).toEqual(MOCK)
  })

  it("clear removes the entry", async () => {
    const { plugin, store } = makePluginMock(
      new Map([["cognia.companion.config.v1", JSON.stringify(MOCK)]])
    )
    const storage = new SecureStorageCompanionStorage(async () => plugin)

    await storage.clear()
    expect(store.has("cognia.companion.config.v1")).toBe(false)
    expect(await storage.load()).toBeNull()
  })

  it("clear is idempotent when the key is already missing", async () => {
    const { plugin } = makePluginMock()
    const storage = new SecureStorageCompanionStorage(async () => plugin)
    await expect(storage.clear()).resolves.toBeUndefined()
  })

  it("returns null when the plugin returns an empty value", async () => {
    const plugin = {
      async set() {
        return { value: true }
      },
      async get() {
        return { value: "" }
      },
      async remove() {
        return { value: true }
      },
    }
    const storage = new SecureStorageCompanionStorage(async () => plugin)
    expect(await storage.load()).toBeNull()
  })
})

describe("pickCompanionStorage / companionStorage", () => {
  it("returns LocalStorage when not in Capacitor", () => {
    expect(pickCompanionStorage()).toBeInstanceOf(LocalStorageCompanionStorage)
  })

  it("returns SecureStorage when window.Capacitor.isNativePlatform() === true", () => {
    ;(window as { Capacitor?: { isNativePlatform: () => boolean } }).Capacitor = {
      isNativePlatform: () => true,
    }
    expect(pickCompanionStorage()).toBeInstanceOf(SecureStorageCompanionStorage)
  })

  it("companionStorage() memoizes one instance per process", () => {
    const a = companionStorage()
    const b = companionStorage()
    expect(a).toBe(b)
  })

  it("__setCompanionStorageForTests resets the singleton on null", () => {
    const a = companionStorage()
    __setCompanionStorageForTests(null)
    const b = companionStorage()
    // Different instance after reset, even though both are LocalStorage.
    expect(a).not.toBe(b)
  })
})
