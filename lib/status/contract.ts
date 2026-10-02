/**
 * Public status contract, version 1.
 *
 * One schema for every consumer of the public signaling status service: the
 * exported `/status` page, the Cognia Settings link, the status Worker
 * (`services/status-server/worker`), its external Node probe
 * (`services/status-server/probe`) and the operator CLI
 * (`services/status-server/admin`). The standalone services import this file
 * by relative path and bundle it, so it must stay a leaf: no React, no `@/`
 * alias, no Dexie, no native platform module and no Node built-in.
 *
 * Meaning is frozen per `schemaVersion`. Adding an optional field is allowed;
 * changing what an existing field means requires version 2. A reader that
 * meets an unsupported version shows "unknown", never a preview.
 *
 * Plan: docs/plans/2026-10-02-signaling-public-status-implementation.md.
 */

export const STATUS_SCHEMA_VERSION = 1 as const
export type StatusSchemaVersion = typeof STATUS_SCHEMA_VERSION

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * The monitored public service, split into the three questions a probe can
 * answer separately: does the host answer HTTP with a Cognia health body, can
 * two peers authenticate into a room and exchange a signal, and does the
 * explicit `lane: "data"` relay carry bytes intact in both directions.
 */
export const COMPONENT_IDS = ["signalingHttp", "signalingAuth", "relayData"] as const
export type ComponentId = (typeof COMPONENT_IDS)[number]

/**
 * Check identifiers in an observation. The three component checks share their
 * component's ID. `statusPage` / `statusApi` are monitoring-plane checks: they
 * describe whether the status service itself is reachable and never feed a
 * component's availability.
 */
export const CHECK_IDS = [...COMPONENT_IDS, "statusPage", "statusApi"] as const
export type CheckId = (typeof CHECK_IDS)[number]

/** The check each component's history is built from, in protocol order. */
export const COMPONENT_DEPENDENCY: Readonly<Record<ComponentId, ComponentId | null>> = {
  signalingHttp: null,
  signalingAuth: null,
  relayData: "signalingAuth",
}

/**
 * Client-origin profiles. `native` sends no Origin header (the desktop and
 * native transports) and is the reference profile. The others send the exact
 * Origin a WebView or browser would; from a probe that is header simulation,
 * not a run inside a real browser or Capacitor shell, and the UI says so.
 */
export const PROFILE_IDS = ["native", "web", "ios", "android"] as const
export type ProfileId = (typeof PROFILE_IDS)[number]

export const PROBE_SOURCES = ["external", "cloudflare"] as const
export type ProbeSource = (typeof PROBE_SOURCES)[number]

export const HISTORY_RANGES = ["24h", "7d", "30d", "90d"] as const
export type HistoryRange = (typeof HISTORY_RANGES)[number]

export const STATUS_LOCALES = ["en", "zh-CN"] as const
export type StatusLocale = (typeof STATUS_LOCALES)[number]

// ---------------------------------------------------------------------------
// Evidence and display vocabularies
// ---------------------------------------------------------------------------

/** What one check observed. `unknown` is "not measured", never "fine". */
export const CHECK_RESULTS = ["pass", "fail", "unknown"] as const
export type CheckResult = (typeof CHECK_RESULTS)[number]

/** Public display status. `unknown` has no numeric severity and is never hidden. */
export const DISPLAY_STATUSES = [
  "operational",
  "degraded",
  "partial_outage",
  "major_outage",
  "maintenance",
  "unknown",
] as const
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number]

/** Health of the observers, kept apart from the health of the service. */
export const MONITORING_STATUSES = ["healthy", "limited", "degraded", "unknown"] as const
export type MonitoringStatus = (typeof MONITORING_STATUSES)[number]

/**
 * How much independent evidence backs a component's current status.
 * `single_witness`: only the reference observer has fresh evidence.
 */
export const CONFIDENCE_LEVELS = ["corroborated", "single_witness", "none"] as const
export type Confidence = (typeof CONFIDENCE_LEVELS)[number]

/** Bounded failure reasons. Raw exceptions and payloads are never published. */
export const REASON_CODES = [
  "dns_error",
  "tls_error",
  "connect_error",
  "timeout",
  "http_status",
  "schema_mismatch",
  "protocol_mismatch",
  "origin_rejected",
  "ws_upgrade",
  "ws_closed",
  "auth_rejected",
  "auth_timeout",
  "peer_timeout",
  "relay_timeout",
  "relay_mismatch",
  "dependency_failed",
  "runner_error",
  "overlap_skipped",
  "missing",
  "stale",
] as const
export type ReasonCode = (typeof REASON_CODES)[number]

