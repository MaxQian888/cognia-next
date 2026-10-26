/**
 * The receipt and card shapes the delivery, integration and browser
 * chokepoints share (ADR-0239).
 *
 * Each chokepoint names its own channel, subject and origin; what a receipt is
 * past that is one shape: an outbound `ask` verdict at the outbound tier, the
 * plan the chokepoint reached, and the decision with its authority. A grant is
 * kept only on a decision that permits, so a denial never records one.
 */

import {
  ACTION_REVIEW_CONTRACT_VERSION,
  type ActionReviewActorKind,
  type ActionReviewAuthority,
  type ActionReviewDecision,
  type ActionReviewGrant,
  type ActionReviewOrigin,
  type ActionReviewOutcome,
  type ActionReviewPlanOutcome,
  type ActionReviewRequest,
  type ActionReviewSubject,
} from "@cognia/agent-config-types/action-review"
import type { PendingOutboundReview } from "@cognia/agent-config-types"
import type { OutboundJobAuthorization } from "@cognia/plugin-contract/lib/db/connector-types"

import { classifyRisk } from "@/lib/policy/risk/classify-risk"

import type { AuthorizedOutboundToolCall } from "./authorized-tool-calls"
import type { OutboundTarget } from "./outbound-targets"

/** A chokepoint receipt, for the caller to write. */
export interface OutboundReceipt {
  request: ActionReviewRequest
  decision: ActionReviewDecision
}

export interface OutboundReceiptArgs {
  requestId: string
  /** `id` is the request id. */
  origin: Omit<ActionReviewOrigin, "id">
  subject: ActionReviewSubject
  plan: ActionReviewPlanOutcome
  enforced: boolean
  outcome: ActionReviewOutcome
  authority: ActionReviewAuthority
  grant?: ActionReviewGrant
  actor?: { kind: ActionReviewActorKind }
  reason: string
  now: number
}

/** One chokepoint receipt. */
export function outboundReceipt(args: OutboundReceiptArgs): OutboundReceipt {
  const risk = classifyRisk({
    objective: "",
    taskDescriptions: [],
    toolIds: ["connector_send"],
    capabilityIds: [],
    sandboxEnabled: false,
  })
  const permits = args.outcome === "allow" || args.outcome === "allow_always"
  const { origin } = args
  return {
    request: {
      contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
      requestId: args.requestId,
      origin: {
        channel: origin.channel,
        scope: origin.scope,
        id: args.requestId,
        ...(origin.sessionId ? { sessionId: origin.sessionId } : {}),
        ...(origin.headless ? { headless: true } : {}),
        ...(origin.rootSessionId ? { rootSessionId: origin.rootSessionId } : {}),
        ...(origin.instructionEpoch ? { instructionEpoch: origin.instructionEpoch } : {}),
      },
      subject: args.subject,
      verdict: "ask",
      verdictExplicit: false,
      tier: risk.tier,
      surfaces: risk.surfaces,
      plan: { outcome: args.plan, enforced: args.enforced },
      requestedAt: args.now,
    },
    decision: {
      contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
      requestId: args.requestId,
      outcome: args.outcome,
      authority: args.authority,
      reason: args.reason,
      ...(args.grant && permits ? { grant: args.grant } : {}),
      ...(args.actor ? { actor: args.actor } : {}),
      decidedAt: args.now,
    },
  }
}

/** The recipients an approval card shows, with the PR or issue a GitHub write goes to. */
export function outboundReview(
  targets: readonly OutboundTarget[],
  unauthorized: readonly OutboundTarget[],
  enforced: boolean
): PendingOutboundReview {
  const view = (target: OutboundTarget) => ({
    kind: target.kind,
    channel: target.channel,
    recipient: target.recipient,
    ...(target.thread ? { thread: target.thread } : {}),
  })
  return { targets: targets.map(view), unauthorized: unauthorized.map(view), enforced }
}

/** What an authorized tool call lends the job or write it causes. */
export function jobAuthorizationOf(call: AuthorizedOutboundToolCall): OutboundJobAuthorization {
  return {
    receiptId: call.requestId,
    authority: call.authority,
    ...(call.grant ? { grantScope: call.grant.scope } : {}),
    ...(call.grant?.policyRef ? { policyRef: call.grant.policyRef } : {}),
  }
}
