import { STACKED_DELIVERY_DEFAULTS, stackedDeliveryOn } from "./team-policy"
import type { AgentTeamGithubDeliveryPolicy } from "@/types/agent/agent-team-runtime"

function policy(over: Partial<AgentTeamGithubDeliveryPolicy> = {}): AgentTeamGithubDeliveryPolicy {
  return { ...STACKED_DELIVERY_DEFAULTS, ...over }
}

describe("stackedDeliveryOn", () => {
  it("is false for a team that never configured delivery", () => {
    expect(stackedDeliveryOn(undefined)).toBe(false)
  })

  it("needs both flags", () => {
    // The half-on state used to reach the publisher, which then declined —
    // one dynamic import and one database read per completed run, for nothing.
    expect(stackedDeliveryOn(policy({ enabled: false }))).toBe(false)
    expect(stackedDeliveryOn(policy({ stackedPullRequests: false }))).toBe(false)
    expect(stackedDeliveryOn(policy({ enabled: false, stackedPullRequests: false }))).toBe(false)
    expect(stackedDeliveryOn(policy())).toBe(true)
  })

  it("treats a truthy non-true value as off", () => {
    // The policy arrives from persisted config, which older versions wrote by
    // hand; `1` and `"yes"` are corruption, not consent.
    const loose = { ...STACKED_DELIVERY_DEFAULTS, enabled: 1 } as unknown
    expect(stackedDeliveryOn(loose as AgentTeamGithubDeliveryPolicy)).toBe(false)
  })

  it("defaults to a policy the publisher can act on unchanged", () => {
    expect(STACKED_DELIVERY_DEFAULTS.minLayers).toBeGreaterThanOrEqual(2)
    expect(STACKED_DELIVERY_DEFAULTS.maxLayers).toBeLessThanOrEqual(100)
    expect(STACKED_DELIVERY_DEFAULTS.minLayers).toBeLessThanOrEqual(
      STACKED_DELIVERY_DEFAULTS.maxLayers
    )
    expect(STACKED_DELIVERY_DEFAULTS.mergeMode).toBe("approved-bottom-up")
    expect(stackedDeliveryOn(STACKED_DELIVERY_DEFAULTS)).toBe(true)
  })
})
