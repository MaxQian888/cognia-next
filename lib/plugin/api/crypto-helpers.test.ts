/**
 * Crypto Helpers Tests
 */

// Polyfill Web Crypto APIs for Jest/jsdom environment
import { webcrypto } from "node:crypto"
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from "node:util"

// jsdom does not provide crypto.subtle — use Node.js webcrypto
Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  writable: true,
  configurable: true,
})
if (typeof globalThis.TextEncoder === "undefined") {
  Object.defineProperty(globalThis, "TextEncoder", { value: NodeTextEncoder })
}
if (typeof globalThis.TextDecoder === "undefined") {
  Object.defineProperty(globalThis, "TextDecoder", { value: NodeTextDecoder })
}

import { deriveKey, encrypt, decrypt } from "./crypto-helpers"

describe("crypto-helpers", () => {
  describe("deriveKey", () => {
    it("should derive a CryptoKey from a plugin ID", async () => {
      const key = await deriveKey("test-plugin")
      expect(key).toBeDefined()
      expect(key.type).toBe("secret")
      expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 })
    })

    it("should derive different keys for different plugin IDs", async () => {
      const key1 = await deriveKey("plugin-a")
      const key2 = await deriveKey("plugin-b")

      // Encrypt the same data with both keys
      const data = "test-data"
      const enc1 = await encrypt(data, key1)
      const enc2 = await encrypt(data, key2)

      // Different keys should produce different ciphertext
      // (also different IVs, but cross-decrypt should fail)
      await expect(decrypt(enc1, key2)).rejects.toThrow()
      await expect(decrypt(enc2, key1)).rejects.toThrow()
    })

    it("should derive the same key for the same plugin ID and salt", async () => {
      const key1 = await deriveKey("plugin-x", "custom-salt")
      const key2 = await deriveKey("plugin-x", "custom-salt")

      const data = "roundtrip-test"
      const encrypted = await encrypt(data, key1)
      const decrypted = await decrypt(encrypted, key2)
      expect(decrypted).toBe(data)
    })

    it("should derive different keys with different salts", async () => {
      const key1 = await deriveKey("plugin-x", "salt-1")
      const key2 = await deriveKey("plugin-x", "salt-2")

      const encrypted = await encrypt("data", key1)
      await expect(decrypt(encrypted, key2)).rejects.toThrow()
    })
  })

  describe("encrypt / decrypt", () => {
    let key: CryptoKey

    beforeAll(async () => {
      key = await deriveKey("roundtrip-plugin")
    })

    it("should encrypt and decrypt a simple string", async () => {
      const data = "hello world"
      const encrypted = await encrypt(data, key)
      expect(encrypted).not.toBe(data)
      const decrypted = await decrypt(encrypted, key)
      expect(decrypted).toBe(data)
    })

    it("should handle JSON-serialized objects", async () => {
      const obj = { nested: { array: [1, 2, 3] }, flag: true }
      const json = JSON.stringify(obj)
      const encrypted = await encrypt(json, key)
      const decrypted = await decrypt(encrypted, key)
      expect(JSON.parse(decrypted)).toEqual(obj)
    })

    it("should handle empty strings", async () => {
      const data = ""
      const encrypted = await encrypt(data, key)
      const decrypted = await decrypt(encrypted, key)
      expect(decrypted).toBe("")
    })

    it("should handle unicode and emoji", async () => {
      const data = "你好世界 🌍"
      const encrypted = await encrypt(data, key)
      const decrypted = await decrypt(encrypted, key)
      expect(decrypted).toBe(data)
    })

    it("should produce different ciphertext for the same plaintext (random IV)", async () => {
      const data = "same-input"
      const enc1 = await encrypt(data, key)
      const enc2 = await encrypt(data, key)
      expect(enc1).not.toBe(enc2)

      // Both should still decrypt correctly
      expect(await decrypt(enc1, key)).toBe(data)
      expect(await decrypt(enc2, key)).toBe(data)
    })

    it("should detect tampered ciphertext", async () => {
      const encrypted = await encrypt("sensitive-data", key)

      // Tamper with the ciphertext (flip a character in the middle)
      const chars = encrypted.split("")
      const mid = Math.floor(chars.length / 2)
      chars[mid] = chars[mid] === "A" ? "B" : "A"
      const tampered = chars.join("")

      await expect(decrypt(tampered, key)).rejects.toThrow()
    })

    it("should fail with invalid base64 input", async () => {
      await expect(decrypt("not-valid-base64!!!", key)).rejects.toThrow()
    })
  })
})
