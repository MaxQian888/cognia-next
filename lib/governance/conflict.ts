import {
  GOVERNANCE_CONTRACT_VERSION,
  type ConflictAuthorityClassV1,
  type ConflictSetV1,
  type GovernanceScopeV1,
  type PolicyRefV1,
  type ResourceRefV1,
} from "@cognia/agent-config-types/governance"

export interface GovernanceAssertion {
  assertionRef: ResourceRefV1
  subjectRef: ResourceRefV1
  predicate: { namespace: string; key: string }
  scope: GovernanceScopeV1
  valueDigest: string
  evidenceRefs: string[]
  observedAt: number
  validTime?: { from?: number; to?: number }
  authorityClass: ConflictAuthorityClassV1
}

export type AssertionRelationship = "duplicate" | "revision" | "conflict" | "unrelated"

function sameRef(left: ResourceRefV1, right: ResourceRefV1): boolean {
  return left.namespace === right.namespace && left.type === right.type && left.id === right.id
}

function scopesOverlap(left: GovernanceScopeV1, right: GovernanceScopeV1): boolean {
  for (const key of ["tenantId", "workspaceId", "projectId", "characterId"] as const) {
    if (left[key] !== undefined && right[key] !== undefined && left[key] !== right[key]) {
      return false
    }
  }
  return true
}

function timesOverlap(
  left: GovernanceAssertion["validTime"],
  right: GovernanceAssertion["validTime"]
): boolean {
  const leftFrom = left?.from ?? Number.NEGATIVE_INFINITY
  const leftTo = left?.to ?? Number.POSITIVE_INFINITY
  const rightFrom = right?.from ?? Number.NEGATIVE_INFINITY
  const rightTo = right?.to ?? Number.POSITIVE_INFINITY
  return leftFrom <= rightTo && rightFrom <= leftTo
}

/**
 * Classify two normalized assertions before any semantic merge occurs.
 * Identity, predicate, scope and valid time are load-bearing: two different
 * projects or two successive time intervals are not contradictions.
 */
export function classifyAssertions(
  left: GovernanceAssertion,
  right: GovernanceAssertion
): AssertionRelationship {
  if (
    !sameRef(left.subjectRef, right.subjectRef) ||
    left.predicate.namespace !== right.predicate.namespace ||
    left.predicate.key !== right.predicate.key ||
    !scopesOverlap(left.scope, right.scope)
  ) {
    return "unrelated"
  }
  if (left.valueDigest === right.valueDigest) return "duplicate"
  if (!timesOverlap(left.validTime, right.validTime)) return "revision"
  return "conflict"
}

export type ConflictResolutionRecommendation =
  | { kind: "supersede-left" | "supersede-right"; reasonCode: string }
  | { kind: "review"; reasonCode: string }

export function recommendConflictResolution(
  left: GovernanceAssertion,
  right: GovernanceAssertion,
  risk: ConflictSetV1["risk"]
): ConflictResolutionRecommendation {
  if (left.authorityClass === "explicit-user" && right.authorityClass !== "explicit-user") {
    return { kind: "supersede-right", reasonCode: "explicit-user-authority" }
  }
  if (right.authorityClass === "explicit-user" && left.authorityClass !== "explicit-user") {
    return { kind: "supersede-left", reasonCode: "explicit-user-authority" }
  }
  if (risk === "high" || risk === "critical") {
    return { kind: "review", reasonCode: "high-risk-conflict" }
  }
  return { kind: "review", reasonCode: "authority-unresolved" }
}

export function createConflictSet(input: {
  id: string
  left: GovernanceAssertion
  right: GovernanceAssertion
  risk: ConflictSetV1["risk"]
  createdAt: number
  detectorRef: ResourceRefV1
  policyRef: PolicyRefV1
}): ConflictSetV1 {
  if (classifyAssertions(input.left, input.right) !== "conflict") {
    throw new Error("ConflictSet requires comparable, contradictory assertions")
  }
  const recommendation = recommendConflictResolution(input.left, input.right, input.risk)
  return {
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: input.id,
    subjectRef: input.left.subjectRef,
    predicate: input.left.predicate,
    scope: { ...input.left.scope },
    members: [input.left, input.right].map((assertion) => ({
      assertionRef: assertion.assertionRef,
      valueDigest: assertion.valueDigest,
      evidenceRefs: [...assertion.evidenceRefs],
      ...(assertion.validTime ? { validTime: { ...assertion.validTime } } : {}),
      observedAt: assertion.observedAt,
      authorityClass: assertion.authorityClass,
    })),
    detection: {
      kind: "mutually-exclusive",
      detectorRef: input.detectorRef,
      policyRef: input.policyRef,
    },
    risk: input.risk,
    recommendation,
    status: "open",
    createdAt: input.createdAt,
  }
}
