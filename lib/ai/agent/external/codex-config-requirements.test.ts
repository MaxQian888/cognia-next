import {
  CodexManagedPolicyError,
  assertCodexRequestAllowed,
  checkCodexRequestAgainstRequirements,
  isCodexManagedPolicyError,
  mapCodexConfigRequirements,
} from "./codex-config-requirements"

describe("mapCodexConfigRequirements", () => {
  it("reads the axes Cognia actually sends, through the `requirements` envelope", () => {
    expect(
      mapCodexConfigRequirements({
        requirements: {
          allowedSandboxModes: ["read-only", "workspace-write"],
          allowedApprovalPolicies: ["on-request"],
          // An object MAP, not an array — the shape the 0.150.1 schema declares.
          allowedPermissionProfiles: { ":workspace": true, ":full": false },
          allowManagedHooksOnly: true,
        },
      })
    ).toEqual({
      allowedSandboxModes: ["read-only", "workspace-write"],
      allowedApprovalPolicies: ["on-request"],
      allowedPermissionProfiles: { ":workspace": true, ":full": false },
    })
  })

  it("accepts a bare payload without the envelope", () => {
    expect(mapCodexConfigRequirements({ allowedSandboxModes: ["read-only"] })).toEqual({
      allowedSandboxModes: ["read-only"],
    })
  })

  it("returns null rather than a half-populated object for anything unreadable", () => {
    // A missing axis reads as "unconstrained", so inventing one would relax a
    // limit an admin set; inventing an empty one would block a Codex that never
    // restricted anything. Neither is acceptable, so refuse to guess.
    expect(mapCodexConfigRequirements(null)).toBeNull()
    expect(mapCodexConfigRequirements("nope")).toBeNull()
    expect(mapCodexConfigRequirements({})).toBeNull()
    expect(mapCodexConfigRequirements({ requirements: {} })).toBeNull()
    expect(mapCodexConfigRequirements({ allowedSandboxModes: "read-only" })).toBeNull()
  })

  it("drops non-boolean profile entries instead of coercing them", () => {
    expect(
      mapCodexConfigRequirements({ allowedPermissionProfiles: { a: true, b: "yes" } })
    ).toEqual({ allowedPermissionProfiles: { a: true } })
  })
})

describe("checkCodexRequestAgainstRequirements", () => {
  it("refuses nothing when there are no requirements to honour", () => {
    // A Codex with no managed config must behave exactly as it did before.
    expect(checkCodexRequestAgainstRequirements({ sandbox: "danger-full-access" }, null)).toEqual(
      []
    )
    expect(
      checkCodexRequestAgainstRequirements({ sandbox: "danger-full-access" }, undefined)
    ).toEqual([])
  })

  it("refuses nothing on an axis the managed config does not constrain", () => {
    expect(
      checkCodexRequestAgainstRequirements(
        { sandbox: "danger-full-access" },
        { allowedApprovalPolicies: ["never"] }
      )
    ).toEqual([])
  })

  it("names the refused axis and what is permitted instead", () => {
    expect(
      checkCodexRequestAgainstRequirements(
        { sandbox: "danger-full-access" },
        { allowedSandboxModes: ["read-only", "workspace-write"] }
      )
    ).toEqual([
      {
        axis: "sandbox",
        requested: "danger-full-access",
        allowed: ["read-only", "workspace-write"],
      },
    ])
  })

  it("treats a profile mapped to false as forbidden, and lists only the true ones", () => {
    expect(
      checkCodexRequestAgainstRequirements(
        { permissionProfile: ":full" },
        { allowedPermissionProfiles: { ":workspace": true, ":full": false, ":ro": true } }
      )
    ).toEqual([{ axis: "permissionProfile", requested: ":full", allowed: [":workspace", ":ro"] }])
  })

  it("treats a profile the map does not mention as forbidden", () => {
    expect(
      checkCodexRequestAgainstRequirements(
        { permissionProfile: ":invented" },
        { allowedPermissionProfiles: { ":workspace": true } }
      )
    ).toHaveLength(1)
  })

  it("honours an explicitly empty allow-list", () => {
    // `null` means unset in the schema, so an empty ARRAY is a deliberate
    // "nothing is permitted" and must not be softened into "unconstrained".
    expect(
      checkCodexRequestAgainstRequirements({ sandbox: "read-only" }, { allowedSandboxModes: [] })
    ).toEqual([{ axis: "sandbox", requested: "read-only", allowed: [] }])
  })

  it("refuses nothing for a parameter Cognia is omitting", () => {
    // Omitting the parameter is how Cognia asks Codex to apply its own default,
    // and its own default is by definition allowed.
    expect(
      checkCodexRequestAgainstRequirements({}, { allowedSandboxModes: ["read-only"] })
    ).toEqual([])
  })

  it("reports every violated axis at once", () => {
    expect(
      checkCodexRequestAgainstRequirements(
        { sandbox: "danger-full-access", approvalPolicy: "never" },
        { allowedSandboxModes: ["read-only"], allowedApprovalPolicies: ["on-request"] }
      )
    ).toHaveLength(2)
  })
})

describe("assertCodexRequestAllowed", () => {
  it("throws a typed, actionable error naming the allowed values", () => {
    let caught: unknown
    try {
      assertCodexRequestAllowed(
        { sandbox: "danger-full-access" },
        { allowedSandboxModes: ["read-only"] }
      )
    } catch (error) {
      caught = error
    }
    expect(isCodexManagedPolicyError(caught)).toBe(true)
    expect((caught as CodexManagedPolicyError).code).toBe("managed_policy_refused")
    expect((caught as CodexManagedPolicyError).refusals).toHaveLength(1)
    // `reasonCode`, not just `code`: the branch classifier reads that field off
    // a thrown error, so declaring only `code` left `managed_policy_refused` a
    // reason nothing could ever produce.
    expect((caught as CodexManagedPolicyError).reasonCode).toBe("managed_policy_refused")
    expect((caught as Error).message).toContain("read-only")
  })

  it("stays silent when nothing is refused", () => {
    expect(() =>
      assertCodexRequestAllowed({ sandbox: "read-only" }, { allowedSandboxModes: ["read-only"] })
    ).not.toThrow()
  })

  it("does not classify an unrelated error as a managed-policy refusal", () => {
    expect(isCodexManagedPolicyError(new Error("-32602 Invalid params"))).toBe(false)
  })
})
