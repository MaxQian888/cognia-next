import { GOVERNANCE_CONTRACT_VERSION } from "@cognia/agent-config-types/governance"
import { sha256Hex } from "@/lib/data/crypto"
import {
  appendDecisionEvent,
  recordDecision,
  recordEvidenceRef,
  recordProvenanceEnvelope,
} from "@/lib/db/governance-ledger"

/**
 * Governance records for Harness Evolution adoptions (ADR-0237).
 *
 * An adoption replaces an agent's instructions, skills and tool rules with an
 * evolved version, so it is recorded like any other controlled change: the
 * evidence (the run's selection and the two harness hashes, never their
 * text), the decision (who let it in: a person or the low-risk auto-adopt
 * rule), and the effect. A rollback revokes the decision.
 */

export interface HarnessAdoptionGovernanceInput {
  runId: string
  characterId: string
  /** The agent row the harness was written to. */
  targetCharacterId: string
  scope: string
  baseContentHash: string
  chosenContentHash: string
  chosenSnapshotId: string
  risk: string
  approvedBy: "person" | "auto-low-risk"
  /** The selection's reason, as shown to the person. */
  reason: string
  applyId?: string
  decidedAt: number
}

const privacy = {
  classification: "internal",
  retentionClass: "action-review",
  contentCaptured: false,
  redactionVersion: "harness-adoption-v1",
  removedFields: ["systemPrompt", "skills", "guardrails", "memory", "toolGuidance", "evidence"],
}

const ref = (type: string, id: string) => ({ namespace: "cognia", type, id })

export function harnessAdoptionDecisionId(runId: string): string {
  return `harness-adoption:${runId}`
}

/** Record an adoption: evidence, the decision and its effect. Returns the decision id. */
export async function recordHarnessAdoptionGovernance(
  input: HarnessAdoptionGovernanceInput
): Promise<string> {
  const decisionId = harnessAdoptionDecisionId(input.runId)
  const evidenceId = `${decisionId}:evidence`
  const policyRef = {
    namespace: "harness-evolution",
    id: input.approvedBy === "person" ? "approval" : "auto-adopt-low-risk",
    version: "1",
    digest: await sha256Hex(`harness-adoption-policy-v1:${input.approvedBy}:${input.scope}`),
  }
  await recordEvidenceRef({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: evidenceId,
    kind: "policy-evaluation",
    sourceRef: ref("harness-evolution-run", input.runId),
    digest: {
      algorithm: "sha256",
      value: await sha256Hex(
        `${input.runId}:${input.baseContentHash}:${input.chosenContentHash}:${input.risk}`
      ),
      canonicalization: "harness-adoption-metadata-v1",
    },
    observedAt: input.decidedAt,
    review: { status: input.approvedBy === "person" ? "verified" : "unreviewed" },
    contamination: "unknown",
    privacy,
  })
  const human = input.approvedBy === "person"
  await recordDecision({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: decisionId,
    mode: "control",
    kind: "harness-adoption",
    subjectRef: ref("agent", input.targetCharacterId),
    question: {
      code: "adopt-evolved-harness",
      candidateRefs: [ref("harness-snapshot", input.chosenSnapshotId)],
    },
    proposer: { kind: "system", ref: ref("harness-evolution-run", input.runId) },
    decider: human
      ? { kind: "human", ref: ref("local-user", "current") }
      : { kind: "system", ref: ref("harness-evolution-policy", "auto-adopt-low-risk") },
    executor: { kind: "system", ref: ref("harness-evolution", "adoption") },
    basis: { evidenceRefs: [evidenceId], policyRefs: [policyRef], parentDecisionRefs: [] },
    resolution: {
      outcome: "adopted",
      selectedRefs: [ref("harness-snapshot", input.chosenSnapshotId)],
      reasonCode: human ? "approved" : "auto-adopt-low-risk",
      rationale: input.reason.slice(0, 500),
      rationaleOrigin: human ? "human" : "rule",
    },
    lifecycle: {
      state: "executed",
      decidedAt: input.decidedAt,
      effectiveAt: input.decidedAt,
      executedAt: input.decidedAt,
      recordedAt: input.decidedAt,
    },
    correlation: { runId: input.runId },
    privacy,
  })
  await appendDecisionEvent({
    id: `${decisionId}:executed`,
    decisionId,
    type: "executed",
    at: input.decidedAt,
    outcome: "adopted",
    reasonCode: human ? "approved" : "auto-adopt-low-risk",
    effectRef: ref("agent", input.targetCharacterId),
    correlation: { runId: input.runId },
  })
  await recordProvenanceEnvelope({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    eventId: `${decisionId}:provenance:adopted`,
    eventType: "harness.adoption.executed",
    source: "cognia://harness-evolution",
    subjectRef: ref("agent", input.targetCharacterId),
    occurredAt: input.decidedAt,
    recordedAt: input.decidedAt,
    correlation: { runId: input.runId },
    actorRefs: [human ? ref("local-user", "current") : ref("harness-evolution-policy", "auto")],
    decisionRefs: [decisionId],
    evidenceRefs: [evidenceId],
    inputRefs: [ref("harness-evolution-run", input.runId)],
    outputRefs: [
      ref("harness-snapshot", input.chosenSnapshotId),
      ...(input.applyId ? [ref("configuration-apply", input.applyId)] : []),
    ],
    policyRefs: [policyRef],
    privacy,
    data: {
      scope: input.scope,
      risk: input.risk,
      approvedBy: input.approvedBy,
      sourceAgent: input.characterId,
    },
  })
  return decisionId
}

