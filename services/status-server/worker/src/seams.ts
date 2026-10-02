/**
 * Frozen interfaces between the status Worker's core (owner B: routing,
 * ingestion, registry, aggregation, snapshots) and its incident / delivery
 * modules (owner E: incidents, maintenance, feeds, subscriptions,
 * notifications, admin).
 *
 * `src/index.ts` imports E's modules by the names below; the
 * `satisfies`-style assertions in `src/seams.test.ts` keep both sides honest.
 * Changing a signature here is a contract change: update both owners.
 */

import type {
  AdminProbeView,
  CheckResult,
  ComponentId,
  Confidence,
  DisplayStatus,
  IncidentSummary,
  MaintenanceView,
  ProbeDisableRequest,
  ProbeEnrollRequest,
  ProbeSetReferenceRequest,
  ProbeSource,
  ProfileId,
  ReasonCode,
} from "../../../../lib/status/contract"
import type { MinuteWindow, Streaks } from "../../../../lib/status/derive"
import type { Env } from "./env"
import type { RequestContext } from "./platform/http"
import type { JobLease } from "./platform/lease"

/** Returns null when the path is not one this module serves. */
export type RouteHandler = (
  request: Request,
  env: Env,
  ctx: RequestContext
) => Promise<Response | null>

/** A scheduled job's execution context. Every committing write checks the fence. */
export interface JobContext {
  env: Env
  lease: JobLease
  nowMs: number
}

/** One component's evaluated current state, produced each minute by B. */
export interface ComponentEvaluation {
  componentId: ComponentId
  evaluatedAtMs: number
  status: DisplayStatus
  confidence: Confidence
  inMaintenance: boolean
  /** The reference observer has fresh, usable (pass/fail) evidence. */
  referenceFresh: boolean
  referenceProbeId: string | null
  /**
   * Reference slots for the recent window (oldest first, one per expected
   * minute, `missing` when nothing arrived). Delayed batches only ever fill
   * a `missing` slot; they never change an observed one.
   */
  referenceRecent: Array<{
    minute: number
    result: CheckResult | "missing"
    reason: ReasonCode | null
  }>
  referenceStreaks: Streaks
  latestEvidenceAtMs: number | null
  /** Fresh non-reference witnesses and their current verdict. */
  witnesses: Array<{
    probeId: string
    profileId: ProfileId
    source: ProbeSource
    result: CheckResult
    consecutiveFailures: number
  }>
  /** Proposed latency guardrail tripped (3 windows, p95 > 1500 ms, ≥ 20 samples). */
  latencyDegraded: boolean
}

/** What B hands E's reconciliation each minute. */
export interface ReconcileInput {
  evaluations: ComponentEvaluation[]
  /** Observer health: the reference stopped reporting (operator alert, not an outage). */
  observer: {
    referenceProbeId: string | null
    referenceHealthy: boolean
    lastReferenceAtMs: number | null
  }
}

// ---------------------------------------------------------------------------
// Owner E module surfaces (implemented under src/{incidents,maintenance,feeds,
// subscriptions,notifications,admin}/index.ts).
// ---------------------------------------------------------------------------

export interface IncidentsModule {
  /** `GET /incidents`, `GET /incidents/:id` (paths relative to /api/status/v1). */
  handleIncidentRoutes: RouteHandler
  loadIncidentsForSnapshot(
    env: Env,
    nowMs: number
  ): Promise<{ active: IncidentSummary[]; past: IncidentSummary[] }>
  /** Open / advance / resolve automated incidents; never touches pinned ones. */
  reconcileIncidents(job: JobContext, input: ReconcileInput): Promise<void>
}

export interface MaintenanceModule {
  /** Scheduled, in-progress, awaiting-confirmation and recently finished windows. */
  loadMaintenanceForSnapshot(env: Env, nowMs: number): Promise<MaintenanceView[]>
  /**
   * Published exclusion windows (excludeFromAvailability, not cancelled)
   * overlapping `[fromMs, toMs)`, per component, minute-aligned. Union is
   * applied by the caller. A window in `awaiting_confirmation` excludes only
   * up to its planned end.
   */
  loadExclusionWindows(
    env: Env,
    fromMs: number,
    toMs: number
  ): Promise<Record<ComponentId, MinuteWindow[]>>
  /** Components inside an active (in_progress) window now. */
  activeMaintenanceComponents(env: Env, nowMs: number): Promise<Set<ComponentId>>
  /** scheduled → in_progress at start; in_progress → awaiting_confirmation at end. */
  advanceMaintenance(job: JobContext): Promise<void>
}

export interface FeedsModule {
  /** `GET /feed.atom`, `GET /feed.rss`. */
  handleFeedRoutes: RouteHandler
}

export interface SubscriptionsModule {
  /** `POST /subscriptions`, `/subscriptions/confirm`, `/manage`, `/unsubscribe`. */
  handleSubscriptionRoutes: RouteHandler
  /** Whether signup can be offered right now (flag, binding, keys, sender). */
  emailCapability(env: Env): boolean
  /** Purge expired pending entries and old unsubscribed rows. */
  runSubscriptionRetention(job: JobContext): Promise<void>
}

export interface NotificationsModule {
  /** Lease-guarded outbox delivery, at most 100 rows per invocation. */
  runDelivery(job: JobContext): Promise<void>
  /** Drop delivery bodies / metadata past retention. */
  runNotificationRetention(job: JobContext): Promise<void>
  /**
   * Operator alert through the fixed configured channel, de-duplicated by
   * `key` (the same key is not re-sent within `cooldownMs`).
   */
  alertOperator(
    env: Env,
    alert: {
      key: string
      severity: "warning" | "critical"
      summary: string
      nowMs: number
      cooldownMs?: number
    }
  ): Promise<void>
}

export interface AdminModule {
  /** `/admin/*`: Access JWT + operator allowlist, idempotent operations, audit. */
  handleAdminRoutes: RouteHandler
}

// ---------------------------------------------------------------------------
// Owner B surfaces E may call.
// ---------------------------------------------------------------------------

export interface CoreForAdmin {
  /** Mark rollups covering `[fromMinute, toMinute)` for rebuild (retroactive edits). */
  markMinutesDirty(db: D1Database, fromMinute: number, toMinute: number): Promise<void>
}

/** Result of a registry mutation; the admin router records it for idempotency. */
export interface AdminMutationResult {
  status: number
  body: unknown
}

/** Implemented by B in `src/registry/admin.ts`; routed and authorised by E. */
export interface RegistryAdmin {
  listProbesForAdmin(env: Env, nowMs: number): Promise<AdminProbeView[]>
  enrollProbe(
    env: Env,
    request: ProbeEnrollRequest,
    actor: string,
    nowMs: number
  ): Promise<AdminMutationResult>
  setProbeDisabled(
    env: Env,
    request: ProbeDisableRequest,
    actor: string,
    nowMs: number
  ): Promise<AdminMutationResult>
  setReferenceProbe(
    env: Env,
    request: ProbeSetReferenceRequest,
    actor: string,
    nowMs: number
  ): Promise<AdminMutationResult>
}