export const INCIDENT_STATES = ["investigating", "identified", "monitoring", "resolved"] as const
export type IncidentState = (typeof INCIDENT_STATES)[number]

export const INCIDENT_IMPACTS = ["degraded", "partial_outage", "major_outage"] as const
export type IncidentImpact = (typeof INCIDENT_IMPACTS)[number]

export const UPDATE_SOURCES = ["manual", "automated"] as const
export type UpdateSource = (typeof UPDATE_SOURCES)[number]

export const MAINTENANCE_STATES = [
  "scheduled",
  "in_progress",
  "awaiting_confirmation",
  "completed",
  "cancelled",
] as const
export type MaintenanceState = (typeof MAINTENANCE_STATES)[number]

export const MAINTENANCE_UPDATE_KINDS = [
  "scheduled",
  "started",
  "extended",
  "rescheduled",
  "awaiting_confirmation",
  "completed",
  "cancelled",
  "note",
] as const
export type MaintenanceUpdateKind = (typeof MAINTENANCE_UPDATE_KINDS)[number]

// ---------------------------------------------------------------------------
// Policy constants (published so every consumer uses the same thresholds)
// ---------------------------------------------------------------------------

export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

/** A 60 s check is fresh for this long after its own check time. */
export const REFERENCE_FRESH_MS = 180_000
/** A 300 s profile / corroborating protocol check is fresh for this long. */
export const PROFILE_FRESH_MS = 900_000
/** A snapshot older than this is stale in the browser even if a cache serves it. */
export const SNAPSHOT_STALE_MS = 180_000
/** Consecutive expected reference failures before a major outage / incident. */
export const OUTAGE_CONSECUTIVE_FAILURES = 3
/** Consecutive fresh reference passes before an outage shows recovery. */
export const RECOVERY_CONSECUTIVE_PASSES = 2
/** Stable minutes after entering monitoring before an automated incident resolves. */
export const RESOLVE_STABLE_MINUTES = 3
/** Two missing expected slots break a consecutive failure / pass sequence. */
export const SEQUENCE_BREAK_MISSING_SLOTS = 2
/** Minimum successful samples in a latency bucket before a percentile is shown. */
export const LATENCY_MIN_SAMPLES = 5
/** Proposed degradation guardrail; not a measured Cognia SLO. */
export const LATENCY_DEGRADED_P95_MS = 1_500
export const LATENCY_DEGRADED_MIN_SAMPLES = 20
export const LATENCY_DEGRADED_WINDOWS = 3
/**
 * Latency histogram upper bounds in milliseconds. The last bucket is open.
 * Percentiles are read from merged histograms, never from stored percentiles.
 */
export const LATENCY_BUCKET_BOUNDS_MS = [
  25, 50, 75, 100, 150, 200, 300, 400, 600, 800, 1_000, 1_500, 2_000, 3_000, 5_000, 8_000, 13_000,
  20_000,
] as const
export const LATENCY_BUCKET_COUNT = LATENCY_BUCKET_BOUNDS_MS.length + 1

/** Ingestion body limit and late-acceptance window. */
export const MAX_REQUEST_BODY_BYTES = 32 * 1024
export const LATE_OBSERVATION_MS = 10 * MINUTE_MS
/** Allowed skew between a run's scheduled minute and its claimed times. */
export const OBSERVATION_SKEW_MS = 2 * MINUTE_MS
/** Signed request timestamp window. */
export const SIGNATURE_WINDOW_MS = 120_000
/** Snapshot JSON budget. */
export const MAX_SNAPSHOT_BYTES = 256 * 1024
export const INCIDENT_PAGE_LIMIT = 50
export const MAX_TITLE_CHARS = 160
export const MAX_MESSAGE_CHARS = 4_000

export const RANGE_SPECS: Readonly<
  Record<HistoryRange, { durationMs: number; bucketMs: number; buckets: number }>
> = {
  "24h": { durationMs: DAY_MS, bucketMs: HOUR_MS, buckets: 24 },
  "7d": { durationMs: 7 * DAY_MS, bucketMs: DAY_MS, buckets: 7 },
  "30d": { durationMs: 30 * DAY_MS, bucketMs: DAY_MS, buckets: 30 },
  "90d": { durationMs: 90 * DAY_MS, bucketMs: DAY_MS, buckets: 90 },
}

// ---------------------------------------------------------------------------
// Shared value shapes
// ---------------------------------------------------------------------------

