import { GOVERNANCE_CONTRACT_VERSION } from "@cognia/agent-config-types/governance"
import { sha256Hex } from "@/lib/data/crypto"
import type { PolicyEvalResult } from "@/lib/connectors/policy-eval"
import type { RouteDecision } from "@/lib/connectors/mode-router"
import type { ConnectorMode } from "@/types/connectors/policy"
import {
  appendDecisionEvent,
  recordDecision,
  recordEvidenceRef,
  recordLineageEdge,
  recordProvenanceEnvelope,
} from "@/lib/db/governance-ledger"

export interface ConnectorRouteGovernanceInput {
  adapterId: string
  messageId: string
  conversationKey: string
  mode: ConnectorMode
  evaluation: PolicyEvalResult
  route: RouteDecision
  decidedAt: number
}

const privacy = {
  classification: "sensitive",
  retentionClass: "connector-audit",
  contentCaptured: false,
  redactionVersion: "connector-route-v1",
  removedFields: ["event.segments", "event.plainText", "event.sender", "event.channelData"],
}

const ref = (type: string, id: string) => ({ namespace: "cognia", type, id })

/** Record connector policy evaluation and routing without copying the inbound payload. */
export async function recordConnectorRouteGovernance(
  input: ConnectorRouteGovernanceInput
): Promise<string> {
  const decisionId = `connector-route:${input.adapterId}:${input.messageId}`
  const evidenceId = `${decisionId}:policy-evidence`
  const conversationDigest = await sha256Hex(input.conversationKey)
  const evaluationDigest = await sha256Hex(
    JSON.stringify({
      mode: input.mode,
      matched: input.evaluation.matched,
      blocked: input.evaluation.blocked,
      reason: input.evaluation.reason ?? null,
      route: input.route,
    })
  )
  const policyRef = {
    namespace: "connector",
    id: "inbound-routing",
    version: "1",
    digest: await sha256Hex("connector-inbound-routing-v1"),
  }
  await recordEvidenceRef({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: evidenceId,
    kind: "policy-evaluation",
    sourceRef: ref("connector-inbound", `${input.adapterId}:${input.messageId}`),
    digest: {
      algorithm: "sha256",
      value: evaluationDigest,
      canonicalization: "connector-policy-evaluation-v1",
    },
    observedAt: input.decidedAt,
    review: { status: "unreviewed" },
    contamination: "external-context",
    privacy,
  })
  await recordDecision({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: decisionId,
    mode: "control",
    kind: "connector-route",
    subjectRef: ref("connector-inbound", `${input.adapterId}:${input.messageId}`),
    question: { code: "select-inbound-route" },
    proposer: { kind: "connector", ref: ref("adapter", input.adapterId) },
    decider: { kind: "system", ref: ref("connector-router", "v1") },
    executor: { kind: "system", ref: ref("connector-bus", "v1") },
    basis: { evidenceRefs: [evidenceId], policyRefs: [policyRef], parentDecisionRefs: [] },
    resolution: {
      outcome: input.route,
      reasonCode:
        input.evaluation.reason ??
        (input.evaluation.matched ? "policy-matched" : "policy-unmatched"),
      rationaleOrigin: "rule",
    },
    lifecycle: {
      state: "executed",
      decidedAt: input.decidedAt,
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
    outcome: input.route,
    reasonCode: input.evaluation.reason ?? "routing-complete",
  })
  await recordLineageEdge({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: `${decisionId}:supported-by:${evidenceId}`,
    from: ref("evidence", evidenceId),
    to: ref("decision", decisionId),
    relation: "supported-by",
    assertion: "derived",
    evidenceRefs: [evidenceId],
    policyRef,
    recordedAt: input.decidedAt,
  })
  await recordProvenanceEnvelope({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    eventId: `${decisionId}:provenance`,
    eventType: "connector.inbound.routed",
    source: "cognia://connector/bus",
    subjectRef: ref("connector-inbound", `${input.adapterId}:${input.messageId}`),
    occurredAt: input.decidedAt,
    recordedAt: input.decidedAt,
    correlation: {},
    actorRefs: [ref("adapter", input.adapterId), ref("connector-router", "v1")],
    activityRef: ref("connector-conversation", conversationDigest),
    decisionRefs: [decisionId],
    evidenceRefs: [evidenceId],
    inputRefs: [ref("connector-inbound", `${input.adapterId}:${input.messageId}`)],
    outputRefs: [ref("connector-route", input.route)],
    policyRefs: [policyRef],
    privacy,
    data: {
      mode: input.mode,
      route: input.route,
      matched: input.evaluation.matched,
      blocked: input.evaluation.blocked,
    },
  })
  return decisionId
}
