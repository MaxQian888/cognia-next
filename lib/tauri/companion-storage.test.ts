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
  pickLegacyCompanionStorage,
} from "./companion-storage"
import { MigratingCompanionStorage } from "@/lib/companion/credential-book"
import {
  buildRoomDescriptor,
  generatePersistableSigningIdentity,
  generateSigningKeyPair,
} from "@/lib/signaling/crypto"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"

const MOCK: CompanionConfig = {
  targetId: "companion-studio",
  baseUrl: "https://192.168.1.42:7890",
  devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-key-a" },
  deviceKeyThumbprint: "thumbprint-a",
  deviceId: "device-abc",
  serverVersion: "0.1.0",
}

afterEach(() => {
  window.localStorage.clear()
  clearActiveRuntimeTargetContext()
  delete (window as { Capacitor?: unknown }).Capacitor
  __setCompanionStorageForTests(null)
})

describe("LocalStorageCompanionStorage", () => {
  const vaultSecrets = new Map<string, string>()
  const vault = {
    accountId: "acct_test",
    async encryptSecret(name: string, value: string) {
      vaultSecrets.set(name, value)
      return { version: 1 as const, iv: `iv-${name}`, ciphertext: `sealed-${name}` }
    },
    async decryptSecret(name: string) {
      const value = vaultSecrets.get(name)
      if (!value) throw new Error("secret missing")
      return value
    },
    async storeSecret(name: string, value: string) {
      vaultSecrets.set(name, value)
    },
    async loadSecret(name: string) {
      return vaultSecrets.get(name) ?? null
    },
    async deleteSecret(name: string) {
      vaultSecrets.delete(name)
    },
  }
  const storage = new LocalStorageCompanionStorage(undefined, () => vault)

  beforeEach(() => {
    vaultSecrets.clear()
  })

  it("returns null when nothing is stored", async () => {
    expect(await storage.load()).toBeNull()
  })

  it("save + load round-trips the config", async () => {
    await storage.save(MOCK)
    expect(await storage.load()).toEqual(MOCK)
    const raw = window.localStorage.getItem("cognia.companion.targets.v2")!
    expect(raw).not.toContain(MOCK.devicePrivateKeyJwk?.d ?? "")
    expect(raw).toContain("companion-studio")
    expect(window.localStorage.getItem("cognia.companion.config.v1")).toBeNull()
    expect(vaultSecrets.get("companion:companion-studio:device-private-jwk")).toContain(
      "device-key-a"
    )
  })

  it("keeps the v2 private key out of localStorage and reloads a non-extractable key", async () => {
    const mobile = await generatePersistableSigningIdentity()
    const desktop = await generateSigningKeyPair()
    const descriptor = await buildRoomDescriptor({
      roomNonce: "AAECAwQFBgcICQoLDA0ODw",
      desktopSigningKey: desktop.encodedPublicKey,
      mobileSigningKey: mobile.encodedPublicKey,
      notAfter: Date.now() + 60_000,
    })
    const keys = new Map<string, CryptoKey>()
    const keyStore = {
      async save(deviceId: string, jwk: JsonWebKey) {
        const key = await crypto.subtle.importKey(
          "jwk",
          jwk,
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["sign"]
        )
        keys.set(deviceId, key)
        return key
      },
      async load(deviceId: string) {
        return keys.get(deviceId) ?? null
      },
      async clear(deviceId: string) {
        keys.delete(deviceId)
      },
    }
    const isolated = new LocalStorageCompanionStorage(keyStore, () => vault)
    await isolated.save({
      ...MOCK,
      rendezvousId: descriptor.roomId,
      signalingRoomDescriptor: descriptor,
      signalingPrivateKeyJwk: mobile.privateKeyJwk,
    })

    const raw = window.localStorage.getItem("cognia.companion.targets.v2")!
    expect(raw).not.toContain(mobile.privateKeyJwk.d!)
    expect(raw).not.toContain("signalingPrivateKeyJwk")
    expect(raw).toContain("signalingRoomDescriptor")
    expect(vaultSecrets.get("companion:companion-studio:signaling-private-jwk")).toContain(
      mobile.privateKeyJwk.d!
    )
    const loaded = await isolated.load()
    expect(loaded?.signalingPrivateKey?.extractable).toBe(false)
    expect(loaded?.signalingPrivateKeyJwk).toBeUndefined()
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

  it("invalidates a legacy plaintext device JWT after the Vault is unlocked", async () => {
    window.localStorage.setItem(
      "cognia.companion.config.v1",
      JSON.stringify({
        baseUrl: MOCK.baseUrl,
        deviceJwt: "legacy.jwt",
        deviceId: MOCK.deviceId,
        serverVersion: MOCK.serverVersion,
      })
    )

    await expect(storage.load()).resolves.toBeNull()

    const migrated = window.localStorage.getItem("cognia.companion.config.v1")!
    expect(migrated).toBeNull()
    expect(window.localStorage.getItem("cognia.companion.targets.v2")).toBeNull()
  })

  it("keeps multiple target credentials isolated and loads only the active target", async () => {
    const second: CompanionConfig = {
      ...MOCK,
      targetId: "companion-cloud",
      baseUrl: "https://cloud.example.com",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-key-b" },
      deviceKeyThumbprint: "thumbprint-b",
      deviceId: "device-cloud",
    }
    await storage.save(MOCK)
    await storage.save(second)

    setActiveRuntimeTargetContext("acct_test", "companion-studio")
    await expect(storage.load()).resolves.toEqual(MOCK)

    setActiveRuntimeTargetContext("acct_test", "companion-cloud")
    await expect(storage.load()).resolves.toEqual(second)

    const raw = window.localStorage.getItem("cognia.companion.targets.v2")!
    expect(raw).not.toContain(MOCK.devicePrivateKeyJwk?.d ?? "")
    expect(raw).not.toContain(second.devicePrivateKeyJwk?.d ?? "")
  })

  it("fails closed while the Browser Vault is locked", async () => {
    const locked = new LocalStorageCompanionStorage(undefined, () => null)
    window.localStorage.setItem("cognia.companion.config.v1", JSON.stringify(MOCK))

    await expect(locked.load()).resolves.toBeNull()
    await expect(locked.save(MOCK)).rejects.toThrow(/Vault.*unlocked/i)
  })

  // The SSR (no-window) branch lives in `companion-storage.ssr.test.ts` —
  // jsdom's `window` is non-configurable from Node 26 on.
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

  it("default loader resolves the plugin from window.Capacitor.Plugins (device path)", async () => {
    // Regression for the on-device save bug: the previous default loader did a
    // bare `import("capacitor-secure-storage-plugin")` that never resolves in
    // the static-export WebView, so save() threw and the pairing key was lost.
    // `registerNativePlugins()` registers the proxy onto window.Capacitor.Plugins
    // at boot — the loader must read that first.
    const store = new Map<string, string>()
    ;(
      window as unknown as {
        Capacitor: { isNativePlatform: () => boolean; Plugins: Record<string, unknown> }
      }
    ).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        SecureStoragePlugin: {
          async set(opts: { key: string; value: string }) {
            store.set(opts.key, opts.value)
            return { value: true }
          },
          async get(opts: { key: string }) {
            if (!store.has(opts.key)) throw new Error(`absent: ${opts.key}`)
            return { value: store.get(opts.key)! }
          },
          async remove(opts: { key: string }) {
            store.delete(opts.key)
            return { value: true }
          },
        },
      },
    }

    // No injected loader — exercises `defaultSecureStoragePluginLoader`.
    const storage = new SecureStorageCompanionStorage()
    await storage.save(MOCK)
    expect(store.get("cognia.companion.config.v1")).toBe(JSON.stringify(MOCK))
    expect(await storage.load()).toEqual(MOCK)
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
  it("returns the credential-book storage, whatever the platform", () => {
    expect(pickCompanionStorage()).toBeInstanceOf(MigratingCompanionStorage)
    ;(window as { Capacitor?: { isNativePlatform: () => boolean } }).Capacitor = {
      isNativePlatform: () => true,
    }
    expect(pickCompanionStorage()).toBeInstanceOf(MigratingCompanionStorage)
  })

  it("still picks the platform's legacy store as the migration source", () => {
    expect(pickLegacyCompanionStorage()).toBeInstanceOf(LocalStorageCompanionStorage)
    ;(window as { Capacitor?: { isNativePlatform: () => boolean } }).Capacitor = {
      isNativePlatform: () => true,
    }
    expect(pickLegacyCompanionStorage()).toBeInstanceOf(SecureStorageCompanionStorage)
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