/**
 * Operator-authored bilingual text. English is required and is the fallback
 * for a missing or empty `zh-CN`. Rendered as plain text, never HTML.
 */
export interface LocalizedText {
  en: string
  "zh-CN"?: string
}

/** ISO-8601 UTC timestamp string, e.g. `2026-10-02T10:00:00.000Z`. */
export type IsoTimestamp = string

/** Slot counts behind an availability figure. */
export interface AvailabilityCounts {
  passCount: number
  failCount: number
  /** Expected slots with no pass/fail evidence, after exclusion when adjusted. */
  unknownCount: number
  /** Expected slots inside the window, after exclusion when adjusted. */
  expectedSlots: number
}

export interface AvailabilitySummary extends AvailabilityCounts {
  /** `100 * pass / (pass + fail)`, or null when nothing was observed. */
  observedAvailability: number | null
  /** `100 * (pass + fail) / expected`, or null when nothing was expected. */
  coverage: number | null
  /** Slots whose minute fell in a published maintenance window with exclusion. */
  excludedSlots: number
  /** The same figures with maintenance-excluded slots removed. */
  maintenanceAdjusted: AvailabilityCounts & {
    observedAvailability: number | null
    coverage: number | null
  }
}

export interface HistoryBucket {
  start: IsoTimestamp
  end: IsoTimestamp
  /** The bucket is still open, or started before observation began. */
  partial: boolean
  /** `no_data` when nothing was expected or nothing was observed. */
  status: DisplayStatus | "no_data"
  availability: AvailabilitySummary
}

export interface LatencyBucket {
  start: IsoTimestamp
  end: IsoTimestamp
  sampleCount: number
  /** Null when `sampleCount < LATENCY_MIN_SAMPLES`. */
  p50Ms: number | null
  p95Ms: number | null
}

/** The phase a latency series measures, documented in the UI. */
export type LatencyPhase = "http" | "auth" | "data"

export const COMPONENT_LATENCY_PHASE: Readonly<Record<ComponentId, LatencyPhase>> = {
  signalingHttp: "http",
  signalingAuth: "auth",
  relayData: "data",
}

// ---------------------------------------------------------------------------
// Public snapshot (GET /api/status/v1/snapshot)
// ---------------------------------------------------------------------------

export interface EvidenceSummary {
  probeId: string
  profileId: ProfileId
  source: ProbeSource
  /** The reference observer whose minutes form the history. */
  reference: boolean
  result: CheckResult
  reason: ReasonCode | null
  checkedAt: IsoTimestamp | null
  fresh: boolean
  consecutiveFailures: number
  /** True for Origin-header profiles: simulated, not a physical client. */
  simulatedOrigin: boolean
}

export interface ComponentSnapshot {
  id: ComponentId
  status: DisplayStatus
  confidence: Confidence
  latestEvidenceAt: IsoTimestamp | null
  /** A published maintenance window covers this component now. */
  inMaintenance: boolean
  availability: AvailabilitySummary
  history: HistoryBucket[]
  latency: {
    phase: LatencyPhase
    minSamples: number
    summary: LatencyBucket
    buckets: LatencyBucket[]
  }
  evidence: EvidenceSummary[]
}

export type ProbeHealth = "healthy" | "stale" | "error" | "disabled" | "unknown"

export interface ProbeSummary {
  id: string
  label: LocalizedText
  source: ProbeSource
  /** Registered location, e.g. a city/region; null when not declared. */
  location: LocalizedText | null
  /** Hosting provider name from the registry, never from a payload. */
  provider: string | null
  profiles: Array<{ id: ProfileId; cadenceSeconds: number; simulatedOrigin: boolean }>
  reference: boolean
  enrolledAt: IsoTimestamp
  lastAttemptAt: IsoTimestamp | null
  lastSuccessAt: IsoTimestamp | null
  health: ProbeHealth
  reason: ReasonCode | null
}

export interface IncidentUpdateView {
  id: string
  state: IncidentState
  impact: IncidentImpact
  componentIds: ComponentId[]
  message: LocalizedText
  source: UpdateSource
  at: IsoTimestamp
  /** Present when this update corrects an earlier one. */
  correctionOf: string | null
}

export interface IncidentSummary {
  id: string
  title: LocalizedText
  state: IncidentState
  impact: IncidentImpact
  componentIds: ComponentId[]
  source: UpdateSource
  startedAt: IsoTimestamp
  resolvedAt: IsoTimestamp | null
  updatedAt: IsoTimestamp
  revision: number
  /** The resolved incident this one follows, when a failure recurred. */
  predecessorId: string | null
  latestUpdate: IncidentUpdateView | null
}

