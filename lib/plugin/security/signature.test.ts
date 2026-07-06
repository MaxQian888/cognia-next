/**
 * Tests for Plugin Signature Verification
 */

import {
  PluginSignatureVerifier,
  getPluginSignatureVerifier,
  resetPluginSignatureVerifier,
  isOfficialPublisherKeyConfigured,
} from "./signature"

// Mock Tauri invoke
jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

describe("official publisher anchor (Ed25519 build-time key)", () => {
  // The env var is unset in the test environment, so the official key is the
  // empty placeholder and NO official publisher should be seeded — closing the
  // prior spoof hole where an empty-key signature matched the official anchor.
  it("reports the official key as unconfigured by default", () => {
    expect(isOfficialPublisherKeyConfigured()).toBe(false)
  })

  it("does NOT seed an empty-key official publisher (no spoofable anchor)", async () => {
    const verifier = new PluginSignatureVerifier()
    await verifier.initialize()
    // An attacker-supplied empty public key must not be considered trusted.
    expect(verifier.isPublisherTrusted("")).toBe(false)
    expect(verifier.getTrustedPublishers().some((p) => p.id === "cognia-official")).toBe(false)
  })

  it("seeds the official publisher once a real key is injected at build time", () => {
    jest.isolateModules(() => {
      const prev = process.env.NEXT_PUBLIC_COGNIA_PLUGIN_PUBKEY
      process.env.NEXT_PUBLIC_COGNIA_PLUGIN_PUBKEY = "Zm9vYmFyLXJlYWwta2V5"
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require("./signature") as typeof import("./signature")
        expect(mod.isOfficialPublisherKeyConfigured()).toBe(true)
        expect(mod.OFFICIAL_PLUGIN_PUBLIC_KEY).toBe("Zm9vYmFyLXJlYWwta2V5")
      } finally {
        if (prev === undefined) delete process.env.NEXT_PUBLIC_COGNIA_PLUGIN_PUBKEY
        else process.env.NEXT_PUBLIC_COGNIA_PLUGIN_PUBKEY = prev
      }
    })
  })
})

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
    it("should get default config (ADR 0016 P0-3: requireSignatures default-on)", () => {
      const config = verifier.getConfig()

      expect(config.requireSignatures).toBe(true)
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

  describe("Verification Method (policy gate)", () => {
    it("should have verify method that accepts plugin path", () => {
      expect(typeof verifier.verify).toBe("function")
    })

    it("rejects an unsigned plugin when signatures are required", async () => {
      verifier.setConfig({ requireSignatures: true })
      const result = await verifier.verify("/plugins/demo")
      expect(result.valid).toBe(false)
      expect(result.reason).toBe("Signature required but not found")
    })

    it("allows an unsigned plugin with a warning when signatures are not required", async () => {
      verifier.setConfig({ requireSignatures: false })
      const result = await verifier.verify("/plugins/demo")
      expect(result.valid).toBe(true)
      expect(result.warnings).toContain("Plugin is not signed")
    })

    it("does NOT invoke the (removed) file-based crypto command", async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { invoke } = require("@tauri-apps/api/core") as { invoke: jest.Mock }
      verifier.setConfig({ requireSignatures: false })
      await verifier.verify("/plugins/demo")
      expect(invoke).not.toHaveBeenCalledWith("plugin_verify_signature", expect.anything())
    })

    it("caches a rejection so the second call is served from cache", async () => {
      verifier.setConfig({ requireSignatures: true, cacheVerifications: true })
      const first = await verifier.verify("/plugins/demo")
      expect(first.valid).toBe(false)
      expect(verifier.getCachedVerification("/plugins/demo")).toEqual(first)
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
