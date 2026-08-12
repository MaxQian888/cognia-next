import {
  GOVERNANCE_CONTRACT_VERSION,
  isConflictSet,
  isDecisionCase,
  isEvidenceRef,
  isLineageEdge,
  isProvenanceEnvelope,
  type ConflictSetV1,
  type DecisionCaseV1,
  type DecisionEventTypeV1,
  type DecisionEventV1,
  type EvidenceRefV1,
  type GovernanceCorrelationV1,
  type LineageEdgeV1,
  type ProvenanceEnvelopeV1,
  type ResourceRefV1,
} from "@cognia/agent-config-types/governance"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { loggers } from "@cognia/logging"
import { getDb } from "./schema"

export interface GovernanceDecisionRow extends DecisionCaseV1 {
  state: DecisionCaseV1["lifecycle"]["state"]
  recordedAt: number
  subjectKey: string
  projectId?: string
  runId?: string
  sessionId?: string
}

export interface GovernanceDecisionEventRow extends DecisionEventV1 {
  runId?: string
}

export interface GovernanceEvidenceRow extends EvidenceRefV1 {
  sourceKey: string
  projectId?: string
}

export interface GovernanceLineageRow extends LineageEdgeV1 {
  fromKey: string
  toKey: string
  evidenceRefs: string[]
}

export interface GovernanceConflictRow extends ConflictSetV1 {
  subjectKey: string
  predicateKey: string
  projectId?: string
}

export interface GovernanceProvenanceRow extends ProvenanceEnvelopeV1 {
  subjectKey: string
  runId?: string
  projectId?: string
}

export function governanceRefKey(ref: ResourceRefV1): string {
  return `${ref.namespace}:${ref.type}:${ref.id}${ref.version ? `@${ref.version}` : ""}`
}

function piiProjection(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value
  if (ancestors.has(value)) return "governance-cycle@example.invalid"
  ancestors.add(value)
  if (Array.isArray(value)) {
    const projected = value.map((item) => piiProjection(item, ancestors))
    ancestors.delete(value)
    return projected
  }
  const source = value as Record<string, unknown>
  const projected: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    const isDigestValue =
      typeof item === "string" && /^(?:[a-f0-9]{64}|sha256:[a-f0-9]{64})$/i.test(item)
    const isEvidenceDigestValue =
      key === "value" &&
      isDigestValue &&
      typeof source.algorithm === "string" &&
      typeof source.canonicalization === "string"
    const isPolicyDigest =
      key === "digest" &&
      isDigestValue &&
      typeof source.namespace === "string" &&
      typeof source.id === "string"
    const isIntegrityDigest =
      (key === "digest" || key === "previousDigest") &&
      isDigestValue &&
      typeof source.canonicalization === "string"
    projected[key] =
      (key === "valueDigest" && isDigestValue) ||
      isEvidenceDigestValue ||
      isPolicyDigest ||
      isIntegrityDigest
        ? "sha256-digest"
        : piiProjection(item, ancestors)
  }
  ancestors.delete(value)
  return projected
}

function assertGovernancePayloadSafe(kind: string, value: unknown): void {
  if (!hasNoLeakingPiiDeep(piiProjection(value))) {
    throw new Error(`Governance ${kind} rejected by PII gate`)
  }
}

function decisionRow(decision: DecisionCaseV1): GovernanceDecisionRow {
  return {
    ...decision,
    state: decision.lifecycle.state,
    recordedAt: decision.lifecycle.recordedAt,
    subjectKey: governanceRefKey(decision.subjectRef),
    projectId: decision.subjectRef.scope?.projectId,
    runId: decision.correlation.runId,
    sessionId: decision.correlation.sessionId,
  }
}

export async function recordDecision(decision: DecisionCaseV1): Promise<GovernanceDecisionRow> {
  assertGovernancePayloadSafe("decision", decision)
  if (!isDecisionCase(decision)) throw new Error("Invalid governance decision")
  const db = getDb()
  const existing = await db.governanceDecisions.get(decision.id)
  const row = decisionRow(decision)
  if (existing) {
    if (
      existing.mode !== row.mode ||
      existing.kind !== row.kind ||
      existing.subjectKey !== row.subjectKey
    ) {
      throw new Error(`Governance decision identity collision: ${decision.id}`)
    }
    return existing
  }
  await db.governanceDecisions.add(row)
  return row
}

