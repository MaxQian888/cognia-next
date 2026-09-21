/**
 * delegate-capabilities — what the router is allowed to believe about this
 * device before it offers a delegate action (ADR-0188 D15/D16).
 */

import {
  DELEGATE_UNAVAILABLE,
  delegateCapabilitiesFor,
  hostSandboxTier,
} from "./delegate-capabilities"

const PROJECT = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"

describe("delegateCapabilitiesFor", () => {
  it("answers nothing for a request that names no project, without probing anything", async () => {
    const sandboxTier = jest.fn(async () => "microvm" as const)
    expect(await delegateCapabilitiesFor(null, { sandboxTier })).toEqual(DELEGATE_UNAVAILABLE)
    expect(await delegateCapabilitiesFor(undefined, { sandboxTier })).toEqual(DELEGATE_UNAVAILABLE)
    expect(sandboxTier).not.toHaveBeenCalled()
  })

  it("reports the strongest tier and the approved profiles when both hold", async () => {
    expect(
      await delegateCapabilitiesFor(PROJECT, {
        sandboxTier: async () => "microvm",
        acceptanceProfiles: async () => ({
          available: true,
          approvedProfileIds: ["unit", "e2e"],
          reason: null,
        }),
      })
    ).toEqual({
      sandboxTier: "microvm",
      acceptanceProfileAvailable: true,
      approvedProfileIds: ["unit", "e2e"],
      reason: null,
    })
  })

  it("withholds delegate when this device can confine nothing", async () => {
    const capabilities = await delegateCapabilitiesFor(PROJECT, {
      sandboxTier: async () => null,
      acceptanceProfiles: async () => ({
        available: true,
        approvedProfileIds: ["unit"],
        reason: null,
      }),
    })
    // The profile is still reported — the settings pane shows it — but the
    // router sees no tier, which is what excludes the action.
    expect(capabilities.sandboxTier).toBeNull()
    expect(capabilities.reason).toBe("no_sandbox_tier")
    expect(capabilities.approvedProfileIds).toEqual(["unit"])
  })

  it("withholds delegate when the project's command is declared but not approved", async () => {
    expect(
      await delegateCapabilitiesFor(PROJECT, {
        sandboxTier: async () => "os",
        acceptanceProfiles: async () => ({
          available: false,
          approvedProfileIds: [],
          reason: "approval_pending",
        }),
      })
    ).toMatchObject({
      sandboxTier: "os",
      acceptanceProfileAvailable: false,
      reason: "approval_pending",
    })
  })

  it("treats a profile read that threw as unavailable, never as permission", async () => {
    const capabilities = await delegateCapabilitiesFor(PROJECT, {
      sandboxTier: async () => "os",
      acceptanceProfiles: async () => {
        throw new Error("the project store is not loaded")
      },
    })
    expect(capabilities).toMatchObject({ acceptanceProfileAvailable: false, reason: "fault" })
  })

  it("treats a sandbox probe that threw as no tier, so nothing runs unconfined", async () => {
    // The real probe: with no adapter reachable in this environment it must
    // answer null rather than throw into the router.
    await expect(hostSandboxTier()).resolves.toBeNull()
  })
})
