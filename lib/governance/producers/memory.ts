import { GOVERNANCE_CONTRACT_VERSION } from "@cognia/agent-config-types/governance"
import { redactText } from "@cognia/redact"
import type { Memory } from "@/types/memory/memory"
import { sha256Hex } from "@/lib/data/crypto"
import { createConflictSet, type GovernanceAssertion } from "@/lib/governance/conflict"
import {
  appendDecisionEvent,
  recordConflictSet,
  recordDecision,
  recordEvidenceRef,
  recordLineageEdge,
  recordProvenanceEnvelope,
  resolveConflictSet,
} from "@/lib/db/governance-ledger"

type MemoryConflictSide = Pick<
  Memory,
  "id" | "text" | "version" | "createdAt" | "updatedAt" | "projectId" | "provenance"
>

export interface MemoryConflictGovernanceInput {
  commandId: string
  keep: MemoryConflictSide
  drop: MemoryConflictSide
  /** Post-resolution row. For merge this is the newly bumped memory version. */
  result?: MemoryConflictSide
  /** Durable manual evidence created by the control plane for a merge. */
  resolutionEvidence?: { id: string; sourceId: string; createdAt: number }
  mode: "keep" | "keep-both" | "merge"
  actorId: string
  rationale?: string
  resolvedAt: number
}

const privacy = {
  classification: "sensitive",
  retentionClass: "memory-history",
  contentCaptured: false,
  redactionVersion: "memory-governance-v1",
  removedFields: ["memory.text", "mergedText"],
}

function authority(memory: MemoryConflictSide): GovernanceAssertion["authorityClass"] {
  if (memory.provenance === "explicit") return "explicit-user"
  if (memory.provenance === "inbound") return "connector-derived"
  if (memory.provenance === "system") return "trusted-system"
  if (memory.provenance === "external") return "external-untrusted"
  return "local-derived"
}

