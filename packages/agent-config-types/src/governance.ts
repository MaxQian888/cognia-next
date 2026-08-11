// Cross-domain Decision / Evidence / Lineage governance contract.
//
// This module is dependency-free and safe on every Cognia rail. It stores
// references and redacted summaries only; raw prompts, tool arguments,
// credentials, connector payloads, and model chain-of-thought stay in their
// owning stores behind their existing access controls.

import { isNonEmptyString, refViolation } from "./ref-safety"

export const GOVERNANCE_CONTRACT_VERSION = 1 as const

export interface GovernanceScopeV1 {
  tenantId?: string
  workspaceId?: string
  projectId?: string
  characterId?: string
}

export interface ResourceRefV1 {
  namespace: string
  type: string
  id: string
  version?: string
  scope?: GovernanceScopeV1
}

export type ActorKindV1 = "human" | "agent" | "system" | "plugin" | "connector" | "device"

export interface ActorRefV1 {
  kind: ActorKindV1
  ref: ResourceRefV1
  delegatedByRef?: ResourceRefV1
}

export interface PolicyRefV1 {
  namespace: string
  id: string
  version?: string
  /** SHA-256 of a canonical, secret-free policy snapshot. */
  digest: string
  snapshotRef?: ResourceRefV1
  effectiveAt?: number
}

export interface PrivacyManifestV1 {
  classification: string
  retentionClass: string
  contentCaptured: boolean
  redactionVersion?: string
  removedFields?: string[]
}

export type EvidenceKindV1 =
  | "message"
  | "file"
  | "capture"
  | "connector"
  | "memory"
  | "twin-chunk"
  | "tool-result"
  | "approval"
  | "policy-evaluation"
  | "manual"

export interface EvidenceRefV1 {
  contractVersion: typeof GOVERNANCE_CONTRACT_VERSION
  id: string
  kind: EvidenceKindV1
  sourceRef: ResourceRefV1
  digest: { algorithm: "sha256"; value: string; canonicalization: string }
  /** Optional redacted display excerpt; never an original source body. */
  excerpt?: { redacted: string; digest: string }
  observedAt: number
  validTime?: { from?: number; to?: number }
  review: {
    status: "unreviewed" | "verified" | "disputed"
    reviewedBy?: ResourceRefV1
  }
  contamination: "clean" | "external-context" | "unknown"
  privacy: PrivacyManifestV1
}

export type DecisionModeV1 = "control" | "observed"
export type DecisionKindV1 =
  | "workflow-branch"
  | "tool-authorization"
  | "human-approval"
  | "connector-route"
  | "connector-action"
  | "memory-resolution"
  | "twin-observation"
  | "fact-resolution"
  | "execution-route"

export type DecisionStateV1 =
  | "observed"
  | "proposed"
  | "resolved"
  | "executed"
  | "failed"
  | "revoked"
  | "disputed"
  | "superseded"

export interface GovernanceCorrelationV1 {
  traceId?: string
  spanId?: string
  sessionId?: string
  requestId?: string
  runId?: string
  workflowId?: string
  stepId?: string
  turnId?: string
  attemptId?: string
}

export interface DecisionCaseV1 {
  contractVersion: typeof GOVERNANCE_CONTRACT_VERSION
  id: string
  mode: DecisionModeV1
  kind: DecisionKindV1
  subjectRef: ResourceRefV1
  question: { code: string; candidateRefs?: ResourceRefV1[] }
  proposer?: ActorRefV1
  decider?: ActorRefV1
  executor?: ActorRefV1
  basis: {
    evidenceRefs: string[]
    policyRefs: PolicyRefV1[]
    parentDecisionRefs: string[]
  }
  resolution?: {
    outcome: string
    selectedRefs?: ResourceRefV1[]
    reasonCode: string
    /** User-facing summary only; never chain-of-thought. */
    rationale?: string
    rationaleOrigin: "human" | "rule" | "model-summary" | "system"
    confidence?: {
      value: number
      meaning: "extraction" | "classification"
      source: string
    }
  }
  lifecycle: {
    state: DecisionStateV1
    proposedAt?: number
    decidedAt?: number
    effectiveAt?: number
    executedAt?: number
    recordedAt: number
    expiresAt?: number
  }
  correlation: GovernanceCorrelationV1
  privacy: PrivacyManifestV1
}

