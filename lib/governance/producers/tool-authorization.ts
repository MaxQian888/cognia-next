import { GOVERNANCE_CONTRACT_VERSION } from "@cognia/agent-config-types/governance"
import { sha256Hex } from "@/lib/data/crypto"
import {
  appendDecisionEvent,
  recordDecision,
  recordEvidenceRef,
  recordProvenanceEnvelope,
} from "@/lib/db/governance-ledger"

export interface ToolAuthorizationGovernanceInput {
  sessionId: string
  requestId: string
  outcome: "allow" | "deny"
  decidedAt: number
  dispatched: boolean
  hasUpdatedInput: boolean
}

const privacy = {
  classification: "sensitive",
  retentionClass: "action-review",
  contentCaptured: false,
  redactionVersion: "tool-authorization-v1",
  removedFields: ["message", "updatedInput", "toolInput", "toolOutput"],
}

const ref = (type: string, id: string) => ({ namespace: "cognia", type, id })

/** Persist every renderer-to-sidecar tool authorization without tool arguments. */
export async function recordToolAuthorizationGovernance(
  input: ToolAuthorizationGovernanceInput
): Promise<string> {
  const decisionId = `tool-authorization:${input.sessionId}:${input.requestId}`
  const evidenceId = `${decisionId}:evidence`
  const policyDigest = await sha256Hex("tool-authorization-renderer-gate-v1")
  const evidenceDigest = await sha256Hex(
    `${input.sessionId}:${input.requestId}:${input.outcome}:${input.hasUpdatedInput}`
  )
  const policyRef = {
    namespace: "tool-authorization",
    id: "renderer-gate",
    version: "1",
    digest: policyDigest,
  }
  await recordEvidenceRef({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: evidenceId,
    kind: "approval",
    sourceRef: ref("tool-permission-request", input.requestId),
    digest: {
      algorithm: "sha256",
      value: evidenceDigest,
      canonicalization: "tool-authorization-metadata-v1",
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
    kind: "tool-authorization",
    subjectRef: ref("tool-permission-request", input.requestId),
    question: { code: "authorize-tool-execution" },
    proposer: { kind: "agent", ref: ref("claude-session", input.sessionId) },
    decider: { kind: "human", ref: ref("local-user", "current") },
    executor: { kind: "system", ref: ref("claude-sidecar", "local") },
    basis: { evidenceRefs: [evidenceId], policyRefs: [policyRef], parentDecisionRefs: [] },
    resolution: {
      outcome: input.outcome,
      reasonCode: "permission-response",
      rationaleOrigin: "human",
    },
    lifecycle: {
      state: input.dispatched ? "executed" : "failed",
      decidedAt: input.decidedAt,
      ...(input.dispatched ? { executedAt: input.decidedAt } : {}),
      recordedAt: input.decidedAt,
    },
    correlation: { sessionId: input.sessionId, requestId: input.requestId },
    privacy,
  })
  await appendDecisionEvent({
    id: `${decisionId}:${input.dispatched ? "executed" : "failed"}`,
    decisionId,
    type: input.dispatched ? "executed" : "failed",
    at: input.decidedAt,
    outcome: input.outcome,
    reasonCode: input.dispatched ? "permission-response" : "dispatch-failed",
    correlation: { sessionId: input.sessionId, requestId: input.requestId },
  })
  await recordProvenanceEnvelope({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    eventId: `${decisionId}:provenance:${input.dispatched ? "executed" : "failed"}`,
    eventType: input.dispatched ? "tool.authorization.dispatched" : "tool.authorization.failed",
    source: "cognia://claude/ipc",
    subjectRef: ref("tool-permission-request", input.requestId),
    occurredAt: input.decidedAt,
    recordedAt: input.decidedAt,
    correlation: { sessionId: input.sessionId, requestId: input.requestId },
    actorRefs: [ref("local-user", "current"), ref("claude-sidecar", "local")],
    decisionRefs: [decisionId],
    evidenceRefs: [evidenceId],
    inputRefs: [ref("tool-permission-request", input.requestId)],
    outputRefs: [],
    policyRefs: [policyRef],
    privacy,
    data: {
      outcome: input.outcome,
      dispatched: input.dispatched,
      inputModified: input.hasUpdatedInput,
    },
  })
  return decisionId
}