export interface IncidentDetail extends IncidentSummary {
  /** Oldest first, append-only. */
  updates: IncidentUpdateView[]
}

export interface MaintenanceUpdateView {
  id: string
  kind: MaintenanceUpdateKind
  message: LocalizedText | null
  at: IsoTimestamp
}

export interface MaintenanceView {
  id: string
  title: LocalizedText
  description: LocalizedText
  componentIds: ComponentId[]
  state: MaintenanceState
  /** Minute-aligned, half-open `[startsAt, endsAt)`. */
  startsAt: IsoTimestamp
  endsAt: IsoTimestamp
  actualEndAt: IsoTimestamp | null
  excludeFromAvailability: boolean
  revision: number
  updates: MaintenanceUpdateView[]
}

export interface StatusCapabilities {
  /** Email subscriptions can be started from this origin right now. */
  email: boolean
  feeds: boolean
  locales: StatusLocale[]
  historyRanges: HistoryRange[]
  /** Independent read-only mirror, when one is deployed. */
  mirrorUrl: string | null
  /** The primary page, for a mirror's "subscribe on the primary" link. */
  primaryUrl: string | null
}

export interface PublicStatusSnapshot {
  schemaVersion: StatusSchemaVersion
  mode: "live"
  /** Monotonic aggregate revision. */
  revision: number
  generatedAt: IsoTimestamp
  serverTime: IsoTimestamp
  /** First expected reference minute; null before any probe enrolled. */
  observationStartedAt: IsoTimestamp | null
  range: HistoryRange
  staleAfterMs: number
  freshness: { referenceFreshMs: number; profileFreshMs: number }
  overallStatus: DisplayStatus
  monitoringStatus: MonitoringStatus
  /** Joined series: any observed failure fails the minute, all three pass passes it. */
  overall: { availability: AvailabilitySummary; history: HistoryBucket[] }
  components: ComponentSnapshot[]
  probes: ProbeSummary[]
  activeIncidents: IncidentSummary[]
  pastIncidents: IncidentSummary[]
  scheduledMaintenance: MaintenanceView[]
  capabilities: StatusCapabilities
}

export interface IncidentPage {
  schemaVersion: StatusSchemaVersion
  incidents: IncidentSummary[]
  nextCursor: string | null
}

export interface StatusBackendHealth {
  ok: boolean
  service: "cognia-status"
  version: string
  build: string | null
  schemaVersion: StatusSchemaVersion
  /** D1 answered a trivial read. */
  database: "ok" | "error"
  /** Age of the newest snapshot, null when none exists yet. */
  snapshotAgeMs: number | null
}

// ---------------------------------------------------------------------------
// Probe ingestion (POST /api/status/v1/observations, per-probe HMAC)
// ---------------------------------------------------------------------------

export interface CheckObservation {
  checkId: CheckId
  result: CheckResult
  /** Phase duration for a measured attempt; null when not attempted. */
  durationMs: number | null
  reason: ReasonCode | null
  /** False when the check was skipped (dependency failure, overlap, shutdown). */
  attempted: boolean
  /** The check whose failure caused this one to be skipped, if any. */
  dependsOn: CheckId | null
}

export interface ObservationBatch {
  schemaVersion: StatusSchemaVersion
  probeId: string
  /** Unique per probe; the replay identity together with the body digest. */
  runId: string
  /** The registry revision the probe was configured from. */
  registryRevision: number
  scheduledAt: IsoTimestamp
  startedAt: IsoTimestamp
  finishedAt: IsoTimestamp
  profileId: ProfileId
  checks: CheckObservation[]
}

export interface ObservationAccepted {
  status: "accepted" | "duplicate"
  runId: string
}

// ---------------------------------------------------------------------------
// Subscriptions (anonymous + scoped tokens)
// ---------------------------------------------------------------------------

/** Bumped when the consent wording changes; recorded per subscriber. */
export const SUBSCRIPTION_CONSENT_VERSION = 1

export interface SubscribeRequest {
  email: string
  locale: StatusLocale
  /** Empty means every component. */
  componentIds: ComponentId[]
  consentVersion: number
}

/** Always the same body, whatever the address's state: no enumeration. */
export interface SubscribeAccepted {
  status: "accepted"
}

export interface TokenRequest {
  token: string
}