export async function recordMemoryConflictGovernance(
  input: MemoryConflictGovernanceInput
): Promise<string> {
  const safeRationale = input.rationale ? redactText(input.rationale).redacted : undefined
  const ids = [input.keep.id, input.drop.id].sort()
  const conflictId = `memory-conflict:${ids.join(":")}`
  const decisionId = `memory-resolution:${input.commandId}`
  const scope = input.keep.projectId ? { projectId: input.keep.projectId } : {}
  const ref = (type: string, id: string, version?: number) => ({
    namespace: "cognia",
    type,
    id,
    ...(version !== undefined ? { version: String(version) } : {}),
    scope,
  })
  const subjectRef = ref("memory-fact", ids.join(":"))
  const policyDigest = await sha256Hex("memory-conflict-resolution-v1")
  const policyRef = {
    namespace: "memory",
    id: "conflict-resolution",
    version: "1",
    digest: policyDigest,
  }

  const sides = await Promise.all(
    ([input.keep, input.drop] as const).map(async (memory) => {
      const digest = await sha256Hex(memory.text)
      const evidenceId = `memory-evidence:${memory.id}:v${memory.version}`
      await recordEvidenceRef({
        contractVersion: GOVERNANCE_CONTRACT_VERSION,
        id: evidenceId,
        kind: "memory",
        sourceRef: ref("memory", memory.id, memory.version),
        digest: { algorithm: "sha256", value: digest, canonicalization: "redacted-memory-v1" },
        observedAt: memory.updatedAt,
        review: { status: "disputed" },
        contamination:
          memory.provenance === "inbound" || memory.provenance === "external"
            ? "external-context"
            : "clean",
        privacy,
      })
      const assertion: GovernanceAssertion = {
        assertionRef: ref("memory", memory.id, memory.version),
        subjectRef,
        predicate: { namespace: "memory", key: "fact" },
        scope,
        valueDigest: digest,
        evidenceRefs: [evidenceId],
        observedAt: memory.updatedAt,
        authorityClass: authority(memory),
      }
      return { memory, evidenceId, assertion }
    })
  )

  const resolutionEvidenceId = input.resolutionEvidence?.id
  if (input.resolutionEvidence) {
    await recordEvidenceRef({
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      id: input.resolutionEvidence.id,
      kind: "approval",
      sourceRef: ref("memory-evidence", input.resolutionEvidence.id),
      digest: {
        algorithm: "sha256",
        value: await sha256Hex(input.resolutionEvidence.sourceId),
        canonicalization: "memory-resolution-evidence-v1",
      },
      observedAt: input.resolutionEvidence.createdAt,
      review: { status: "verified", reviewerRef: ref("user", input.actorId) },
      contamination: "clean",
      privacy,
    })
  }
  const supportingEvidenceIds = [
    ...sides.map((side) => side.evidenceId),
    ...(resolutionEvidenceId ? [resolutionEvidenceId] : []),
  ]

  await recordConflictSet(
    createConflictSet({
      id: conflictId,
      left: sides[0].assertion,
      right: sides[1].assertion,
      risk: "high",
      createdAt: Math.max(input.keep.updatedAt, input.drop.updatedAt),
      detectorRef: ref("conflict-detector", "memory-v1"),
      policyRef,
    })
  )
  await recordDecision({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: decisionId,
    mode: "control",
    kind: "memory-resolution",
    subjectRef: ref("conflict", conflictId),
    question: {
      code: "resolve-memory-conflict",
      candidateRefs: sides.map((side) => ref("memory", side.memory.id, side.memory.version)),
    },
    proposer: { kind: "system", ref: ref("memory-control-plane", "resolver") },
    decider: { kind: "human", ref: ref("user", input.actorId) },
    executor: { kind: "system", ref: ref("memory-control-plane", "manage") },
    basis: {
      evidenceRefs: supportingEvidenceIds,
      policyRefs: [policyRef],
      parentDecisionRefs: [],
    },
    resolution: {
      outcome: input.mode,
      reasonCode: "human-conflict-resolution",
      ...(safeRationale ? { rationale: safeRationale } : {}),
      rationaleOrigin: "human",
    },
    lifecycle: {
      state: "resolved",
      proposedAt: Math.max(input.keep.updatedAt, input.drop.updatedAt),
      decidedAt: input.resolvedAt,
      recordedAt: input.resolvedAt,
    },
    correlation: { requestId: input.commandId },
    privacy,
  })
  await appendDecisionEvent({
    id: `${decisionId}:resolved`,
    decisionId,
    type: "resolved",
    actor: { kind: "human", ref: ref("user", input.actorId) },
    at: input.resolvedAt,
    reasonCode: "human-conflict-resolution",
    outcome: input.mode,
    correlation: { requestId: input.commandId },
  })
  await resolveConflictSet(conflictId, decisionId, input.resolvedAt)

  for (const side of sides) {
    await recordLineageEdge({
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      id: `${decisionId}:supported-by:${side.evidenceId}`,
      from: ref("evidence", side.evidenceId),
      to: ref("decision", decisionId),
      relation: "supported-by",
      assertion: "explicit",
      evidenceRefs: [side.evidenceId],
      policyRef,
      recordedAt: input.resolvedAt,
    })
  }
  if (resolutionEvidenceId) {
    await recordLineageEdge({
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      id: `${decisionId}:supported-by:${resolutionEvidenceId}`,
      from: ref("evidence", resolutionEvidenceId),
      to: ref("decision", decisionId),
      relation: "supported-by",
      assertion: "explicit",
      evidenceRefs: [resolutionEvidenceId],
      policyRef,
      recordedAt: input.resolvedAt,
    })
  }
  if (input.mode !== "keep-both") {
    const result = input.result ?? input.keep
    await recordLineageEdge({
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      id: `${decisionId}:resulted-in`,
      from: ref("decision", decisionId),
      to: ref("memory", result.id, result.version),
      relation: "resulted-in",
      assertion: "explicit",
      recordedAt: input.resolvedAt,
    })
    await recordLineageEdge({
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      id: `${decisionId}:supersedes`,
      from: ref("memory", result.id, result.version),
      to: ref("memory", input.drop.id, input.drop.version),
      relation: "supersedes",
      assertion: "explicit",
      actorRef: { kind: "human", ref: ref("user", input.actorId) },
      recordedAt: input.resolvedAt,
    })
  }
  await recordProvenanceEnvelope({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    eventId: `${decisionId}:provenance`,
    eventType: "memory.conflict.resolved",
    source: "cognia://memory/control-plane",
    subjectRef: ref("conflict", conflictId),
    occurredAt: input.resolvedAt,
    recordedAt: input.resolvedAt,
    correlation: { requestId: input.commandId },
    actorRefs: [ref("user", input.actorId)],
    decisionRefs: [decisionId],
    evidenceRefs: supportingEvidenceIds,
    inputRefs: sides.map((side) => ref("memory", side.memory.id, side.memory.version)),
    outputRefs:
      input.mode === "keep-both"
        ? sides.map((side) => ref("memory", side.memory.id, side.memory.version))
        : [ref("memory", (input.result ?? input.keep).id, (input.result ?? input.keep).version)],
    policyRefs: [policyRef],
    privacy,
    data: { mode: input.mode },
  })
  return decisionId
}
