import type { OutboundRecipientGrant } from "@cognia/agent-config-types/action-review"
import type {
  IntegrationAccount,
  IntegrationActionJob,
  IntegrationAuditEntry,
  IntegrationEventEnvelope,
  IntegrationSubscription,
} from "@/types/plugin/plugin-integration"

/**
 * An integration account as the host stores it: the public account, plus what
 * only the host reads.
 *
 * `outboundRecipients` is the repositories any unattended write through this
 * account may reach (ADR-0239 phase 2, `integration-account:<id>`). A person
 * writes it in the integration hub (`setIntegrationAccountOutboundRecipients`);
 * an account patch cannot carry it, and the plugin API strips it from every
 * account it returns, so no plugin can read or widen it.
 */
export type IntegrationAccountRow = IntegrationAccount & {
  outboundRecipients?: OutboundRecipientGrant[]
}
export type IntegrationSubscriptionRow = IntegrationSubscription
export type IntegrationActionJobRow = IntegrationActionJob
export type IntegrationAuditRow = IntegrationAuditEntry

/**
 * The consumers a stored integration event is projected onto, in the order
 * they run. Every one of them is idempotent per event (the workflow occurrence
 * key, the Bot delivery dedup key, the inbox message id, and the lifecycle and
 * board refresh being level-setting), which is what makes re-running an
 * unfinished one after a crash safe.
 */
export const INTEGRATION_PROJECTION_STEPS = [
  "lifecycle",
  "workflow",
  "bots",
  "issues",
  "inbox",
] as const

export type IntegrationProjectionStep = (typeof INTEGRATION_PROJECTION_STEPS)[number]

export interface IntegrationProjectionStepState {
  status: "pending" | "complete"
  /** Bounded error class of the last failed attempt, never a raw message. */
  errorCode?: string
  /**
   * Bot installations that could not be resolved yet (their plugin had not
   * registered its definition or handler) and are the only ones a retry
   * re-routes to. Absent means "route to every eligible installation".
   */
  retryInstallationIds?: string[]
}

export interface IntegrationEventProjectionV1 {
  version: 1
  steps: Record<IntegrationProjectionStep, IntegrationProjectionStepState>
}

/**
 * `pending` has at least one unfinished projection and is due at
 * `projectionDueAt` (also the claim lease while one is in flight).
 * `deadletter` exhausted its attempts. Rows written before projection
 * tracking existed carry no state and are never re-projected.
 */
export type IntegrationProjectionState = "pending" | "complete" | "deadletter"

/**
 * The stored event: the public envelope plus host-local projection
 * bookkeeping. The bookkeeping never leaves this table; plugins and workflow
 * payloads only ever see the envelope.
 */
export type IntegrationEventRow = IntegrationEventEnvelope & {
  projection?: IntegrationEventProjectionV1
  projectionState?: IntegrationProjectionState
  /** Epoch ms. Due time while pending; cleared once complete. */
  projectionDueAt?: number
  projectionAttempts?: number
}
