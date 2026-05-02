/**
 * Plugin Storage API Tests
 */

// Mock crypto-helpers to avoid Web Crypto API dependency in jsdom
jest.mock("./crypto-helpers", () => {
  // Simple XOR-based mock encryption for testing (not real crypto)
  const keys = new Map<string, string>()
  return {
    deriveKey: jest.fn(async (pluginId: string) => {
      const key = `mock-key-${pluginId}`
      keys.set(key, pluginId)
      return key
    }),
    encrypt: jest.fn(async (data: string, _key: string) => {
      return Buffer.from(data).toString("base64")
    }),
    decrypt: jest.fn(async (encrypted: string, _key: string) => {
      return Buffer.from(encrypted, "base64").toString("utf-8")
    }),
  }
})

import { createStorageAPI, clearPluginStorage, getAllPluginStorageUsage } from "./storage-api"

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value
    },
    removeItem: (key: string) => {
      delete store[key]
    },
    clear: () => {
      store = {}
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
    get length() {
      return Object.keys(store).length
    },
  }
})()

Object.defineProperty(global, "localStorage", { value: localStorageMock })

describe("PluginStorageAPI", () => {
  beforeEach(() => {
    localStorageMock.clear()
  })

  describe("basic operations", () => {
    it("should set and get a value", async () => {
      const api = createStorageAPI("test-plugin")
      await api.set("key1", "value1")
      expect(await api.get("key1")).toBe("value1")
    })

    it("should return undefined for missing keys", async () => {
      const api = createStorageAPI("test-plugin")
      expect(await api.get("nonexistent")).toBeUndefined()
    })

    it("should support getOrDefault", async () => {
      const api = createStorageAPI("test-plugin")
      expect(await api.getOrDefault("missing", 42)).toBe(42)
      await api.set("exists", 99)
      expect(await api.getOrDefault("exists", 42)).toBe(99)
    })

    it("should handle complex objects", async () => {
      const api = createStorageAPI("test-plugin")
      const obj = { nested: { array: [1, 2, 3] }, flag: true }
      await api.set("complex", obj)
      expect(await api.get("complex")).toEqual(obj)
    })

    it("should remove a key", async () => {
      const api = createStorageAPI("test-plugin")
      await api.set("key1", "value1")
      expect(await api.has("key1")).toBe(true)
      await api.remove("key1")
      expect(await api.has("key1")).toBe(false)
      expect(await api.get("key1")).toBeUndefined()
    })

    it("should check key existence", async () => {
      const api = createStorageAPI("test-plugin")
      expect(await api.has("key1")).toBe(false)
      await api.set("key1", "value1")
      expect(await api.has("key1")).toBe(true)
    })

    it("should list all keys", async () => {
      const api = createStorageAPI("test-plugin")
      await api.set("a", 1)
      await api.set("b", 2)
      await api.set("c", 3)
      const keys = await api.keys()
      expect(keys).toHaveLength(3)
      expect(keys.sort()).toEqual(["a", "b", "c"])
    })

    it("should clear all storage for the plugin", async () => {
      const api = createStorageAPI("test-plugin")
      await api.set("a", 1)
      await api.set("b", 2)
      await api.clear()
      expect(await api.keys()).toHaveLength(0)
      expect(await api.get("a")).toBeUndefined()
    })
  })

  describe("namespace isolation", () => {
    it("should isolate storage between plugins", async () => {
      const api1 = createStorageAPI("plugin-a")
      const api2 = createStorageAPI("plugin-b")

      await api1.set("shared-key", "from-a")
      await api2.set("shared-key", "from-b")

      expect(await api1.get("shared-key")).toBe("from-a")
      expect(await api2.get("shared-key")).toBe("from-b")
    })

    it("should not clear other plugin storage", async () => {
      const api1 = createStorageAPI("plugin-a")
      const api2 = createStorageAPI("plugin-b")

      await api1.set("key", "a")
      await api2.set("key", "b")

      await api1.clear()
      expect(await api1.get("key")).toBeUndefined()
      expect(await api2.get("key")).toBe("b")
    })

    it("should list only own keys", async () => {
      const api1 = createStorageAPI("plugin-a")
      const api2 = createStorageAPI("plugin-b")

      await api1.set("k1", 1)
      await api1.set("k2", 2)
      await api2.set("k3", 3)

      expect(await api1.keys()).toHaveLength(2)
      expect(await api2.keys()).toHaveLength(1)
    })
  })

  describe("storage limit", () => {
    it("should throw when exceeding 5MB limit", async () => {
      const api = createStorageAPI("big-plugin")
      // Create a string that's close to 5MB (each char = 2 bytes in UTF-16)
      // 5MB = 5 * 1024 * 1024 = 5242880 bytes = ~2621440 chars
      const bigValue = "x".repeat(2_600_000)
      await api.set("big", bigValue)

      // A second large value should exceed the limit
      await expect(api.set("big2", bigValue)).rejects.toThrow(/storage limit/i)
    })
  })

  describe("getUsage", () => {
    it("should report approximate usage in bytes", async () => {
      const api = createStorageAPI("usage-plugin")
      expect(await api.getUsage()).toBe(0)

      await api.set("test", "hello")
      const usage = await api.getUsage()
      expect(usage).toBeGreaterThan(0)
    })
  })

  describe("clearPluginStorage", () => {
    it("should remove all storage for a specific plugin", async () => {
      const api = createStorageAPI("doomed")
      await api.set("a", 1)
      await api.set("b", 2)

      clearPluginStorage("doomed")
      expect(await api.keys()).toHaveLength(0)
    })

    it("should not affect other plugins", async () => {
      const api1 = createStorageAPI("safe")
      const api2 = createStorageAPI("doomed")
      await api1.set("key", "safe-value")
      await api2.set("key", "doomed-value")

      clearPluginStorage("doomed")
      expect(await api1.get("key")).toBe("safe-value")
    })
  })

  describe("getAllPluginStorageUsage", () => {
    it("should return usage per plugin", async () => {
      const api1 = createStorageAPI("plugin-x")
      const api2 = createStorageAPI("plugin-y")
      await api1.set("data", "some-data")
      await api2.set("data", "other-data")

      const usage = getAllPluginStorageUsage()
      expect(usage["plugin-x"]).toBeGreaterThan(0)
      expect(usage["plugin-y"]).toBeGreaterThan(0)
    })

    it("should return empty object when no plugins have storage", () => {
      const usage = getAllPluginStorageUsage()
      expect(Object.keys(usage)).toHaveLength(0)
    })
  })

  describe("secure storage (encryption)", () => {
    it("should setSecure and getSecure a value", async () => {
      const api = createStorageAPI("secure-plugin")
      await api.setSecure("secret", { token: "abc123" })

      const result = await api.getSecure<{ token: string }>("secret")
      expect(result).toEqual({ token: "abc123" })
    })

    it("should return undefined for missing secure keys", async () => {
      const api = createStorageAPI("secure-plugin")
      const result = await api.getSecure("nonexistent")
      expect(result).toBeUndefined()
    })

    it("should encrypt the stored value", async () => {
      const api = createStorageAPI("secure-plugin")
      await api.setSecure("secret", "my-password")

      // The raw stored value should be encrypted (prefixed)
      const raw = await api.get<string>("secret")
      expect(typeof raw).toBe("string")
      expect(raw).toMatch(/^__encrypted:/)
      expect(raw).not.toContain("my-password")
    })

    it("should isolate encrypted data between plugins", async () => {
      const api1 = createStorageAPI("plugin-secure-a")
      const api2 = createStorageAPI("plugin-secure-b")

      await api1.setSecure("key", "secret-a")
      await api2.setSecure("key", "secret-b")

      expect(await api1.getSecure("key")).toBe("secret-a")
      expect(await api2.getSecure("key")).toBe("secret-b")
    })

    it("should handle complex objects", async () => {
      const api = createStorageAPI("secure-plugin")
      const data = { items: [1, 2], nested: { deep: true } }
      await api.setSecure("complex", data)
      expect(await api.getSecure("complex")).toEqual(data)
    })

    it("should return undefined when getSecure is called on a non-encrypted key", async () => {
      const api = createStorageAPI("secure-plugin")
      await api.set("plain", "not-encrypted")
      const result = await api.getSecure("plain")
      expect(result).toBeUndefined()
    })
  })

  describe("isEncrypted", () => {
    it("should return true for encrypted values", async () => {
      const api = createStorageAPI("enc-check")
      await api.setSecure("encrypted-key", "secret")
      expect(await api.isEncrypted("encrypted-key")).toBe(true)
    })

    it("should return false for plain values", async () => {
      const api = createStorageAPI("enc-check")
      await api.set("plain-key", "not-secret")
      expect(await api.isEncrypted("plain-key")).toBe(false)
    })

    it("should return false for missing keys", async () => {
      const api = createStorageAPI("enc-check")
      expect(await api.isEncrypted("nonexistent")).toBe(false)
    })
  })
})
