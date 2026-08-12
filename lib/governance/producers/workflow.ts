import { GOVERNANCE_CONTRACT_VERSION } from "@cognia/agent-config-types/governance"
import { sha256Hex } from "@/lib/data/crypto"
import { redactText } from "@cognia/redact"
import {
  appendDecisionEvent,
  recordDecision,
  recordEvidenceRef,
  recordLineageEdge,
  recordProvenanceEnvelope,
} from "@/lib/db/governance-ledger"

export interface WorkflowBranchGovernanceInput {
  workflowId: string
  workflowVersionId?: string
  runId: string
  stepId: string
  traceId?: string
  attempt: number
  chosenRouteKeys: string[]
  availableRouteKeys: string[]
  /** Frozen node policy/config. Only its digest is persisted. */
  policySnapshot: unknown
  /** Runtime evaluation inputs/output. Only its digest is persisted. */
  evaluationSnapshot: unknown
  reasonCode: string
  rationale: string
  decidedAt: number
  projectId?: string
}

const privacy = {
  classification: "private",
  retentionClass: "workflow-history",
  contentCaptured: false,
  redactionVersion: "workflow-governance-v1",
  removedFields: ["step.output", "step.input"],
}

export async function recordWorkflowBranchGovernance(
  input: WorkflowBranchGovernanceInput
): Promise<string> {
  const decisionId = `workflow-branch:${input.runId}:${input.stepId}:${input.attempt}`
  const evidenceId = `${decisionId}:evaluation`
  const scope = input.projectId ? { projectId: input.projectId } : undefined
  const ref = (type: string, id: string) => ({
    namespace: "cognia",
    type,
    id,
    ...(scope ? { scope } : {}),
  })
  const policyDigest = await sha256Hex(JSON.stringify(input.policySnapshot))
  const evidenceDigest = await sha256Hex(JSON.stringify(input.evaluationSnapshot))
  const rationale = redactText(input.rationale).redacted
  const policyRef = {
    namespace: "workflow",
    id: input.workflowId,
    ...(input.workflowVersionId ? { version: input.workflowVersionId } : {}),
    digest: policyDigest,
  }
  await recordEvidenceRef({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: evidenceId,
    kind: "policy-evaluation",
    sourceRef: ref("workflow-step-execution", `${input.runId}:${input.stepId}`),
    digest: {
      algorithm: "sha256",
      value: evidenceDigest,
      canonicalization: "workflow-policy-evaluation-v1",
    },
    observedAt: input.decidedAt,
    review: { status: "unreviewed" },
    contamination: "clean",
    privacy,
  })
  await recordDecision({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: decisionId,
    mode: "control",
    kind: "workflow-branch",
    subjectRef: ref("workflow-step", `${input.runId}:${input.stepId}`),
    question: {
      code: "select-route",
      candidateRefs: input.availableRouteKeys.map((key) => ref("workflow-route", key)),
    },
    proposer: { kind: "system", ref: ref("workflow-runtime", input.workflowId) },
    decider: { kind: "system", ref: ref("workflow-node", input.stepId) },
    executor: { kind: "system", ref: ref("workflow-runtime", input.runId) },
    basis: { evidenceRefs: [evidenceId], policyRefs: [policyRef], parentDecisionRefs: [] },
    resolution: {
      outcome: input.chosenRouteKeys.join(","),
      selectedRefs: input.chosenRouteKeys.map((key) => ref("workflow-route", key)),
      reasonCode: input.reasonCode,
      rationale,
      rationaleOrigin: "system",
    },
    lifecycle: {
      state: "executed",
      proposedAt: input.decidedAt,
      decidedAt: input.decidedAt,
      executedAt: input.decidedAt,
      recordedAt: input.decidedAt,
    },
    correlation: {
      traceId: input.traceId,
      runId: input.runId,
      workflowId: input.workflowId,
      stepId: input.stepId,
      attemptId: String(input.attempt),
    },
    privacy,
  })
  await appendDecisionEvent({
    id: `${decisionId}:resolved`,
    decisionId,
    type: "resolved",
    at: input.decidedAt,
    reasonCode: input.reasonCode,
    outcome: input.chosenRouteKeys.join(","),
    correlation: { traceId: input.traceId, runId: input.runId, stepId: input.stepId },
  })
  await appendDecisionEvent({
    id: `${decisionId}:executed`,
    decisionId,
    type: "executed",
    at: input.decidedAt,
    correlation: { traceId: input.traceId, runId: input.runId, stepId: input.stepId },
  })
  await recordLineageEdge({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: `${decisionId}:supported-by`,
    from: ref("evidence", evidenceId),
    to: ref("decision", decisionId),
    relation: "supported-by",
    assertion: "explicit",
    evidenceRefs: [evidenceId],
    policyRef,
    recordedAt: input.decidedAt,
  })
  await recordProvenanceEnvelope({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    eventId: `${decisionId}:provenance`,
    eventType: "workflow.branch.executed",
    source: "cognia://workflow/runtime",
    subjectRef: ref("workflow-step", `${input.runId}:${input.stepId}`),
    occurredAt: input.decidedAt,
    recordedAt: input.decidedAt,
    correlation: {
      traceId: input.traceId,
      runId: input.runId,
      workflowId: input.workflowId,
      stepId: input.stepId,
    },
    actorRefs: [ref("workflow-node", input.stepId)],
    decisionRefs: [decisionId],
    evidenceRefs: [evidenceId],
    inputRefs: [ref("evidence", evidenceId)],
    outputRefs: input.chosenRouteKeys.map((key) => ref("workflow-route", key)),
    policyRefs: [policyRef],
    privacy,
    data: {
      chosenCount: input.chosenRouteKeys.length,
      availableCount: input.availableRouteKeys.length,
      reasonCode: input.reasonCode,
    },
  })
  return decisionId
}
