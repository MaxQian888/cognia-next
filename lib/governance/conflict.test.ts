import type { ConflictSetV1 } from "@cognia/agent-config-types/governance"
import {
  classifyAssertions,
  createConflictSet,
  recommendConflictResolution,
  type GovernanceAssertion,
} from "./conflict"

function assertion(overrides: Partial<GovernanceAssertion> = {}): GovernanceAssertion {
  return {
    assertionRef: { namespace: "cognia", type: "memory", id: "m1" },
    subjectRef: { namespace: "cognia", type: "project", id: "p1" },
    predicate: { namespace: "preference", key: "package-manager" },
    scope: { projectId: "p1" },
    valueDigest: "npm",
    evidenceRefs: ["e1"],
    observedAt: 1_000,
    validTime: { from: 100, to: 200 },
    authorityClass: "local-derived",
    ...overrides,
  }
}

describe("classifyAssertions", () => {
  it("deduplicates the same value while preserving independent evidence", () => {
    expect(
      classifyAssertions(assertion(), assertion({ evidenceRefs: ["e2"], observedAt: 1_100 }))
    ).toBe("duplicate")
  })

  it("treats non-overlapping valid times as a revision rather than a conflict", () => {
    expect(
      classifyAssertions(
        assertion({ validTime: { from: 100, to: 200 } }),
        assertion({ valueDigest: "pnpm", validTime: { from: 201 } })
      )
    ).toBe("revision")
  })

  it("does not compare assertions from disjoint projects", () => {
    expect(
      classifyAssertions(
        assertion(),
        assertion({ valueDigest: "pnpm", scope: { projectId: "p2" } })
      )
    ).toBe("unrelated")
  })

  it("detects mutually exclusive values with overlapping scope and time", () => {
    expect(classifyAssertions(assertion(), assertion({ valueDigest: "pnpm" }))).toBe("conflict")
  })
})

describe("conflict resolution", () => {
  it("keeps an explicit user assertion over a connector-derived assertion", () => {
    expect(
      recommendConflictResolution(
        assertion({ authorityClass: "explicit-user" }),
        assertion({ authorityClass: "connector-derived", valueDigest: "pnpm" }),
        "high"
      )
    ).toEqual({ kind: "supersede-right", reasonCode: "explicit-user-authority" })
  })

  it("requires review for high-risk assertions with equal authority", () => {
    expect(
      recommendConflictResolution(assertion(), assertion({ valueDigest: "pnpm" }), "high")
    ).toEqual({ kind: "review", reasonCode: "high-risk-conflict" })
  })

  it("creates a stable open ConflictSet from both assertions", () => {
    const result: ConflictSetV1 = createConflictSet({
      id: "conflict-1",
      left: assertion(),
      right: assertion({
        assertionRef: { namespace: "cognia", type: "memory", id: "m2" },
        valueDigest: "pnpm",
        evidenceRefs: ["e2"],
      }),
      risk: "high",
      createdAt: 1_200,
      detectorRef: { namespace: "cognia", type: "detector", id: "conflict-v1" },
      policyRef: { namespace: "governance", id: "conflict-v1", digest: "a".repeat(64) },
    })

    expect(result).toMatchObject({
      id: "conflict-1",
      status: "open",
      risk: "high",
      recommendation: { kind: "review", reasonCode: "high-risk-conflict" },
      members: [
        { assertionRef: { id: "m1" }, valueDigest: "npm" },
        { assertionRef: { id: "m2" }, valueDigest: "pnpm" },
      ],
    })
  })
})