export interface SubscriptionPreferences {
  locale: StatusLocale
  componentIds: ComponentId[]
  /** Masked address, e.g. `a•••@example.com`. Never the full address. */
  maskedEmail: string
  revision: number
}

export interface ConfirmResult {
  status: "confirmed"
  preferences: SubscriptionPreferences
}

export type ManageRequest =
  | { token: string; operation: "read" }
  | {
      token: string
      operation: "update"
      expectedRevision: number
      locale: StatusLocale
      componentIds: ComponentId[]
    }

export interface ManageResult {
  status: "ok"
  preferences: SubscriptionPreferences
}

export interface UnsubscribeResult {
  status: "unsubscribed"
}

// ---------------------------------------------------------------------------
// Operator API (/api/status/v1/admin/*, Access identity + allowlist)
// ---------------------------------------------------------------------------

export interface AdminWrite {
  /** Client-generated idempotency key; a replay returns the first result. */
  operationId: string
}

export interface IncidentCreateRequest extends AdminWrite {
  title: LocalizedText
  message: LocalizedText
  impact: IncidentImpact
  componentIds: ComponentId[]
  state: Exclude<IncidentState, "resolved">
}

export interface IncidentUpdateRequest extends AdminWrite {
  expectedRevision: number
  state?: IncidentState
  impact?: IncidentImpact
  componentIds?: ComponentId[]
  message: LocalizedText
  /** Take manual ownership so automated reconciliation stops changing it. */
  pin?: boolean
  /** Append as a correction of an earlier update's text. */
  correctionOf?: string
}

export interface IncidentResolveRequest extends AdminWrite {
  expectedRevision: number
  message: LocalizedText
  reason: string
}

export interface MaintenanceScheduleRequest extends AdminWrite {
  title: LocalizedText
  description: LocalizedText
  componentIds: ComponentId[]
  startsAt: IsoTimestamp
  endsAt: IsoTimestamp
  excludeFromAvailability: boolean
}

export interface MaintenanceChangeRequest extends AdminWrite {
  expectedRevision: number
  message?: LocalizedText
  /** extend: new end. reschedule: new start + end (only before start). */
  startsAt?: IsoTimestamp
  endsAt?: IsoTimestamp
}

export interface ProbeDisableRequest extends AdminWrite {
  probeId: string
  disabled: boolean
  reason: string
}

export interface ProbeSetReferenceRequest extends AdminWrite {
  probeId: string
  /** Minute-aligned future boundary; earlier history is never rewritten. */
  effectiveAt: IsoTimestamp
  reason: string
}

/**
 * Register a probe and the key ID it signs with. The secret itself is set
 * separately as a Worker secret (`PROBE_SECRETS`) and never sent here.
 */
export interface ProbeEnrollRequest extends AdminWrite {
  probeId: string
  source: ProbeSource
  label: LocalizedText
  location: LocalizedText | null
  provider: string | null
  /** Minute-aligned enrollment time; observations before it are rejected. */
  enrolledAt: IsoTimestamp
  profiles: Array<{
    id: ProfileId
    httpCadenceSeconds: number | null
    protocolCadenceSeconds: number | null
  }>
  keyId: string
}

export interface DeliveryRetryRequest extends AdminWrite {
  outboxId: string
  /** The operator checked provider evidence for an uncertain send. */
  acknowledgeUncertain: boolean
}

export interface AdminProbeView extends ProbeSummary {
  disabled: boolean
  retiredAt: IsoTimestamp | null
  keyIds: string[]
}

export type DeliveryState =
  | "pending"
  | "leased"
  | "provider_accepted"
  | "retryable_failure"
  | "terminal_failure"
  | "uncertain"
  | "suppressed"
  | "cancelled"

export interface DeliveryView {
  id: string
  eventId: string
  channel: "email"
  state: DeliveryState
  attempts: number
  nextAttemptAt: IsoTimestamp | null
  lastErrorCode: string | null
  providerMessageId: string | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  "bad_request",
  "body_too_large",
  "unsupported_schema",
  "not_found",
  "method_not_allowed",
  "unauthorized",
  "forbidden",
  "conflict",
  "revision_conflict",
  "too_late",
  "rate_limited",
  "token_invalid",
  "token_expired",
  "token_used",
  "unavailable",
  "internal",
] as const
export type StatusErrorCode = (typeof ERROR_CODES)[number]

export interface StatusErrorBody {
  code: StatusErrorCode
  requestId: string
  /** Revision conflicts carry the safe current revision. */
  currentRevision?: number
}
