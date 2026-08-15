import {
  deriveStatus,
  isLocalEngineConfigured,
  normalizeCategoryFilter,
  pickInitialProviderId,
  providerMatchesCategory,
  sortProviderRows,
} from "./provider-status-utils"

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
    aggregator: {
      id: "aggregator",
      name: "Aggregator Provider",
      category: "aggregator",
      models: [],
    },
    enterprise: {
      id: "enterprise",
      name: "Enterprise Provider",
      category: "enterprise",
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

  it("matches flagship + enterprise providers under 'flagship'", () => {
    expect(providerMatchesCategory("flagship", "flagship")).toBe(true)
    expect(providerMatchesCategory("flagship", "enterprise")).toBe(true)
    expect(providerMatchesCategory("flagship", "specialized")).toBe(false)
  })

  it("matches specialized providers under 'specialized' and aggregators under 'aggregator'", () => {
    expect(providerMatchesCategory("specialized", "specialized")).toBe(true)
    expect(providerMatchesCategory("specialized", "aggregator")).toBe(false)
    expect(providerMatchesCategory("aggregator", "aggregator")).toBe(true)
    expect(providerMatchesCategory("aggregator", "flagship")).toBe(false)
  })

  it("matches local providers under 'local'", () => {
    expect(providerMatchesCategory("local", "local")).toBe(true)
    expect(providerMatchesCategory("local", "flagship")).toBe(false)
  })

  it("returns true for unknown category keys", () => {
    expect(providerMatchesCategory("unknown-category", "flagship")).toBe(true)
  })

  it("returns false for unknown provider ids", () => {
    expect(providerMatchesCategory("flagship", "not-a-provider")).toBe(false)
  })
})

describe("normalizeCategoryFilter", () => {
  it("keeps known filters and maps retired / unknown values to 'all'", () => {
    expect(normalizeCategoryFilter("local")).toBe("local")
    expect(normalizeCategoryFilter("custom")).toBe("custom")
    // Values persisted by the retired AI / Voice / Vision strip.
    expect(normalizeCategoryFilter("ai")).toBe("all")
    expect(normalizeCategoryFilter("voice")).toBe("all")
    expect(normalizeCategoryFilter(undefined)).toBe("all")
  })
})

describe("isLocalEngineConfigured", () => {
  it("is true for an enabled or verified local engine and false otherwise", () => {
    expect(isLocalEngineConfigured("local", { enabled: true })).toBe(true)
    expect(isLocalEngineConfigured("local", { verificationStatus: "verified" })).toBe(true)
    expect(isLocalEngineConfigured("local", { enabled: false })).toBe(false)
    expect(isLocalEngineConfigured("local", undefined)).toBe(false)
  })

  it("never applies to cloud providers", () => {
    expect(isLocalEngineConfigured("flagship", { enabled: true })).toBe(false)
  })
})

describe("sortProviderRows", () => {
  const rows = [
    { id: "b", name: "Bravo", status: "not-configured" as const, lastUsedAt: 10 },
    { id: "a", name: "Alpha", status: "error" as const },
    { id: "c", name: "Charlie", status: "connected" as const, lastUsedAt: 30 },
    { id: "d", name: "Delta", status: "connected" as const, lastUsedAt: 20 },
  ]

  it("sorts by name", () => {
    expect(sortProviderRows(rows, "name").map((r) => r.id)).toEqual(["a", "b", "c", "d"])
  })

  it("sorts healthiest first by status, then by name", () => {
    expect(sortProviderRows(rows, "status").map((r) => r.id)).toEqual(["c", "d", "a", "b"])
  })

  it("sorts most recently used first, unused last, ties by name", () => {
    expect(sortProviderRows(rows, "lastUsed").map((r) => r.id)).toEqual(["c", "d", "b", "a"])
  })

  it("does not mutate the input", () => {
    const copy = [...rows]
    sortProviderRows(rows, "status")
    expect(rows).toEqual(copy)
  })
})

describe("pickInitialProviderId", () => {
  const rows = [
    { id: "zeta", status: "not-configured" as const },
    { id: "openai", status: "connected" as const },
    { id: "anthropic", status: "connected" as const },
  ]

  it("prefers the app default provider when it is listed", () => {
    expect(pickInitialProviderId(rows, "anthropic")).toBe("anthropic")
  })

  it("falls back to the first connected row, then the first row", () => {
    expect(pickInitialProviderId(rows, "missing")).toBe("openai")
    expect(pickInitialProviderId([{ id: "zeta", status: "not-configured" }], undefined)).toBe(
      "zeta"
    )
  })

  it("returns null for an empty list", () => {
    expect(pickInitialProviderId([], "openai")).toBeNull()
  })
})
