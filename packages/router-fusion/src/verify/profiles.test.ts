import {
  PROFILES,
  acceptanceClaimFor,
  actionSatisfiesProfile,
  isVerifierProfile,
  minimumProfileForTask,
  resolveAcceptanceProfile,
} from "./profiles"

describe("acceptance profiles", () => {
  it("maps profiles to the spec's verification levels", () => {
    expect(PROFILES.text_basic.level).toBe("schema_only")
    expect(PROFILES.text_review.level).toBe("model_review")
    expect(PROFILES.evidence_review.level).toBe("mixed")
    expect(PROFILES.code_fixture.level).toBe("tool_verified")
    expect(isVerifierProfile("code_fixture")).toBe(true)
    expect(isVerifierProfile("vibes")).toBe(false)
  })

  it("requires tool verification only for change-delivering code tasks", () => {
    expect(minimumProfileForTask("code.implement", true)).toBe("code_fixture")
    expect(minimumProfileForTask("code.implement", false)).toBe("text_basic")
    expect(minimumProfileForTask("text.transform", true)).toBe("text_basic")
  })

  it("[ACC:PROF-01] tightens but never loosens the acceptance profile", () => {
    expect(
      resolveAcceptanceProfile({
        actionProfile: "code_fixture",
        requestedProfile: "text_basic",
        task: "code.debug",
        deliversChange: true,
      })
    ).toEqual({ profile: "code_fixture", raisedToMinimum: true })
    expect(
      resolveAcceptanceProfile({
        actionProfile: "text_basic",
        requestedProfile: "text_review",
        task: "qa.knowledge",
        deliversChange: false,
      })
    ).toEqual({ profile: "text_review", raisedToMinimum: false })
    expect(
      resolveAcceptanceProfile({
        actionProfile: "text_basic",
        task: "code.implement",
        deliversChange: true,
      })
    ).toEqual({ profile: "code_fixture", raisedToMinimum: true })
    expect(
      resolveAcceptanceProfile({
        actionProfile: "text_basic",
        requestedProfile: "not-a-profile",
        task: "qa.knowledge",
        deliversChange: false,
      })
    ).toEqual({ profile: "text_basic", raisedToMinimum: false })
  })

  it("never lets a model review stand in for a runtime tool check", () => {
    expect(actionSatisfiesProfile("text_review", "code_fixture")).toBe(false)
    expect(actionSatisfiesProfile("evidence_review", "schema_fixture")).toBe(false)
    expect(actionSatisfiesProfile("code_fixture", "schema_fixture")).toBe(true)
    expect(actionSatisfiesProfile("text_review", "text_basic")).toBe(true)
  })

  it("[ACC:CAS-03] never accepts an inconclusive or failed verification", () => {
    for (const status of ["inconclusive", "failed", "not_applicable"] as const) {
      expect(
        acceptanceClaimFor({
          verificationStatus: status,
          profile: "schema_fixture",
          task: "data.extract",
          deliversChange: false,
          degraded: false,
        })
      ).toBe("unknown")
      expect(
        acceptanceClaimFor({
          verificationStatus: status,
          profile: "schema_fixture",
          task: "data.extract",
          deliversChange: false,
          degraded: true,
        })
      ).toBe("degraded")
    }
  })

  it("labels a plain chat answer about code as unknown, not accepted", () => {
    expect(
      acceptanceClaimFor({
        verificationStatus: "passed",
        profile: "text_basic",
        task: "code.debug",
        deliversChange: false,
        degraded: false,
      })
    ).toBe("unknown")
    expect(
      acceptanceClaimFor({
        verificationStatus: "passed",
        profile: "text_basic",
        task: "text.transform",
        deliversChange: false,
        degraded: false,
      })
    ).toBe("accepted")
    expect(
      acceptanceClaimFor({
        verificationStatus: "passed",
        profile: "text_basic",
        task: "code.implement",
        deliversChange: true,
        degraded: false,
      })
    ).toBe("unknown")
    expect(
      acceptanceClaimFor({
        verificationStatus: "passed",
        profile: "code_fixture",
        task: "code.implement",
        deliversChange: true,
        degraded: false,
      })
    ).toBe("accepted")
    expect(
      acceptanceClaimFor({
        verificationStatus: "passed",
        profile: "evidence_review",
        task: "research.synthesis",
        deliversChange: false,
        degraded: true,
      })
    ).toBe("degraded")
  })
})