export type AppendDecisionEventInput = Omit<DecisionEventV1, "contractVersion" | "sequence">

function eventState(type: DecisionEventTypeV1): DecisionCaseV1["lifecycle"]["state"] {
  return type
}

/** Append one producer event exactly once and update the current projection. */
export async function appendDecisionEvent(
  input: AppendDecisionEventInput
): Promise<GovernanceDecisionEventRow> {
  assertGovernancePayloadSafe("decision event", input)
  const db = getDb()
  return db.transaction("rw", db.governanceDecisions, db.governanceDecisionEvents, async () => {
    const duplicate = await db.governanceDecisionEvents.get(input.id)
    if (duplicate) return duplicate
    const decision = await db.governanceDecisions.get(input.decisionId)
    if (!decision) throw new Error(`Unknown governance decision: ${input.decisionId}`)
    const existingEvents = await db.governanceDecisionEvents
      .where("decisionId")
      .equals(input.decisionId)
      .toArray()
    const row: GovernanceDecisionEventRow = {
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      ...input,
      sequence: Math.max(0, ...existingEvents.map((event) => event.sequence)) + 1,
      runId: input.correlation?.runId ?? decision.runId,
    }
    await db.governanceDecisionEvents.add(row)

    const lifecycle: DecisionCaseV1["lifecycle"] = {
      ...decision.lifecycle,
      state: eventState(input.type),
      ...(input.type === "proposed" ? { proposedAt: input.at } : {}),
      ...(["resolved", "executed", "failed", "revoked", "superseded"].includes(input.type)
        ? { decidedAt: decision.lifecycle.decidedAt ?? input.at }
        : {}),
      ...(input.type === "executed" ? { executedAt: input.at } : {}),
    }
    const resolution =
      input.type === "resolved" && input.outcome
        ? {
            ...decision.resolution,
            outcome: input.outcome,
            reasonCode: input.reasonCode ?? "unspecified",
            rationaleOrigin: decision.resolution?.rationaleOrigin ?? ("system" as const),
          }
        : decision.resolution
    await db.governanceDecisions.put(
      decisionRow({ ...decision, lifecycle, ...(resolution ? { resolution } : {}) })
    )
    return row
  })
}

export async function recordEvidenceRef(evidence: EvidenceRefV1): Promise<GovernanceEvidenceRow> {
  assertGovernancePayloadSafe("evidence", evidence)
  if (!isEvidenceRef(evidence)) throw new Error("Invalid governance evidence")
  const row: GovernanceEvidenceRow = {
    ...evidence,
    sourceKey: governanceRefKey(evidence.sourceRef),
    projectId: evidence.sourceRef.scope?.projectId,
  }
  const db = getDb()
  const existing = await db.governanceEvidence.get(evidence.id)
  if (existing) {
    if (
      existing.kind !== row.kind ||
      existing.sourceKey !== row.sourceKey ||
      existing.digest.algorithm !== row.digest.algorithm ||
      existing.digest.value !== row.digest.value ||
      existing.digest.canonicalization !== row.digest.canonicalization
    ) {
      throw new Error(`Governance evidence identity collision: ${evidence.id}`)
    }
    return existing
  }
  await db.governanceEvidence.add(row)
  return row
}

export async function recordLineageEdge(edge: LineageEdgeV1): Promise<GovernanceLineageRow> {
  assertGovernancePayloadSafe("lineage", edge)
  if (!isLineageEdge(edge)) throw new Error("Invalid governance lineage edge")
  const row: GovernanceLineageRow = {
    ...edge,
    fromKey: governanceRefKey(edge.from),
    toKey: governanceRefKey(edge.to),
    evidenceRefs: edge.evidenceRefs ?? [],
  }
  const db = getDb()
  const existing = await db.governanceLineage.get(edge.id)
  if (existing) {
    if (
      existing.fromKey !== row.fromKey ||
      existing.toKey !== row.toKey ||
      existing.relation !== row.relation
    ) {
      throw new Error(`Governance lineage identity collision: ${edge.id}`)
    }
    return existing
  }
  await db.governanceLineage.add(row)
  return row
}