export type DecisionEventTypeV1 =
  | "observed"
  | "proposed"
  | "resolved"
  | "executed"
  | "failed"
  | "revoked"
  | "disputed"
  | "superseded"

export interface DecisionEventV1 {
  contractVersion: typeof GOVERNANCE_CONTRACT_VERSION
  id: string
  decisionId: string
  type: DecisionEventTypeV1
  sequence: number
  actor?: ActorRefV1
  at: number
  reasonCode?: string
  outcome?: string
  effectRef?: ResourceRefV1
  supersedesDecisionId?: string
  correlation?: GovernanceCorrelationV1
}

export type LineageRelationV1 =
  | "used"
  | "generated"
  | "derived-from"
  | "supported-by"
  | "contradicts"
  | "supersedes"
  | "caused-by"
  | "approved-by"
  | "governed-by"
  | "resulted-in"
  | "related-to"

export interface LineageEdgeV1 {
  contractVersion: typeof GOVERNANCE_CONTRACT_VERSION
  id: string
  from: ResourceRefV1
  to: ResourceRefV1
  relation: LineageRelationV1
  assertion: "explicit" | "derived" | "inferred"
  evidenceRefs?: string[]
  actorRef?: ActorRefV1
  policyRef?: PolicyRefV1
  recordedAt: number
  validTime?: { from?: number; to?: number }
}

export type ConflictAuthorityClassV1 =
  "explicit-user" | "trusted-system" | "local-derived" | "connector-derived" | "external-untrusted"

export interface ConflictSetV1 {
  contractVersion: typeof GOVERNANCE_CONTRACT_VERSION
  id: string
  subjectRef: ResourceRefV1
  predicate: { namespace: string; key: string }
  scope: GovernanceScopeV1
  members: Array<{
    assertionRef: ResourceRefV1
    valueDigest: string
    evidenceRefs: string[]
    validTime?: { from?: number; to?: number }
    observedAt: number
    authorityClass: ConflictAuthorityClassV1
  }>
  detection: {
    kind:
      | "mutually-exclusive"
      | "temporal-overlap"
      | "identity-ambiguous"
      | "policy-violation"
      | "semantic-contradiction"
    detectorRef: ResourceRefV1
    policyRef: PolicyRefV1
    confidence?: number
  }
  risk: "low" | "medium" | "high" | "critical"
  recommendation?: {
    kind: "supersede-left" | "supersede-right" | "review"
    reasonCode: string
  }
  status: "open" | "resolved" | "dismissed" | "superseded"
  resolutionDecisionRef?: string
  createdAt: number
  resolvedAt?: number
}

export interface ProvenanceEnvelopeV1 {
  contractVersion: typeof GOVERNANCE_CONTRACT_VERSION
  eventId: string
  eventType: string
  source: string
  subjectRef: ResourceRefV1
  occurredAt: number
  recordedAt: number
  correlation: GovernanceCorrelationV1
  actorRefs: ResourceRefV1[]
  activityRef?: ResourceRefV1
  decisionRefs: string[]
  evidenceRefs: string[]
  inputRefs: ResourceRefV1[]
  outputRefs: ResourceRefV1[]
  policyRefs: PolicyRefV1[]
  privacy: PrivacyManifestV1 & { redactionVersion: string; removedFields: string[] }
  integrity?: {
    canonicalization: string
    digest: string
    partition?: string
    previousDigest?: string
  }
  data?: Record<string, string | number | boolean | null>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value)
}

function validateRef(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`)
    return
  }
  for (const key of ["namespace", "type", "id"] as const) {
    if (!isNonEmptyString(value[key])) errors.push(`${path}.${key} is required`)
  }
  if (isNonEmptyString(value.id)) {
    const violation = refViolation(value.id)
    if (violation) {
      errors.push(
        `${path}.id: ${violation === "URL-shaped value in a ref position" ? "must be an id/ref, not a URL" : violation}`
      )
    }
  }
}

function validatePolicy(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`)
    return
  }
  if (!isNonEmptyString(value.namespace)) errors.push(`${path}.namespace is required`)
  if (!isNonEmptyString(value.id)) errors.push(`${path}.id is required`)
  if (!isNonEmptyString(value.digest)) errors.push(`${path}.digest is required`)
}

