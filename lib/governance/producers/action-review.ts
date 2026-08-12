import {
  GOVERNANCE_CONTRACT_VERSION,
  type ActorRefV1,
  type DecisionKindV1,
  type ResourceRefV1,
} from "@cognia/agent-config-types/governance"
import type {
  ActionReviewEffect,
  ActionReviewReceipt,
} from "@cognia/agent-config-types/action-review"
import { redactText } from "@cognia/redact"
import { sha256Hex } from "@/lib/data/crypto"
import {
  appendDecisionEvent,
  recordDecision,
  recordEvidenceRef,
  recordLineageEdge,
  recordProvenanceEnvelope,
} from "@/lib/db/governance-ledger"

const DECISION_PREFIX = "action-review:"

function ref(type: string, id: string, projectId?: string): ResourceRefV1 {
  return {
    namespace: "cognia",
    type,
    id,
    ...(projectId ? { scope: { projectId } } : {}),
  }
}

function kindFor(receipt: ActionReviewReceipt): DecisionKindV1 {
  return receipt.request.origin.channel === "chat-tool" ||
    receipt.request.origin.channel === "connector-tool"
    ? "tool-authorization"
    : "human-approval"
}

function deciderFor(receipt: ActionReviewReceipt): ActorRefV1 {
  const actor = receipt.decision.actor
  if (actor) {
    return {
      kind:
        actor.kind === "local-user"
          ? "human"
          : actor.kind === "connector-user"
            ? "connector"
            : "device",
      ref: ref(actor.kind, actor.id ?? actor.label ?? "local"),
    }
  }
  return {
    kind: receipt.decision.authority === "human" ? "human" : "system",
    ref: ref("authority", receipt.decision.authority),
  }
}

function privacy() {
  return {
    classification: "private",
    retentionClass: "audit-90d",
    contentCaptured: false,
    redactionVersion: "action-review-v1",
    removedFields: ["request.subject.input", "request.subject.command"],
  }
}

