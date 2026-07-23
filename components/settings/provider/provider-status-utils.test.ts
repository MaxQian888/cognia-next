import { deriveStatus, providerMatchesCategory } from "./provider-status-utils"

jest.mock("@cognia/provider-types/provider", () => ({
  PROVIDERS: {
    flagship: {
      id: "flagship",
      name: "Flagship Provider",
      category: "flagship",
      models: [{ supportsVision: true }],
    },
    specialized: {
      id: "specialized",
      name: "Specialized Provider",
      category: "specialized",
      models: [{ supportsVision: false }],
    },
    vision: {
      id: "vision",
      name: "Vision Provider",
      category: "specialized",
      models: [{ supportsVision: true }],
    },
    local: {
      id: "local",
      name: "Local Provider",
      category: "local",
      models: [],
    },
  },
}))

describe("deriveStatus", () => {
  it("returns not-configured when neither an apiKey nor a baseURL is set", () => {
    expect(deriveStatus(undefined, undefined, undefined)).toBe("not-configured")
  })

  it("returns limited when the test outcome is 'limited', even though testOk is true", () => {
    expect(deriveStatus("sk-x", undefined, true, "limited")).toBe("limited")
  })

  it("prioritizes limited over a failed testOk (outcome is the more specific signal)", () => {
    expect(deriveStatus("sk-x", undefined, false, "limited")).toBe("limited")
  })

  it("returns error when the test failed and outcome is not limited", () => {
    expect(deriveStatus("sk-x", undefined, false)).toBe("error")
  })

  it("returns connected when the test succeeded outright", () => {
    expect(deriveStatus("sk-x", undefined, true)).toBe("connected")
  })

  it("returns a neutral untested state when configured but never tested", () => {
    // NOT "warning": a freshly configured provider has nothing wrong with it,
    // and amber told the user otherwise on every reload.
    expect(deriveStatus("sk-x", undefined, undefined)).toBe("untested")
  })

  it("treats a configured baseURL (no key) the same as a configured key", () => {
    expect(deriveStatus(undefined, "https://x.example.com", undefined)).toBe("untested")
  })

  it("treats a validated keyless provider configuration as configured", () => {
    expect(deriveStatus(undefined, undefined, undefined, undefined, true)).toBe("untested")
  })

  it("falls back to persisted verification status when no in-session test exists", () => {
    expect(deriveStatus("sk-x", undefined, undefined, undefined, false, "verified")).toBe(
      "connected"
    )
    expect(deriveStatus("sk-x", undefined, undefined, undefined, false, "stale")).toBe("limited")
  })

  it("prefers a failed in-session test over a persisted verified status", () => {
    expect(deriveStatus("sk-x", undefined, false, undefined, false, "verified")).toBe("error")
  })
})

describe("providerMatchesCategory", () => {
  it("matches every provider for 'all'", () => {
    expect(providerMatchesCategory("all", "flagship")).toBe(true)
    expect(providerMatchesCategory("all", "local")).toBe(true)
  })

  it("excludes every built-in for 'custom'", () => {
    expect(providerMatchesCategory("custom", "flagship")).toBe(false)
  })

  it("matches flagship providers under 'ai'", () => {
    expect(providerMatchesCategory("ai", "flagship")).toBe(true)
    expect(providerMatchesCategory("ai", "specialized")).toBe(false)
  })

  it("matches local providers under 'local'", () => {
    expect(providerMatchesCategory("local", "local")).toBe(true)
    expect(providerMatchesCategory("local", "flagship")).toBe(false)
  })

  it("matches vision-capable providers under 'vision'", () => {
    expect(providerMatchesCategory("vision", "vision")).toBe(true)
    expect(providerMatchesCategory("vision", "specialized")).toBe(false)
  })

  it("returns true for unknown category keys", () => {
    expect(providerMatchesCategory("unknown-category", "flagship")).toBe(true)
  })

  it("returns false for unknown provider ids", () => {
    expect(providerMatchesCategory("ai", "not-a-provider")).toBe(false)
  })
})
