import { assessClaimSupport } from "./claim-support"
import type { MemoryEvidence } from "../types/governance"

type Cite = Pick<MemoryEvidence, "kind" | "validationStrategy" | "validationState">

const message = (state: MemoryEvidence["validationState"]): Cite => ({
  kind: "message",
  validationStrategy: "message-presence",
  validationState: state,
})

describe("assessClaimSupport", () => {
  it("treats a fully-verified citation as fresh", () => {
    const verdict = assessClaimSupport([message("valid")])
    expect(verdict).toMatchObject({ staleness: "fresh", invalidate: false, revoked: false })
  })

  it("does not read never-checked as checked-and-fine", () => {
    // One unchecked citation is worth 0.3 — enough to keep the claim, not
    // enough to call it confirmed.
    const verdict = assessClaimSupport([message("unvalidated")])
    expect(verdict.staleness).toBe("stale")
    expect(verdict.invalidate).toBe(false)
  })

  it("lets several unchecked citations add up to fresh", () => {
    expect(
      assessClaimSupport([
        message(undefined),
        message(undefined),
        message(undefined),
        message(undefined),
      ]).staleness
    ).toBe("fresh")
  })

  it("drops to zero on a single revoked citation, however much else survives", () => {
    // Deleted or altered evidence cannot be outvoted by evidence that merely
    // still exists: we no longer know what the claim was derived from.
    const verdict = assessClaimSupport([message("valid"), message("valid"), message("revoked")])
    expect(verdict).toMatchObject({
      support: 0,
      revoked: true,
      invalidate: true,
      staleness: "expired",
    })
  })

  it("ranks a human confirmation above anything the miner concluded", () => {
    const human: Cite = {
      kind: "manual",
      validationStrategy: "user-confirmation",
      validationState: "valid",
    }
    expect(assessClaimSupport([human]).support).toBeGreaterThan(
      assessClaimSupport([message("valid")]).support
    )
  })

  it("counts code-location as nothing, so a claim is not stronger on desktop", () => {
    // It is recorded but deliberately unverifiable off-desktop; weighing it
    // would make the same row rank differently on a phone.
    const codeOnly: Cite = {
      kind: "code-location",
      validationStrategy: "none",
      validationState: "unverifiable",
    }
    expect(assessClaimSupport([codeOnly])).toMatchObject({ support: 0, invalidate: true })
    expect(assessClaimSupport([message("valid"), codeOnly]).support).toBe(
      assessClaimSupport([message("valid")]).support
    )
  })

  it("does not invalidate a claim it has nothing to check", () => {
    // A restored backup carries evidence descriptors but never verdicts, and a
    // row whose evidence writes failed has none at all. Treating "nothing to
    // check" as "checked and false" would delete both on the first sweep.
    expect(assessClaimSupport([])).toMatchObject({
      invalidate: false,
      staleness: "unknown",
      counted: 0,
    })
  })

  it("ignores an unverifiable verdict without letting it revoke the claim", () => {
    const verdict = assessClaimSupport([
      message("valid"),
      {
        kind: "tool-result",
        validationStrategy: "tool-result-hash",
        validationState: "unverifiable",
      },
    ])
    expect(verdict.invalidate).toBe(false)
    expect(verdict.revoked).toBe(false)
  })
})
