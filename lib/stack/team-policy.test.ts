import {
  carryDeliveryConsent,
  consentedRepositoryPaths,
  STACKED_DELIVERY_DEFAULTS,
  stackedDeliveryOn,
  teamBindingPaths,
  withDeliveryConsent,
  withoutDeliveryConsent,
} from "./team-policy"
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

describe("delivery consent (ADR-0239 phase 2)", () => {
  const on = { ...STACKED_DELIVERY_DEFAULTS }
  const config = {
    githubDeliveryPolicy: on,
    repositories: [{ path: "/work/web" }, { path: "/work/api" }],
  }

  it("records the bound paths when a person turns delivery on", () => {
    const consented = withDeliveryConsent(config, 7)
    expect(consented.githubDeliveryPolicy.consent).toEqual({
      by: "local-user",
      at: 7,
      repositoryPaths: ["/work/web", "/work/api"],
    })
    expect(consentedRepositoryPaths(consented)).toEqual(new Set(["/work/web", "/work/api"]))
    expect(withDeliveryConsent({ githubDeliveryPolicy: policy({ enabled: false }) }, 7)).toEqual({
      githubDeliveryPolicy: policy({ enabled: false }),
    })
  })

  it("falls back to the working directory", () => {
    expect(teamBindingPaths({ workingDir: "/work" })).toEqual(["/work"])
    expect(teamBindingPaths({ repositories: [], workingDir: "/work" })).toEqual(["/work"])
    expect(teamBindingPaths({})).toEqual([])
  })

  it("never takes consent from an edit, and keeps a person's while delivery stays on", () => {
    const consented = withDeliveryConsent(config, 7)
    const forged = {
      ...config,
      githubDeliveryPolicy: {
        ...on,
        consent: { by: "local-user" as const, at: 9, repositoryPaths: ["/elsewhere"] },
      },
    }
    expect(carryDeliveryConsent(config, forged).githubDeliveryPolicy.consent).toBeUndefined()
    expect(carryDeliveryConsent(consented, forged).githubDeliveryPolicy.consent).toEqual(
      consented.githubDeliveryPolicy.consent
    )
    const off = { ...config, githubDeliveryPolicy: policy({ enabled: false }) }
    expect(carryDeliveryConsent(consented, off).githubDeliveryPolicy.consent).toBeUndefined()
    expect(withoutDeliveryConsent(consented).githubDeliveryPolicy.consent).toBeUndefined()
    expect(withoutDeliveryConsent({})).toEqual({})
  })

  it("is nothing when delivery is off or the record is not a person's", () => {
    const consented = withDeliveryConsent(config, 7)
    expect(
      consentedRepositoryPaths({
        ...consented,
        githubDeliveryPolicy: { ...consented.githubDeliveryPolicy, enabled: false },
      })
    ).toEqual(new Set())
    expect(
      consentedRepositoryPaths({
        githubDeliveryPolicy: {
          ...on,
          consent: { by: "plugin", at: 1, repositoryPaths: ["/work"] } as never,
        },
      })
    ).toEqual(new Set())
  })
})