export async function recordConflictSet(conflict: ConflictSetV1): Promise<GovernanceConflictRow> {
  assertGovernancePayloadSafe("conflict", conflict)
  if (!isConflictSet(conflict)) throw new Error("Invalid governance conflict")
  const row: GovernanceConflictRow = {
    ...conflict,
    subjectKey: governanceRefKey(conflict.subjectRef),
    predicateKey: `${conflict.predicate.namespace}:${conflict.predicate.key}`,
    projectId: conflict.scope.projectId,
  }
  const db = getDb()
  const existing = await db.governanceConflicts.get(conflict.id)
  if (existing) {
    const memberIdentity = (value: GovernanceConflictRow | typeof row) =>
      value.members.map(
        (member) => `${governanceRefKey(member.assertionRef)}:${member.valueDigest}`
      )
    if (
      existing.subjectKey !== row.subjectKey ||
      existing.predicateKey !== row.predicateKey ||
      JSON.stringify(memberIdentity(existing)) !== JSON.stringify(memberIdentity(row))
    ) {
      throw new Error(`Governance conflict identity collision: ${conflict.id}`)
    }
    return existing
  }
  await db.governanceConflicts.add(row)
  return row
}

export async function resolveConflictSet(
  conflictId: string,
  resolutionDecisionRef: string,
  resolvedAt: number
): Promise<GovernanceConflictRow> {
  assertGovernancePayloadSafe("conflict resolution", {
    conflictId,
    resolutionDecisionRef,
    resolvedAt,
  })
  const db = getDb()
  return db.transaction("rw", db.governanceDecisions, db.governanceConflicts, async () => {
    const [conflict, decision] = await Promise.all([
      db.governanceConflicts.get(conflictId),
      db.governanceDecisions.get(resolutionDecisionRef),
    ])
    if (!conflict) throw new Error(`Unknown governance conflict: ${conflictId}`)
    if (!decision) throw new Error(`Unknown governance decision: ${resolutionDecisionRef}`)
    const next: GovernanceConflictRow = {
      ...conflict,
      status: "resolved",
      resolutionDecisionRef,
      resolvedAt,
    }
    await db.governanceConflicts.put(next)
    return next
  })
}

export async function recordProvenanceEnvelope(
  envelope: ProvenanceEnvelopeV1
): Promise<GovernanceProvenanceRow> {
  assertGovernancePayloadSafe("provenance", envelope)
  if (!isProvenanceEnvelope(envelope)) throw new Error("Invalid governance provenance envelope")
  const row: GovernanceProvenanceRow = {
    ...envelope,
    subjectKey: governanceRefKey(envelope.subjectRef),
    runId: envelope.correlation.runId,
    projectId: envelope.subjectRef.scope?.projectId,
  }
  const db = getDb()
  const existing = await db.governanceProvenance.get(envelope.eventId)
  if (existing) {
    if (existing.eventType !== row.eventType || existing.subjectKey !== row.subjectKey) {
      throw new Error(`Governance provenance identity collision: ${envelope.eventId}`)
    }
    return existing
  }
  await db.governanceProvenance.add(row)
  return row
}

export interface GovernanceProjectionFailureInput {
  producer: string
  operation: string
  subjectRef: ResourceRefV1
  occurredAt: number
  correlation?: GovernanceCorrelationV1
}

/** Record a content-free audit gap without allowing observability to break the source action. */
export async function reportGovernanceProjectionFailure(
  input: GovernanceProjectionFailureInput,
  error: unknown
): Promise<void> {
  const errorType = error instanceof Error ? "Error" : typeof error
  let auditGapErrorType: string | undefined
  try {
    await recordProvenanceEnvelope({
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      eventId: `governance-gap:${input.producer}:${input.operation}:${governanceRefKey(input.subjectRef)}:${input.occurredAt}`,
      eventType: "governance.projection.failed",
      source: `cognia://governance/${input.producer}`,
      subjectRef: input.subjectRef,
      occurredAt: input.occurredAt,
      recordedAt: Date.now(),
      correlation: input.correlation ?? {},
      actorRefs: [],
      decisionRefs: [],
      evidenceRefs: [],
      inputRefs: [],
      outputRefs: [],
      policyRefs: [],
      privacy: {
        classification: "private",
        retentionClass: "governance-audit-gap",
        contentCaptured: false,
        redactionVersion: "governance-audit-gap-v1",
        removedFields: ["error.message", "error.stack", "payload"],
      },
      data: { producer: input.producer, operation: input.operation, errorType },
    })
  } catch (auditGapError) {
    auditGapErrorType =
      auditGapError instanceof Error ? auditGapError.name || "Error" : typeof auditGapError
    // The projection store itself may be unavailable; the structured logger is
    // an independent last-resort observability surface and carries no payload.
  }
  loggers.store.warn("governance projection failed", {
    producer: input.producer,
    operation: input.operation,
    subjectType: input.subjectRef.type,
    errorType,
    ...(auditGapErrorType ? { auditGapErrorType } : {}),
  })
}

