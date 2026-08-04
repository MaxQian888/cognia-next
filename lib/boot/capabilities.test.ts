import {
  BOOT_CAPABILITIES,
  __resetBootCapabilitiesForTesting,
  ensureBootCapability,
  getBootDiagnosticsSnapshot,
  getBootProfile,
  isBootCapabilityRequested,
  markBootCapabilityFailed,
  markBootCapabilityReady,
  resolveBootProfile,
} from "./capabilities"

describe("resolveBootProfile", () => {
  it("allows main only in development", () => {
    expect(resolveBootProfile("development", "main")).toBe("main")
    expect(resolveBootProfile("production", "main")).toBe("eager")
    expect(resolveBootProfile("test", "main")).toBe("eager")
  })

  it("defaults unknown or missing values to eager", () => {
    expect(resolveBootProfile("development", undefined)).toBe("eager")
    expect(resolveBootProfile("development", "unexpected")).toBe("eager")
  })
})

describe("boot capability coordination", () => {
  beforeEach(() => __resetBootCapabilitiesForTesting("main"))

  it("requests only core chat initially in the main profile", () => {
    expect(getBootProfile()).toBe("main")
    expect(isBootCapabilityRequested("core-chat")).toBe(true)
    expect(isBootCapabilityRequested("plugin-runtime")).toBe(false)
    expect(getBootDiagnosticsSnapshot()).toEqual({
      profile: "main",
      requested: ["core-chat"],
      ready: [],
      pending: [],
    })
  })

  it("requests every capability initially in the eager profile", () => {
    __resetBootCapabilitiesForTesting("eager")

    expect(BOOT_CAPABILITIES.every(isBootCapabilityRequested)).toBe(true)
  })

  it("deduplicates concurrent requests and resolves only when the capability is ready", async () => {
    const first = ensureBootCapability("workflow-automation")
    const second = ensureBootCapability("workflow-automation")
    let settled = false
    void first.then(() => {
      settled = true
    })

    expect(first).toBe(second)
    expect(isBootCapabilityRequested("workflow-automation")).toBe(true)
    expect(isBootCapabilityRequested("plugin-runtime")).toBe(true)
    await Promise.resolve()
    expect(settled).toBe(false)

    markBootCapabilityReady("workflow-automation")
    await Promise.resolve()
    expect(settled).toBe(false)
    markBootCapabilityReady("plugin-runtime")
    await expect(first).resolves.toBeUndefined()
  })

  it("rejects a failed load and allows the next request to retry", async () => {
    const first = ensureBootCapability("integrations")
    markBootCapabilityReady("plugin-runtime")
    markBootCapabilityFailed("integrations", new Error("chunk failed"))
    await expect(first).rejects.toThrow("chunk failed")
    expect(isBootCapabilityRequested("integrations")).toBe(false)

    const retry = ensureBootCapability("integrations")
    expect(retry).not.toBe(first)
    expect(isBootCapabilityRequested("integrations")).toBe(true)
    markBootCapabilityReady("integrations")
    await expect(retry).resolves.toBeUndefined()
  })
})