function validatePrivacy(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`)
    return
  }
  if (!isNonEmptyString(value.classification)) errors.push(`${path}.classification is required`)
  if (!isNonEmptyString(value.retentionClass)) errors.push(`${path}.retentionClass is required`)
  if (typeof value.contentCaptured !== "boolean") {
    errors.push(`${path}.contentCaptured must be a boolean`)
  }
}

function validateStringArray(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    errors.push(`${path} must be an array of non-empty strings`)
  }
}

export function validateEvidenceRef(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ["evidence must be an object"]
  if (value.contractVersion !== GOVERNANCE_CONTRACT_VERSION)
    errors.push("contractVersion must be 1")
  if (!isNonEmptyString(value.id)) errors.push("id is required")
  if (
    !member(value.kind, [
      "message",
      "file",
      "capture",
      "connector",
      "memory",
      "twin-chunk",
      "tool-result",
      "approval",
      "policy-evaluation",
      "manual",
    ] as const)
  )
    errors.push("kind must be a known EvidenceKindV1")
  validateRef(value.sourceRef, "sourceRef", errors)
  if (
    !isRecord(value.digest) ||
    value.digest.algorithm !== "sha256" ||
    !isNonEmptyString(value.digest.value) ||
    !isNonEmptyString(value.digest.canonicalization)
  )
    errors.push("digest must be a sha256 digest descriptor")
  if (!finite(value.observedAt)) errors.push("observedAt must be a finite timestamp")
  if (
    !isRecord(value.review) ||
    !member(value.review.status, ["unreviewed", "verified", "disputed"] as const)
  )
    errors.push("review.status must be known")
  if (!member(value.contamination, ["clean", "external-context", "unknown"] as const))
    errors.push("contamination must be known")
  validatePrivacy(value.privacy, "privacy", errors)
  return errors
}

export function isEvidenceRef(value: unknown): value is EvidenceRefV1 {
  return validateEvidenceRef(value).length === 0
}

export function validateDecisionCase(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ["decision must be an object"]
  if (value.contractVersion !== GOVERNANCE_CONTRACT_VERSION)
    errors.push("contractVersion must be 1")
  if (!isNonEmptyString(value.id)) errors.push("id is required")
  if (!member(value.mode, ["control", "observed"] as const))
    errors.push("mode must be control or observed")
  if (
    !member(value.kind, [
      "workflow-branch",
      "tool-authorization",
      "human-approval",
      "connector-route",
      "connector-action",
      "memory-resolution",
      "twin-observation",
      "fact-resolution",
      "execution-route",
    ] as const)
  )
    errors.push("kind must be a known DecisionKindV1")
  validateRef(value.subjectRef, "subjectRef", errors)
  if (!isRecord(value.question) || !isNonEmptyString(value.question.code))
    errors.push("question.code is required")
  if (!isRecord(value.basis)) {
    errors.push("basis is required")
  } else {
    validateStringArray(value.basis.evidenceRefs, "basis.evidenceRefs", errors)
    validateStringArray(value.basis.parentDecisionRefs, "basis.parentDecisionRefs", errors)
    if (!Array.isArray(value.basis.policyRefs)) errors.push("basis.policyRefs must be an array")
    else
      value.basis.policyRefs.forEach((policy, index) =>
        validatePolicy(policy, `basis.policyRefs[${index}]`, errors)
      )
  }
  if (!isRecord(value.lifecycle)) {
    errors.push("lifecycle is required")
  } else {
    const state = value.lifecycle.state
    if (
      !member(state, [
        "observed",
        "proposed",
        "resolved",
        "executed",
        "failed",
        "revoked",
        "disputed",
        "superseded",
      ] as const)
    )
      errors.push("lifecycle.state must be known")
    if (!finite(value.lifecycle.recordedAt))
      errors.push("lifecycle.recordedAt must be a finite timestamp")
    if (["resolved", "executed", "failed", "revoked", "superseded"].includes(String(state))) {
      if (!isRecord(value.resolution)) errors.push("resolution is required for a resolved decision")
      if (!finite(value.lifecycle.decidedAt))
        errors.push("lifecycle.decidedAt is required for a resolved decision")
    }
  }
  validatePrivacy(value.privacy, "privacy", errors)
  return errors
}

export function isDecisionCase(value: unknown): value is DecisionCaseV1 {
  return validateDecisionCase(value).length === 0
}

export function validateLineageEdge(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ["lineage edge must be an object"]
  if (value.contractVersion !== GOVERNANCE_CONTRACT_VERSION)
    errors.push("contractVersion must be 1")
  if (!isNonEmptyString(value.id)) errors.push("id is required")
  validateRef(value.from, "from", errors)
  validateRef(value.to, "to", errors)
  if (
    !member(value.relation, [
      "used",
      "generated",
      "derived-from",
      "supported-by",
      "contradicts",
      "supersedes",
      "caused-by",
      "approved-by",
      "governed-by",
      "resulted-in",
      "related-to",
    ] as const)
  )
    errors.push("relation must be known")
  if (!member(value.assertion, ["explicit", "derived", "inferred"] as const))
    errors.push("assertion must be known")
  if (!finite(value.recordedAt)) errors.push("recordedAt must be a finite timestamp")
  return errors
}

export function isLineageEdge(value: unknown): value is LineageEdgeV1 {
  return validateLineageEdge(value).length === 0
}

export function validateConflictSet(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ["conflict must be an object"]
  if (value.contractVersion !== GOVERNANCE_CONTRACT_VERSION)
    errors.push("contractVersion must be 1")
  if (!isNonEmptyString(value.id)) errors.push("id is required")
  validateRef(value.subjectRef, "subjectRef", errors)
  if (
    !isRecord(value.predicate) ||
    !isNonEmptyString(value.predicate.namespace) ||
    !isNonEmptyString(value.predicate.key)
  )
    errors.push("predicate namespace and key are required")
  if (!Array.isArray(value.members) || value.members.length < 2)
    errors.push("members must contain at least two assertions")
  if (!isRecord(value.detection)) errors.push("detection is required")
  else validatePolicy(value.detection.policyRef, "detection.policyRef", errors)
  if (!member(value.risk, ["low", "medium", "high", "critical"] as const))
    errors.push("risk must be known")
  if (value.recommendation !== undefined) {
    if (!isRecord(value.recommendation)) {
      errors.push("recommendation must be an object")
    } else {
      if (
        !member(value.recommendation.kind, ["supersede-left", "supersede-right", "review"] as const)
      )
        errors.push("recommendation.kind must be known")
      if (!isNonEmptyString(value.recommendation.reasonCode))
        errors.push("recommendation.reasonCode is required")
    }
  }
  if (!member(value.status, ["open", "resolved", "dismissed", "superseded"] as const))
    errors.push("status must be known")
  if (!finite(value.createdAt)) errors.push("createdAt must be a finite timestamp")
  if (value.status === "resolved" && !isNonEmptyString(value.resolutionDecisionRef))
    errors.push("resolutionDecisionRef is required when resolved")
  return errors
}

export function isConflictSet(value: unknown): value is ConflictSetV1 {
  return validateConflictSet(value).length === 0
}

export function validateProvenanceEnvelope(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ["envelope must be an object"]
  if (value.contractVersion !== GOVERNANCE_CONTRACT_VERSION)
    errors.push("contractVersion must be 1")
  if (!isNonEmptyString(value.eventId)) errors.push("eventId is required")
  if (!isNonEmptyString(value.eventType)) errors.push("eventType is required")
  if (!isNonEmptyString(value.source)) errors.push("source is required")
  validateRef(value.subjectRef, "subjectRef", errors)
  if (!finite(value.occurredAt)) errors.push("occurredAt must be a finite timestamp")
  if (!finite(value.recordedAt)) errors.push("recordedAt must be a finite timestamp")
  for (const key of ["decisionRefs", "evidenceRefs"] as const)
    validateStringArray(value[key], key, errors)
  for (const key of ["actorRefs", "inputRefs", "outputRefs"] as const) {
    if (!Array.isArray(value[key])) errors.push(`${key} must be an array`)
    else value[key].forEach((ref, index) => validateRef(ref, `${key}[${index}]`, errors))
  }
  if (!Array.isArray(value.policyRefs)) errors.push("policyRefs must be an array")
  validatePrivacy(value.privacy, "privacy", errors)
  if (
    value.data !== undefined &&
    (!isRecord(value.data) ||
      Object.values(value.data).some(
        (nested) => nested !== null && !["string", "number", "boolean"].includes(typeof nested)
      ))
  )
    errors.push("data values must be primitive or null")
  return errors
}

export function isProvenanceEnvelope(value: unknown): value is ProvenanceEnvelopeV1 {
  return validateProvenanceEnvelope(value).length === 0
}
