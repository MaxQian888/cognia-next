/** @jest-environment jsdom */
import {
  DEFAULT_POLICY,
  POLICY_STORAGE_KEY,
  isInherentlyTrustedFrontendSource,
  readPolicy,
  writePolicy,
  type PluginsPolicy,
} from "./plugins-policy-storage"

describe("plugins-policy-storage", () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it("returns defaults when nothing is persisted", () => {
    expect(readPolicy()).toEqual(DEFAULT_POLICY)
  })

  it("round-trips a written policy", () => {
    const policy: PluginsPolicy = {
      governance: "block",
      signatureRequired: false,
      trustedPublishersOnly: true,
      autoUpdate: true,
      trustedFrontendPlugins: ["alpha", "beta"],
    }
    writePolicy(policy)
    expect(readPolicy()).toEqual(policy)
  })

  it("defaults signatureRequired to true when the key is missing", () => {
    window.localStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify({ governance: "warn" }))
    expect(readPolicy().signatureRequired).toBe(true)
  })

  it("respects an explicit signatureRequired:false", () => {
    window.localStorage.setItem(
      POLICY_STORAGE_KEY,
      JSON.stringify({ governance: "warn", signatureRequired: false })
    )
    expect(readPolicy().signatureRequired).toBe(false)
  })

  it("coerces an unknown governance value to warn", () => {
    window.localStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify({ governance: "explode" }))
    expect(readPolicy().governance).toBe("warn")
  })

  it("falls back to defaults on malformed JSON", () => {
    window.localStorage.setItem(POLICY_STORAGE_KEY, "{not json")
    expect(readPolicy()).toEqual(DEFAULT_POLICY)
  })

  it("defaults trustedFrontendPlugins to an empty list for legacy policies", () => {
    window.localStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify({ governance: "warn" }))
    expect(readPolicy().trustedFrontendPlugins).toEqual([])
  })

  it("coerces a non-array trustedFrontendPlugins to an empty list", () => {
    window.localStorage.setItem(
      POLICY_STORAGE_KEY,
      JSON.stringify({ trustedFrontendPlugins: "alpha" })
    )
    expect(readPolicy().trustedFrontendPlugins).toEqual([])
  })

  it("swallows storage quota errors on write", () => {
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })
    try {
      expect(() => writePolicy(DEFAULT_POLICY)).not.toThrow()
    } finally {
      setItem.mockRestore()
    }
  })

  it("drops non-string entries from trustedFrontendPlugins", () => {
    window.localStorage.setItem(
      POLICY_STORAGE_KEY,
      JSON.stringify({ trustedFrontendPlugins: ["alpha", 42, null, "beta"] })
    )
    expect(readPolicy().trustedFrontendPlugins).toEqual(["alpha", "beta"])
  })
})

describe("isInherentlyTrustedFrontendSource", () => {
  it.each(["builtin", "dev"] as const)("returns true for %s", (source) => {
    expect(isInherentlyTrustedFrontendSource(source)).toBe(true)
  })

  it.each(["local", "marketplace", "git"] as const)("returns false for %s", (source) => {
    expect(isInherentlyTrustedFrontendSource(source)).toBe(false)
  })
})