/** Record that an adoption was rolled back: the decision is revoked. */
export async function recordHarnessRollbackGovernance(input: {
  runId: string
  targetCharacterId: string
  at: number
}): Promise<void> {
  const decisionId = harnessAdoptionDecisionId(input.runId)
  await appendDecisionEvent({
    id: `${decisionId}:revoked`,
    decisionId,
    type: "revoked",
    at: input.at,
    actor: { kind: "human", ref: ref("local-user", "current") },
    outcome: "rolled-back",
    reasonCode: "rollback",
    effectRef: ref("agent", input.targetCharacterId),
    correlation: { runId: input.runId },
  })
}

export interface HarnessRestoreGovernanceInput {
  /** The new `restored` snapshot. */
  restoredSnapshotId: string
  /** The version a person chose to bring back. */
  sourceSnapshotId: string
  characterId: string
  currentContentHash: string
  restoredContentHash: string
  risk: string
  applyId?: string
  decidedAt: number
}

export function harnessRestoreDecisionId(restoredSnapshotId: string): string {
  return `harness-restore:${restoredSnapshotId}`
}

/**
 * Record that a person brought an earlier harness version back. Like an
 * adoption it is a controlled change of the agent, decided by a person, with
 * the two hashes as evidence and never the harness text.
 */
export async function recordHarnessRestoreGovernance(
  input: HarnessRestoreGovernanceInput
): Promise<string> {
  const decisionId = harnessRestoreDecisionId(input.restoredSnapshotId)
  const evidenceId = `${decisionId}:evidence`
  const policyRef = {
    namespace: "harness-evolution",
    id: "restore",
    version: "1",
    digest: await sha256Hex("harness-restore-policy-v1:person"),
  }
  await recordEvidenceRef({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: evidenceId,
    kind: "policy-evaluation",
    sourceRef: ref("harness-snapshot", input.sourceSnapshotId),
    digest: {
      algorithm: "sha256",
      value: await sha256Hex(
        `${input.sourceSnapshotId}:${input.currentContentHash}:${input.restoredContentHash}:${input.risk}`
      ),
      canonicalization: "harness-restore-metadata-v1",
    },
    observedAt: input.decidedAt,
    review: { status: "verified" },
    contamination: "unknown",
    privacy,
  })
  await recordDecision({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: decisionId,
    mode: "control",
    kind: "harness-adoption",
    subjectRef: ref("agent", input.characterId),
    question: {
      code: "restore-harness-version",
      candidateRefs: [ref("harness-snapshot", input.sourceSnapshotId)],
    },
    proposer: { kind: "human", ref: ref("local-user", "current") },
    decider: { kind: "human", ref: ref("local-user", "current") },
    executor: { kind: "system", ref: ref("harness-evolution", "restore") },
    basis: { evidenceRefs: [evidenceId], policyRefs: [policyRef], parentDecisionRefs: [] },
    resolution: {
      outcome: "adopted",
      selectedRefs: [ref("harness-snapshot", input.restoredSnapshotId)],
      reasonCode: "restored",
      rationale: `Restored harness version ${input.sourceSnapshotId}.`,
      rationaleOrigin: "human",
    },
    lifecycle: {
      state: "executed",
      decidedAt: input.decidedAt,
      effectiveAt: input.decidedAt,
      executedAt: input.decidedAt,
      recordedAt: input.decidedAt,
    },
    correlation: {},
    privacy,
  })
  await appendDecisionEvent({
    id: `${decisionId}:executed`,
    decisionId,
    type: "executed",
    at: input.decidedAt,
    outcome: "adopted",
    reasonCode: "restored",
    effectRef: ref("agent", input.characterId),
    correlation: {},
  })
  await recordProvenanceEnvelope({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    eventId: `${decisionId}:provenance:restored`,
    eventType: "harness.restore.executed",
    source: "cognia://harness-evolution",
    subjectRef: ref("agent", input.characterId),
    occurredAt: input.decidedAt,
    recordedAt: input.decidedAt,
    correlation: {},
    actorRefs: [ref("local-user", "current")],
    decisionRefs: [decisionId],
    evidenceRefs: [evidenceId],
    inputRefs: [ref("harness-snapshot", input.sourceSnapshotId)],
    outputRefs: [
      ref("harness-snapshot", input.restoredSnapshotId),
      ...(input.applyId ? [ref("configuration-apply", input.applyId)] : []),
    ],
    policyRefs: [policyRef],
    privacy,
    data: { risk: input.risk },
  })
  return decisionId
}
