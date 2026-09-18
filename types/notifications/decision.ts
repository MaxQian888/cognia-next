// Notification V2 decision contract — the pure planner's output.
//
// Every fact the planner touches ends in exactly one of the closed decision
// kinds below, each carrying a structured `reasonCode`. "No explicit policy"
// is never silence — it resolves to `not-subscribed` so the audit trail can
// distinguish "nothing was configured" from "something denied it".

import type { NotificationLevel, NotificationReadState } from "./index"

/** Closed decision kinds — exhaustive; never serialized as a free string. */
export type NotificationDecisionKind =
  | "notified"
  | "not-subscribed"
  | "denied-by-target"
  | "denied-by-policy"
  | "expired"
  | "deferred"
  | "digest"
  | "suppressed"
  | "duplicate"
  | "pending-approval"

/** Closed reason codes — the audit key, never a free-text message. */
export type NotificationDecisionReasonCode =
  // not-subscribed
  | "route-missing"
  | "route-disabled"
  | "category-not-served"
  | "purpose-not-served"
  | "below-min-level"
  | "principal-mismatch"
  // denied-by-target
  | "target-disabled"
  | "target-deleted"
  | "consent-not-granted"
  | "consent-mode-origin-only"
  | "disclosure-exceeds-target"
  | "target-capability-missing"
  // denied-by-policy
  | "policy-rule-deny"
  | "policy-rule-not-allowed"
  | "quota-exceeded"
  | "authz-failed"
  | "content-redacted-empty"
  // expired
  | "expires-at-past"
  | "superseded-by-newer"
  | "run-already-terminal"
  // deferred
  | "quiet-hours"
  | "explicit-defer-rule"
  | "awaiting-coalesce-window"
  // digest
  | "aggregated-into-bucket"
  // suppressed
  | "inhibited-by-incident"
  | "root-cause-collapse"
  | "materially-unchanged"
  | "acknowledged"
  // duplicate
  | "same-operation-key"
  | "same-content-accepted"
  | "same-material-hash"
  // pending-approval
  | "awaiting-human-approval"
  // notified / shared
  | "routed"
  | "explicit-override"
  | "unreachable" // internal: should never appear in a committed decision

/** Coarse fact classification — subscriptions and rules match on it. */
export type NotificationCategory =
  | "run.progress"
  | "run.terminal"
  | "run.result"
  | "run.waiting"
  | "run.interrupt"
  | "approval.request"
  | "approval.resolved"
  | "incident"
  | "digest"
  | "scheduler"
  | "session"
  | "system"
  | "manual"

/** What one delivery operation is FOR — part of the delivery-slot key. */
export type NotificationPurpose =
  | "live-progress"
  | "terminal-state"
  | "result-summary"
  | "approval-request"
  | "reminder"
  | "digest"
  | "incident-alert"
  | "terminal-ping"
  | "manual"

/** One authorized route's verdict for a fact. */
export interface NotificationRouteDecision {
  subscriptionId: string
  targetId: string
  kind: NotificationDecisionKind
  reasonCode: NotificationDecisionReasonCode
  /** For `deferred`: the epoch ms the route becomes deliverable again. */
  deferredUntil?: number
  /** For `digest`: the bucket the fact was folded into. */
  aggregateKey?: string
  /** For `pending-approval`: the approval request gating this route. */
  approvalId?: string
  /** The disclosure level the route resolved for this fact. */
  disclosureLevel?: string
  /**
   * The narrowed (route ∩ target) disclosure profile this route resolves to.
   * Rendering must clip at this profile — never the wider target profile.
   */
  effectiveProfileId?: string
}

/** The planner's whole verdict for one fact revision. */
export interface NotificationDecision {
  /** Stable identity of the evaluated fact (`logicalKey` when present). */
  factKey: string
  /** The fact's category at evaluation time. */
  category: NotificationCategory
  /** Monotonic per-fact decision revision — each replan bumps it. */
  revision: number
  /** One verdict per evaluated (subscription, target) pair. */
  routes: NotificationRouteDecision[]
  /** Overall outcome — the "best" route kind by severity order. */
  outcome: NotificationDecisionKind
  /** Structured evidence for the audit trail (policy version, inputs hash). */
  evidence: {
    policyVersion: number
    evaluatedAt: number
    /** Hash of the planner inputs — replay detection for identical replans. */
    inputHash: string
  }
}

/** The durable policy context a decision is committed against. */
export interface NotificationPolicyContext {
  policyVersion: number
  timezone: string
  quietHoursEnabled: boolean
  quietHoursStart: string
  quietHoursEnd: string
  quietHoursTimezone?: string
  quietHoursAllowCritical: boolean
  osThreshold: NotificationLevel
  pushThreshold: NotificationLevel
}

/** A committed decision row — durable, replayable evidence. */
export interface NotificationPolicyStateRow {
  id: string
  scopeKey: string
  factKey: string
  /** What kind of policy state this row holds — closed union. */
  stateKind: "decision" | "inhibition" | "approval" | "incident" | "escalation"
  /** The decision payload (when `stateKind === "decision"`). */
  decision?: NotificationDecision
  /** The incident/inhibition payload (when applicable). */
  incident?: {
    rootFactKey: string
    memberFactKeys: string[]
    state: "open" | "acknowledged" | "resolved"
    openedAt: number
    acknowledgedAt?: number
    resolvedAt?: number
    ackedBy?: string
  }
  createdAt: number
  updatedAt: number
}

/** Read-state transitions that cancellation timers observe. */
export const READ_STATES_CANCELLING_ESCALATION: readonly NotificationReadState[] = [
  "read",
  "done",
] as const
