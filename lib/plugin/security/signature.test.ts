/**
 * Tests for Plugin Signature Verification
 */

import {
  PluginSignatureVerifier,
  getPluginSignatureVerifier,
  resetPluginSignatureVerifier,
} from "./signature"

// Mock Tauri invoke
jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

describe("PluginSignatureVerifier", () => {
  let verifier: PluginSignatureVerifier

  beforeEach(() => {
    resetPluginSignatureVerifier()
    verifier = new PluginSignatureVerifier()
    jest.clearAllMocks()
  })

  afterEach(() => {
    verifier.clearCache()
  })

  describe("Trusted Publishers", () => {
    it("should add a trusted publisher", async () => {
      await verifier.addTrustedPublisher({
        id: "publisher-1",
        name: "Test Publisher",
        publicKey: "test-public-key",
        trustLevel: "verified",
      })

      expect(verifier.isPublisherTrusted("test-public-key")).toBe(true)
    })

    it("should remove a trusted publisher", async () => {
      await verifier.addTrustedPublisher({
        id: "publisher-1",
        name: "Test Publisher",
        publicKey: "test-public-key",
        trustLevel: "verified",
      })

      await verifier.removeTrustedPublisher("publisher-1")

      expect(verifier.isPublisherTrusted("test-public-key")).toBe(false)
    })

    it("should get trusted publisher", async () => {
      await verifier.addTrustedPublisher({
        id: "publisher-1",
        name: "Test Publisher",
        publicKey: "test-public-key",
        trustLevel: "verified",
      })

      const publisher = verifier.getPublisher("publisher-1")

      expect(publisher?.name).toBe("Test Publisher")
    })

    it("should list all trusted publishers", async () => {
      await verifier.addTrustedPublisher({
        id: "publisher-1",
        name: "Publisher 1",
        publicKey: "key-1",
        trustLevel: "verified",
      })
      await verifier.addTrustedPublisher({
        id: "publisher-2",
        name: "Publisher 2",
        publicKey: "key-2",
        trustLevel: "community",
      })

      const publishers = verifier.getTrustedPublishers()

      expect(publishers.length).toBe(2)
    })
  })

  describe("Configuration", () => {
    it("should get default config", () => {
      const config = verifier.getConfig()

      expect(config.requireSignatures).toBe(false)
      expect(config.allowUntrusted).toBe(true)
      expect(config.verifyOnLoad).toBe(true)
      expect(config.cacheVerifications).toBe(true)
    })

    it("should set config", () => {
      verifier.setConfig({ requireSignatures: true })

      const config = verifier.getConfig()
      expect(config.requireSignatures).toBe(true)
    })

    it("should clear cache when cacheVerifications is disabled", () => {
      verifier.setConfig({ cacheVerifications: false })

      const config = verifier.getConfig()
      expect(config.cacheVerifications).toBe(false)
    })
  })

  describe("Cache Management", () => {
    it("should clear all cache", () => {
      verifier.setConfig({ cacheVerifications: true })
      verifier.clearCache()
      // No error should be thrown
      expect(verifier.getConfig().cacheVerifications).toBe(true)
    })

    it("should clear specific plugin cache", () => {
      verifier.clearCache("some-plugin-path")
      // No error should be thrown
    })

    it("should get cached verification", () => {
      const cached = verifier.getCachedVerification("some-plugin-path")
      expect(cached).toBeUndefined()
    })
  })

  describe("Signing Methods", () => {
    it("should have signPlugin method", () => {
      expect(typeof verifier.signPlugin).toBe("function")
    })

    it("should have generateKeyPair method", () => {
      expect(typeof verifier.generateKeyPair).toBe("function")
    })
  })

  describe("Verification Method", () => {
    it("should have verify method that accepts plugin path", () => {
      expect(typeof verifier.verify).toBe("function")
    })
  })
})

describe("Singleton", () => {
  it("should return the same instance", () => {
    resetPluginSignatureVerifier()
    const instance1 = getPluginSignatureVerifier()
    const instance2 = getPluginSignatureVerifier()
    expect(instance1).toBe(instance2)
  })

  it("should allow custom config on first call", () => {
    resetPluginSignatureVerifier()
    const instance = getPluginSignatureVerifier({ requireSignatures: true })
    const config = instance.getConfig()
    expect(config.requireSignatures).toBe(true)
  })
})