export async function listRecentGovernanceAuditGaps(
  limit = 25
): Promise<GovernanceProvenanceRow[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive integer")
  const rows = await getDb()
    .governanceProvenance.where("eventType")
    .equals("governance.projection.failed")
    .sortBy("occurredAt")
  return rows.reverse().slice(0, limit)
}

export interface DecisionContextView {
  decision: GovernanceDecisionRow
  events: GovernanceDecisionEventRow[]
  evidence: GovernanceEvidenceRow[]
  lineage: GovernanceLineageRow[]
  conflicts: GovernanceConflictRow[]
  provenance: GovernanceProvenanceRow[]
}

export async function getDecisionContext(
  decisionId: string
): Promise<DecisionContextView | undefined> {
  const db = getDb()
  const decision = await db.governanceDecisions.get(decisionId)
  if (!decision) return undefined
  const decisionKey = governanceRefKey({ namespace: "cognia", type: "decision", id: decisionId })
  const [
    events,
    directEvidence,
    incoming,
    outgoing,
    resolutionConflicts,
    subjectConflicts,
    provenance,
  ] = await Promise.all([
    db.governanceDecisionEvents.where("decisionId").equals(decisionId).sortBy("sequence"),
    db.governanceEvidence.bulkGet(decision.basis.evidenceRefs),
    db.governanceLineage.where("toKey").equals(decisionKey).toArray(),
    db.governanceLineage.where("fromKey").equals(decisionKey).toArray(),
    db.governanceConflicts.where("resolutionDecisionRef").equals(decisionId).toArray(),
    db.governanceConflicts.where("subjectKey").equals(decision.subjectKey).toArray(),
    db.governanceProvenance.where("decisionRefs").equals(decisionId).toArray(),
  ])
  const directLineage = [...incoming, ...outgoing]
  const neighborKeys = [
    ...new Set(
      directLineage
        .flatMap((edge) => [edge.fromKey, edge.toKey])
        .filter((key) => key !== decisionKey)
    ),
  ]
  const secondHop =
    neighborKeys.length === 0
      ? []
      : [
          ...(await db.governanceLineage.where("fromKey").anyOf(neighborKeys).toArray()),
          ...(await db.governanceLineage.where("toKey").anyOf(neighborKeys).toArray()),
        ]
  const lineage = [
    ...new Map([...directLineage, ...secondHop].map((edge) => [edge.id, edge])).values(),
  ]
  const referencedEvidence = new Set([
    ...decision.basis.evidenceRefs,
    ...lineage.flatMap((edge) => edge.evidenceRefs),
  ])
  const missingEvidence = [...referencedEvidence].filter(
    (id) => !directEvidence.some((item) => item?.id === id)
  )
  const extraEvidence = await db.governanceEvidence.bulkGet(missingEvidence)
  return {
    decision,
    events,
    evidence: [...directEvidence, ...extraEvidence].filter(
      (item): item is GovernanceEvidenceRow => item !== undefined
    ),
    lineage,
    conflicts: [
      ...new Map(
        [...resolutionConflicts, ...subjectConflicts].map((conflict) => [conflict.id, conflict])
      ).values(),
    ],
    provenance,
  }
}

export async function listDecisionContextsByCorrelation(
  correlation: Pick<GovernanceCorrelationV1, "runId" | "sessionId">
): Promise<GovernanceDecisionRow[]> {
  const db = getDb()
  if (correlation.runId) {
    return db.governanceDecisions.where("runId").equals(correlation.runId).sortBy("recordedAt")
  }
  if (correlation.sessionId) {
    return db.governanceDecisions
      .where("sessionId")
      .equals(correlation.sessionId)
      .sortBy("recordedAt")
  }
  return []
}

/** List the newest decision projections for the local Context Inspector. */
export async function listRecentDecisions(limit = 25): Promise<GovernanceDecisionRow[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive integer")
  const rows = await getDb()
    .governanceDecisions.orderBy("recordedAt")
    .reverse()
    .limit(limit)
    .toArray()
  return rows
}