/** Project a specialized ActionReviewReceipt into the shared governance ledger. */
export async function recordActionReviewGovernance(receipt: ActionReviewReceipt): Promise<void> {
  const safeReason = receipt.decision.reason
    ? redactText(receipt.decision.reason).redacted
    : undefined
  const decisionId = `${DECISION_PREFIX}${receipt.id}`
  const evidenceId = `${decisionId}:policy-evaluation`
  // Legacy/test fixtures may predate the Unix epoch; the governance wire
  // contract intentionally uses non-negative epoch milliseconds.
  const requestedAt = Math.max(0, receipt.request.requestedAt)
  const digestInput = JSON.stringify({
    requestId: receipt.request.requestId,
    verdict: receipt.request.verdict,
    verdictExplicit: receipt.request.verdictExplicit,
    tier: receipt.request.tier,
    surfaces: receipt.request.surfaces,
    recommendation: receipt.request.recommendation
      ? {
          suggests: receipt.request.recommendation.suggests,
          confidence: receipt.request.recommendation.confidence,
          source: receipt.request.recommendation.source,
        }
      : undefined,
  })
  const digest = await sha256Hex(digestInput)
  const subjectRef = ref(
    receipt.request.subject.kind,
    receipt.request.requestId,
    receipt.request.origin.projectId
  )
  const decisionRef = ref("decision", decisionId, receipt.request.origin.projectId)
  const evidenceRef = ref("evidence", evidenceId, receipt.request.origin.projectId)
  const policyRef = {
    namespace: "action-review",
    id: "resolved-policy",
    version: "1",
    digest,
    effectiveAt: requestedAt,
  }

  await recordEvidenceRef({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: evidenceId,
    kind: "policy-evaluation",
    sourceRef: ref("action-review-request", receipt.id, receipt.request.origin.projectId),
    digest: { algorithm: "sha256", value: digest, canonicalization: "action-review-v1" },
    observedAt: requestedAt,
    review: {
      status: receipt.decision.authority === "human" ? "verified" : "unreviewed",
      ...(receipt.decision.authority === "human" ? { reviewedBy: deciderFor(receipt).ref } : {}),
    },
    contamination: "clean",
    privacy: privacy(),
  })

  await recordDecision({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: decisionId,
    mode: "control",
    kind: kindFor(receipt),
    subjectRef,
    question: { code: "may-execute" },
    proposer: {
      kind: "system",
      ref: ref("action-review-producer", receipt.request.origin.channel),
    },
    decider: deciderFor(receipt),
    basis: {
      evidenceRefs: [evidenceId],
      policyRefs: [policyRef],
      parentDecisionRefs: [],
    },
    resolution: {
      outcome: receipt.decision.outcome,
      reasonCode: receipt.decision.authority,
      ...(safeReason ? { rationale: safeReason } : {}),
      rationaleOrigin: receipt.decision.authority === "human" ? "human" : "rule",
    },
    lifecycle: {
      state: "resolved",
      proposedAt: requestedAt,
      decidedAt: receipt.decision.decidedAt,
      recordedAt: receipt.decision.decidedAt,
      expiresAt: receipt.expiresAt,
    },
    correlation: {
      sessionId: receipt.request.origin.sessionId,
      requestId: receipt.id,
      runId: receipt.request.origin.runId,
      workflowId: receipt.request.origin.workflowId,
    },
    privacy: privacy(),
  })
  await appendDecisionEvent({
    id: `${decisionId}:resolved`,
    decisionId,
    type: "resolved",
    actor: deciderFor(receipt),
    at: receipt.decision.decidedAt,
    reasonCode: receipt.decision.authority,
    outcome: receipt.decision.outcome,
    correlation: {
      sessionId: receipt.request.origin.sessionId,
      requestId: receipt.id,
      runId: receipt.request.origin.runId,
      workflowId: receipt.request.origin.workflowId,
    },
  })
  await recordLineageEdge({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: `${decisionId}:supported-by:${evidenceId}`,
    from: evidenceRef,
    to: decisionRef,
    relation: "supported-by",
    assertion: "explicit",
    evidenceRefs: [evidenceId],
    policyRef,
    recordedAt: receipt.decision.decidedAt,
  })
  await recordProvenanceEnvelope({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    eventId: `${decisionId}:provenance`,
    eventType: "action-review.resolved",
    source: `cognia://action-review/${receipt.request.origin.channel}`,
    subjectRef,
    occurredAt: receipt.decision.decidedAt,
    recordedAt: receipt.decision.decidedAt,
    correlation: {
      sessionId: receipt.request.origin.sessionId,
      requestId: receipt.id,
      runId: receipt.request.origin.runId,
      workflowId: receipt.request.origin.workflowId,
    },
    actorRefs: [deciderFor(receipt).ref],
    decisionRefs: [decisionId],
    evidenceRefs: [evidenceId],
    inputRefs: [evidenceRef],
    outputRefs: [],
    policyRefs: [policyRef],
    privacy: privacy(),
    data: {
      outcome: receipt.decision.outcome,
      authority: receipt.decision.authority,
      tier: receipt.request.tier,
    },
  })
}

export async function recordActionReviewEffectGovernance(
  requestId: string,
  effect: ActionReviewEffect
): Promise<void> {
  const decisionId = `${DECISION_PREFIX}${requestId}`
  const at = effect.completedAt ?? Date.now()
  const effectRef = ref("action-review-effect", requestId)
  await appendDecisionEvent({
    id: `${decisionId}:effect`,
    decisionId,
    type: effect.status === "executed" ? "executed" : "failed",
    at,
    reasonCode: effect.status,
    effectRef,
  })
  await recordLineageEdge({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: `${decisionId}:resulted-in`,
    from: ref("decision", decisionId),
    to: effectRef,
    relation: "resulted-in",
    assertion: "explicit",
    recordedAt: at,
  })
}
