import { isPluginSuspendEligible, DEFAULT_IDLE_SUSPEND_MS } from "./idle-policy"

describe("idle-policy", () => {
  const now = 1_000_000_000_000

  it("is eligible when last use is older than the default threshold", () => {
    expect(
      isPluginSuspendEligible({ lastUsedAt: now - DEFAULT_IDLE_SUSPEND_MS - 1, nowMs: now })
    ).toBe(true)
  })

  it("is eligible exactly at the threshold boundary", () => {
    expect(isPluginSuspendEligible({ lastUsedAt: now - DEFAULT_IDLE_SUSPEND_MS, nowMs: now })).toBe(
      true
    )
  })

  it("is not eligible when last use is within the threshold", () => {
    expect(isPluginSuspendEligible({ lastUsedAt: now - 1000, nowMs: now })).toBe(false)
  })

  it("is not eligible when the plugin has never been used (no idle baseline)", () => {
    expect(isPluginSuspendEligible({ lastUsedAt: undefined, nowMs: now })).toBe(false)
  })

  it("honours a custom idle threshold", () => {
    expect(
      isPluginSuspendEligible({ lastUsedAt: now - 5000, nowMs: now, idleThresholdMs: 4000 })
    ).toBe(true)
    expect(
      isPluginSuspendEligible({ lastUsedAt: now - 5000, nowMs: now, idleThresholdMs: 6000 })
    ).toBe(false)
  })
})
