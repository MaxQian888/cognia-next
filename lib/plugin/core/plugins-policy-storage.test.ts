import {
  DEFAULT_POLICY,
  POLICY_STORAGE_KEY,
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
})
