import type { ExecutionRunStatus } from "../execution/run"
import type { PluginBotTriggerKind } from "../plugin/plugin-bot"
import type { BotEventEnvelopeV1, BotEventResource } from "./event"
import type {
  BotApprovalDecisionV1,
  BotApprovalRequestV1,
  BotLogLevel,
  BotProgressUpdateV1,
  BotWaitForEventInput,
} from "./run"

// `types/` may not import `lib/`, so these unions mirror `lib/db/bot-types.ts`.
// `lib/db/bot-types.test.ts` pins them identical at the type level.
export type BotDeliveryStatus =
  "pending" | "leased" | "running" | "parked" | "succeeded" | "failed" | "deadletter" | "dismissed"

export type BotInstallationStatus = "enabled" | "disabled" | "needs_setup"

export type BotScopeKind = "account" | "workspace" | "project"

export interface BotMonitorState {
  lastSuccessAt?: number
  lastError?: string | null
  retryAt?: number
  cursor?: string
}

/** Host-owned publication checkpoints, safe for rebuilding monitoring after a restart. */
export interface BotPublicationReference {
  sourceRunId: string
  repository: string
  branch: string
  headSha: string
  snapshotId: string
  sourcePayload: unknown
}

export interface BotTriggerSnapshot {
  id: string
  kind: PluginBotTriggerKind
  armed: boolean
}

export interface BotCredentialSlotSnapshot {
  id: string
  optional: boolean
  /** Bound when the slot's binding names an account, session or adapter — never WHICH. */
  bound: boolean
}

export interface BotInstallationSnapshot {
  id: string
  createdAt: number
  activatedAt?: number
  config: Record<string, unknown>
  triggerState: Record<string, { cursor?: string }>
  monitor?: BotMonitorState
  webhookEnabled: boolean
  publications?: BotPublicationReference[]
  definitionId: string
  pinnedVersion: string
  status: BotInstallationStatus
  scope: { kind: BotScopeKind; workspaceId?: string; projectId?: string }
  triggers: BotTriggerSnapshot[]
  credentialSlots: BotCredentialSlotSnapshot[]
}

/**
 * One delivery as a handler may see it: enough to answer "is there work for
 * resource X", never the payload — payloads are untrusted and unbounded, and
 * a handler that needs one re-reads its own record by `eventId`.
 */
export interface BotDeliverySummary {
  id: string
  eventId: string
  triggerId: string
  type: string
  status: BotDeliveryStatus
  runId?: string
  resource?: BotEventResource
  correlation?: string
  receivedAt: number
  nextAttemptAt?: number
  attempts: number
}

export interface BotEnqueueInput {
  triggerId: string
  eventId: string
  type: string
  payload: unknown
  resource?: BotEventResource
  correlation?: string
}

export interface BotStepBeginResult {
  memoized: boolean
  /** Present when memoized. */
  value?: unknown
  /** Present when not memoized. */
  attempt?: number
}

export type BotWaitOutcome<T> =
  | { status: "settled"; value: T }
  /**
   * The run must leave the queue. Only ever seen by cross-process callers:
   * an in-process handler uses `ctx.step` and gets `BotRunParkedError` thrown
   * instead of this outcome.
   */
  | { status: "parked"; stepName: string; resumeAt: number; waitingFor?: string }

/** All calls are scoped by a live run owned by the calling plugin. */
export interface PluginBotsAPI {
  getInstallation(runId: string): Promise<BotInstallationSnapshot>
  enqueue(runId: string, input: BotEnqueueInput): Promise<{ deliveryId: string }>
  cancelResource(
    runId: string,
    input: { resourceId: string; exceptEventId?: string; exceptRevision?: string }
  ): Promise<number>
  recordMonitor(runId: string, patch: BotMonitorState): Promise<void>
  /**
   * Claim a step for this run, or hand back what it already produced. The
   * cross-process half of `ctx.step.run` — in-process handlers never call it.
   */
  stepBegin(runId: string, name: string): Promise<BotStepBeginResult>
  /** Record a step's output. Idempotent for a canonically equal value. */
  stepComplete(runId: string, name: string, value: unknown): Promise<void>
  /** Record a step's failure so the next entry knows which attempt it is on. */
  stepFail(runId: string, name: string, error: string): Promise<void>
  /**
   * Wait on a human decision. The `parked` outcome is only ever seen by
   * cross-process callers; in-process handlers use `ctx.step` and get
   * `BotRunParkedError` thrown.
   */
  waitForApproval(
    runId: string,
    name: string,
    request: BotApprovalRequestV1
  ): Promise<BotWaitOutcome<BotApprovalDecisionV1>>
  /**
   * Wait on a matching event, or the timeout. Resolves `settled` with `null`
   * on timeout. The `parked` outcome is only ever seen by cross-process
   * callers; in-process handlers use `ctx.step` and get `BotRunParkedError`
   * thrown.
   */
  waitForEvent(
    runId: string,
    name: string,
    input: BotWaitForEventInput
  ): Promise<BotWaitOutcome<BotEventEnvelopeV1 | null>>
  /** Append a handler log line to the run journal. */
  log(
    runId: string,
    level: BotLogLevel,
    message: string,
    data?: Record<string, unknown>
  ): Promise<void>
  /** Append a handler progress update to the run journal. */
  progress(runId: string, update: BotProgressUpdateV1): Promise<void>
  /**
   * Merge `cursor`/`watermark` into a `poll`/`derivedState` trigger's
   * host-stored runtime state. Other keys (edge memory, debounce) are
   * host-owned and rejected.
   */
  writeTriggerState(
    runId: string,
    input: { triggerId: string; cursor?: string; watermark?: number }
  ): Promise<void>
  /**
   * Arm or disarm one declared trigger. Disarming the trigger that owns the
   * current run does not cancel the run; it stops future deliveries.
   */
  setTriggerArmed(runId: string, input: { triggerId: string; armed: boolean }): Promise<void>
  /**
   * Deliveries this installation has received, newest first. Summary rows
   * only — no payload, and nothing mirrored from another Host.
   */
  listDeliveries(
    runId: string,
    query?: {
      resourceId?: string
      triggerId?: string
      status?: BotDeliveryStatus[]
      limit?: number
    }
  ): Promise<BotDeliverySummary[]>
  /**
   * Read a sibling run's recorded result. `null` when the run is unknown or
   * belongs to another installation — no existence oracle across tenants.
   */
  getRunResult(
    runId: string,
    input: { runId: string }
  ): Promise<{ status: ExecutionRunStatus; summary?: string; output?: unknown } | null>
  /**
   * Publish a plugin-namespaced event (`<pluginId>.<dotted>`) onto the Bot
   * plane. Provenance chains from this run's cause, so the loop guard and
   * depth cap apply; a re-entered handler emitting the same payload dedupes
   * onto the same derived id.
   */
  emit(
    runId: string,
    input: { type: string; payload: unknown; resource?: BotEventResource }
  ): Promise<{ matchedInstallations: number }>
}
