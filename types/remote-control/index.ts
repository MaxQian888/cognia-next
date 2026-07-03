/**
 * Remote Control Type Definitions
 *
 * The remote-control subsystem completes cognia-next's "trigger from outside"
 * story for the scheduler:
 *   - **Inbound** (desktop only): a local 127.0.0.1 axum HTTP server accepts
 *     authenticated POSTs that fire `runTaskNow(id)` or `emitSchedulerEvent`.
 *   - **Outbound**: HMAC signing + custom headers layered on top of the
 *     existing `lib/scheduler/notification-integration.ts` webhook channel.
 *
 * See `docs/content/docs/adr/0005-remote-control.md`.
 */

import type { SchedulerEventType } from "@/lib/scheduler/event-integration"

// ---------------------------------------------------------------------------
// Persisted configuration (mirrored on the Rust side via tauri-plugin-store).
// Secrets — bearer token, signing secret — never appear in this struct.
// ---------------------------------------------------------------------------

export interface RemoteControlInboundConfig {
  /** Whether the local HTTP listener is running. Toggling on requires a generated token. */
  enabled: boolean
  /** Loopback port the axum server binds to. 1024–65535. */
  port: number
  /** CIDR / IP allowlist. Defaults to `["127.0.0.1/32"]`. */
  allowlist: string[]
  /** Per-token rate limit, in requests per minute. */
  rateLimitPerMin: number
  /**
   * Token capability (Tailscale-style read/write split). `read` permits the
   * health probe + every `GET` read endpoint; `write` additionally permits the
   * mutating `POST` routes. Applied at listener start — changing it takes
   * effect on the next stop/start, like port/allowlist.
   */
  capability: TokenCapability
  /**
   * When false (default), the inbound server rejects sensitive command targets
   * (`SENSITIVE_REMOTE_COMMAND_TARGETS` — model-cost / off-device side effects)
   * with `403 sensitive_target_disabled` even for a `write` token. A
   * config-gated guardrail beyond the binary capability. Takes effect on the
   * next stop/start.
   */
  allowSensitiveTargets: boolean
  /**
   * Per-target permission denylist (least-privilege ACL). Any target listed
   * here is rejected with `403 target_disabled` even for a `write` token — a
   * finer-grained gate on top of the binary read/write capability and the
   * sensitive-target guardrail. Empty (default) means every known target is
   * dispatchable. Applied at listener start; changing it takes effect on the
   * next stop/start, like port/allowlist/capability. Enforced server-side in
   * Rust (`run_command`) with a renderer-side guard in `dispatchRemoteCommand`
   * as defence-in-depth.
   */
  disabledTargets: RemoteCommandTarget[]
}

export interface RemoteControlOutboundHeader {
  name: string
  value: string
}

export interface RemoteControlOutboundConfig {
  /** True when a signing secret is set (the secret itself lives in OS keyring on desktop, Zustand persist on web). */
  hasSigningSecret: boolean
  /** Custom headers added to every outbound webhook delivery. */
  defaultHeaders: RemoteControlOutboundHeader[]
  /** Egress endpoints any subsystem can publish events to (Standard Webhooks). */
  endpoints: WebhookEgressEndpoint[]
  /**
   * User-tunable delivery limits (retries / timeout / backoff) applied to every
   * outbound webhook delivery. Optional so configs persisted before this field
   * existed fall back to {@link DEFAULT_WEBHOOK_DELIVERY}.
   */
  delivery?: WebhookDeliveryConfig
}

/**
 * Tunable outbound-webhook delivery limits. Read by {@link deliverWebhook} on
 * every attempt; surfaced as editable inputs in the Outbound settings tab.
 */
export interface WebhookDeliveryConfig {
  /** Retry attempts after the first send (total sends = maxRetries + 1). 0–10. */
  maxRetries: number
  /** Per-attempt request timeout in milliseconds. 1000–120000. */
  timeoutMs: number
  /** Base delay for exponential backoff in milliseconds. 100–60000. */
  baseDelayMs: number
}

export const DEFAULT_WEBHOOK_DELIVERY: WebhookDeliveryConfig = {
  maxRetries: 3,
  timeoutMs: 10_000,
  baseDelayMs: 1000,
}

/** Bounds enforced on {@link WebhookDeliveryConfig} inputs (UI + delivery). */
export const WEBHOOK_DELIVERY_BOUNDS = {
  maxRetries: { min: 0, max: 10 },
  timeoutMs: { min: 1000, max: 120_000 },
  baseDelayMs: { min: 100, max: 60_000 },
} as const

/** Clamp a partial delivery config into the accepted bounds, filling defaults. */
export function normalizeWebhookDelivery(
  partial?: Partial<WebhookDeliveryConfig>
): WebhookDeliveryConfig {
  const clamp = (v: number, min: number, max: number, fallback: number): number => {
    if (!Number.isFinite(v)) return fallback
    return Math.min(max, Math.max(min, Math.round(v)))
  }
  const b = WEBHOOK_DELIVERY_BOUNDS
  return {
    maxRetries: clamp(
      partial?.maxRetries ?? DEFAULT_WEBHOOK_DELIVERY.maxRetries,
      b.maxRetries.min,
      b.maxRetries.max,
      DEFAULT_WEBHOOK_DELIVERY.maxRetries
    ),
    timeoutMs: clamp(
      partial?.timeoutMs ?? DEFAULT_WEBHOOK_DELIVERY.timeoutMs,
      b.timeoutMs.min,
      b.timeoutMs.max,
      DEFAULT_WEBHOOK_DELIVERY.timeoutMs
    ),
    baseDelayMs: clamp(
      partial?.baseDelayMs ?? DEFAULT_WEBHOOK_DELIVERY.baseDelayMs,
      b.baseDelayMs.min,
      b.baseDelayMs.max,
      DEFAULT_WEBHOOK_DELIVERY.baseDelayMs
    ),
  }
}

export interface RemoteControlConfig {
  inbound: RemoteControlInboundConfig
  outbound: RemoteControlOutboundConfig
}

// ---------------------------------------------------------------------------
// Live status — read from Rust on demand, surfaced in the Overview tab.
// ---------------------------------------------------------------------------

export interface RemoteControlStatus {
  /** True when the inbound axum server is currently listening. */
  inboundRunning: boolean
  /** Bound port if running, otherwise null. */
  boundPort: number | null
  /** Wall-clock time of the most recent successful inbound request. */
  lastCallAt: string | null
  /** Number of inbound calls processed since the server started. */
  inboundCallsTotal: number
  /** Whether a bearer token has been generated. The Switch is gated on this. */
  hasInboundToken: boolean
}

export interface RemoteControlInboundCallLog {
  /** Stable id (uuid). */
  id: string
  /** ISO-8601 timestamp. */
  at: string
  /**
   * Concrete request path that was hit, as reported by the Rust middleware
   * (`request.uri().path()`). Known shapes: `/api/v1/health`,
   * `/api/v1/tasks/<id>/run`, `/api/v1/events`, `/api/v1/commands/<target>`,
   * and the read surface (`/api/v1/targets`, `/api/v1/tasks`,
   * `/api/v1/workflows/<id>/runs`, `/api/v1/goals`, `/api/v1/audit`,
   * `/api/v1/runs`, `/api/v1/runs/<runId>`, `/api/v1/teams`,
   * `/api/v1/teams/<id>`, `/api/v1/workflows`, `/api/v1/plugins`,
   * `/api/v1/connectors`, `/api/v1/backups`, `/api/v1/ocr/cache`,
   * `/api/v1/sessions/<id>/messages`). Kept as a free `string` because the
   * value is the concrete (un-templated) path, so no finite union can match it
   * at runtime.
   */
  route: string
  /** HTTP status returned to the caller. */
  status: number
  /** Caller's source IP (from ConnectInfo). */
  remoteIp: string
  /** Optional context — task id for run, event type for events. */
  detail?: string
}

// ---------------------------------------------------------------------------
// Wire shapes for the events emitted from Rust → frontend.
// The receiver provider re-dispatches into the scheduler.
// ---------------------------------------------------------------------------

export interface TriggerTaskRequest {
  taskId: string
  /** Optional one-shot payload override applied on top of the stored task payload. */
  payload?: Record<string, unknown>
}

export interface EmitEventRequest {
  /** Free-form string — usually a `SchedulerEventType`, but `"custom"` + arbitrary names are allowed. */
  eventType: SchedulerEventType | string
  /** Optional source filter — task triggers only fire when their `eventSource` matches. */
  eventSource?: string
  data?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Inbound command model (generic dispatch — see the ADR-0005 activation spec).
// Rust authenticates + emits one generic `remote-control://command` event; the
// renderer's dispatch registry routes by `target` into each subsystem's
// existing headless run entry.
// ---------------------------------------------------------------------------

export type RemoteCommandTarget =
  | "scheduler.task.run"
  | "scheduler.event"
  | "workflow.run"
  | "workflow.cancel"
  | "goal.create"
  | "goal.continue"
  | "goal.pause"
  | "goal.resume"
  | "goal.stop"
  | "team.dispatch"
  | "team.stop"
  | "plan.run"
  | "chat.send"
  | "connector.send"
  | "terminal.exec"
  | "plugin.enable"
  | "plugin.disable"

export const REMOTE_COMMAND_TARGETS: readonly RemoteCommandTarget[] = [
  "scheduler.task.run",
  "scheduler.event",
  "workflow.run",
  "workflow.cancel",
  "goal.create",
  "goal.continue",
  "goal.pause",
  "goal.resume",
  "goal.stop",
  "team.dispatch",
  "team.stop",
  "plan.run",
  "chat.send",
  "connector.send",
  "terminal.exec",
  "plugin.enable",
  "plugin.disable",
]

export function isRemoteCommandTarget(value: string): value is RemoteCommandTarget {
  return (REMOTE_COMMAND_TARGETS as readonly string[]).includes(value)
}

/**
 * Targets that cause model-cost or outbound (off-device) side effects. The
 * inbound server additionally requires `RemoteControlInboundConfig
 * .allowSensitiveTargets = true` to dispatch these — a config-gated guardrail
 * beyond the binary read/write capability. Mirrors `SENSITIVE_TARGETS` in
 * `src-tauri/src/remote_control/server.rs`.
 */
export const SENSITIVE_REMOTE_COMMAND_TARGETS: readonly RemoteCommandTarget[] = [
  "chat.send",
  "connector.send",
  "goal.create",
  // Runs an arbitrary shell command on the host (under the unattended-execution
  // safety classifier + master switch). Highest-blast-radius target — gated
  // behind `allowSensitiveTargets` on top of the `write` capability.
  "terminal.exec",
]

export function isSensitiveRemoteCommandTarget(value: string): boolean {
  return (SENSITIVE_REMOTE_COMMAND_TARGETS as readonly string[]).includes(value)
}

/**
 * Group the command targets by subsystem (the segment before the first dot).
 * Preserves the declaration order of {@link REMOTE_COMMAND_TARGETS} both for
 * the group ordering and within each group, so the per-target permission UI
 * renders deterministically. Pure — safe for both UI and tests.
 */
export function groupRemoteCommandTargets(): Array<{
  group: string
  targets: RemoteCommandTarget[]
}> {
  const order: string[] = []
  const byGroup = new Map<string, RemoteCommandTarget[]>()
  for (const target of REMOTE_COMMAND_TARGETS) {
    const group = target.split(".")[0]
    if (!byGroup.has(group)) {
      byGroup.set(group, [])
      order.push(group)
    }
    byGroup.get(group)!.push(target)
  }
  return order.map((group) => ({ group, targets: byGroup.get(group)! }))
}

/**
 * True when `target` is dispatchable given the inbound denylist. Mirrors the
 * Rust `run_command` gate: a target present in `disabledTargets` is rejected
 * with `403 target_disabled`. Used by the renderer dispatch guard + the UI.
 */
export function isRemoteCommandTargetEnabled(
  disabledTargets: readonly string[] | undefined,
  target: string
): boolean {
  return !disabledTargets || !disabledTargets.includes(target)
}

/** Wire shape emitted by the Rust `/api/v1/commands/:target` route. */
export interface RemoteCommand {
  target: RemoteCommandTarget
  /** Free-form args; each handler validates its own required shape. */
  args: Record<string, unknown>
  /** Server-generated correlation id, echoed in the 202 body. */
  runId: string
  /** Optional caller-supplied dedupe key (Idempotency-Key header). */
  idempotencyKey?: string
}

export type RemoteCommandResultStatus = "accepted" | "rejected" | "replayed"

export interface RemoteCommandResult {
  runId: string
  status: RemoteCommandResultStatus
  detail?: string
}

/**
 * Renderer-only extension of {@link RemoteCommandResult}. `settle` is a
 * NON-SERIALIZED promise the dispatch handler attaches for long-running
 * targets; it resolves at the run's terminal point so the receiver can advance
 * the `remoteControlRunStatus` projection past `accepted`. It never crosses the
 * Tauri/HTTP boundary — the 202 + dispatch ack already went out by the time it
 * resolves.
 */
export interface RemoteCommandDispatchResult extends RemoteCommandResult {
  settle?: Promise<RemoteCommandSettleOutcome>
}

export interface RemoteCommandSettleOutcome {
  status: RemoteControlRunStatusValue
  detail?: string
}

// ---------------------------------------------------------------------------
// Read surface (GET) — the inbound server round-trips a read to the renderer.
// Rust emits `remote-control://query`; the renderer answers via the
// `remote_control_query_response` command. `targets` is answered natively in
// Rust and never reaches the renderer.
// ---------------------------------------------------------------------------

export type RemoteControlQueryKind =
  | "tasks"
  | "workflow.runs"
  | "goals"
  | "audit"
  | "run.status"
  | "teams"
  | "team"
  | "workflows"
  | "plugins"
  | "connectors"
  | "backups"
  | "ocr.cache"
  | "runs"
  | "messages"

export const REMOTE_CONTROL_QUERY_KINDS: readonly RemoteControlQueryKind[] = [
  "tasks",
  "workflow.runs",
  "goals",
  "audit",
  "run.status",
  "teams",
  "team",
  "workflows",
  "plugins",
  "connectors",
  "backups",
  "ocr.cache",
  "runs",
  "messages",
]

/** Wire shape emitted on `remote-control://query`. */
export interface RemoteControlQueryEvent {
  /** Server-generated correlation id; echoed back to resolve the round-trip. */
  requestId: string
  /** Which read to run. Forward-compatible: unknown kinds answer with an error. */
  kind: RemoteControlQueryKind | string
  /** Per-kind params (e.g. `{ workflowId }`, `{ sessionId }`). */
  params?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Token capability (Tailscale-style read/write split; single token in v1).
// ---------------------------------------------------------------------------

export type TokenCapability = "read" | "write"

export const DEFAULT_TOKEN_CAPABILITY: TokenCapability = "write"

// ---------------------------------------------------------------------------
// Outbound egress (Standard Webhooks).
// ---------------------------------------------------------------------------

export interface WebhookEgressEndpoint {
  id: string
  name: string
  url: string
  /** Extra headers merged onto every delivery to this endpoint. */
  headers: RemoteControlOutboundHeader[]
  enabled: boolean
  /**
   * Event-type subscription filter (GitHub/Svix-style). When omitted or empty,
   * the endpoint receives every published event. Otherwise it only receives
   * events whose `eventType` is in this list. Matched by exact string.
   */
  eventTypes?: string[]
}

/**
 * Known outbound lifecycle event types offered as subscription checkboxes. The
 * scheduler webhook channel emits these (`TaskEventType`) through
 * `publishOutboundEvent`; other subsystems may publish additional free-form
 * types, so subscription matching stays string-based rather than a closed enum.
 */
export const OUTBOUND_EVENT_TYPES: readonly string[] = [
  "start",
  "progress",
  "complete",
  "error",
  "auto-paused",
] as const

/**
 * True when `endpoint` should receive an event of `eventType`. An endpoint with
 * no subscription filter (undefined / empty) receives everything.
 */
export function endpointSubscribesTo(endpoint: WebhookEgressEndpoint, eventType: string): boolean {
  const subs = endpoint.eventTypes
  if (!subs || subs.length === 0) return true
  return subs.includes(eventType)
}

export type WebhookSignatureScheme = "standard-webhooks"

export interface OutboundWebhookEvent {
  /** Stable id; becomes the `webhook-id` header (held constant across retries). */
  id: string
  eventType: string
  /** Originating subsystem: "scheduler" | "goal" | "workflow" | "team" | "plan". */
  source: string
  payload: Record<string, unknown>
  /** ISO-8601. */
  occurredAt: string
}

// ---------------------------------------------------------------------------
// Durable audit (privileged-control-plane requirement). Backed by the Dexie
// `remoteControlAudit` table (schema v72).
// ---------------------------------------------------------------------------

export type RemoteControlAuditDirection = "inbound" | "outbound"

export type RemoteControlAuditKind =
  | "inbound.command"
  | "inbound.rejected"
  | "inbound.replayed"
  | "outbound.delivered"
  | "outbound.failed"

export interface RemoteControlAuditEntry {
  id: string
  /** epoch ms. */
  at: number
  direction: RemoteControlAuditDirection
  kind: RemoteControlAuditKind
  target?: RemoteCommandTarget
  runId?: string
  result?: RemoteCommandResultStatus | "delivered" | "failed"
  remoteIp?: string
  idempotencyKey?: string
  capability?: TokenCapability
  endpointId?: string
  httpStatus?: number
  /** Redaction-aware structured payload (PII-gated before write). */
  fields?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Run-status projection (result-loop closure). Backed by the Dexie
// `remoteControlRunStatus` table (schema v92). Keyed by the server-issued
// `runId` so `GET /api/v1/runs/:runId` can report a command's outcome.
// ---------------------------------------------------------------------------

export type RemoteControlRunStatusValue =
  | "accepted" // dispatched, no terminal signal yet
  | "rejected" // handler refused (bad args / not found / PII block)
  | "replayed" // idempotency-cache replay
  | "running" // a terminal-aware subsystem reports the run is live
  | "succeeded"
  | "failed"
  | "cancelled"

export interface RemoteControlRunStatusRow {
  /** Server-issued correlation id (primary key). */
  runId: string
  target: RemoteCommandTarget
  status: RemoteControlRunStatusValue
  /** Short human-readable detail (the dispatch result's `detail`). */
  detail?: string
  /**
   * Subsystem-internal id this remote run maps to (e.g. the `goalId` for a
   * `goal.create`), set once the underlying runtime hands one back. Lets the
   * `GET /api/v1/runs/:runId` read derive a live terminal status from the
   * authoritative subsystem table — the same trick `workflow.run` uses via the
   * shared `runId` in `workflowRuns`. NON-INDEXED (no Dexie version bump); old
   * rows simply lack it.
   */
  correlationId?: string
  /** epoch ms — first stamp (dispatch time). */
  startedAt: number
  /** epoch ms — most recent stamp. */
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default loopback port. Picked outside the IANA registered range, matches no common service. */
export const DEFAULT_REMOTE_CONTROL_PORT = 47821

export const DEFAULT_REMOTE_CONTROL_ALLOWLIST: string[] = ["127.0.0.1/32"]

export const DEFAULT_REMOTE_CONTROL_RATE_LIMIT_PER_MIN = 60

export const DEFAULT_REMOTE_CONTROL_CONFIG: RemoteControlConfig = {
  inbound: {
    enabled: false,
    port: DEFAULT_REMOTE_CONTROL_PORT,
    allowlist: [...DEFAULT_REMOTE_CONTROL_ALLOWLIST],
    rateLimitPerMin: DEFAULT_REMOTE_CONTROL_RATE_LIMIT_PER_MIN,
    capability: DEFAULT_TOKEN_CAPABILITY,
    allowSensitiveTargets: false,
    disabledTargets: [],
  },
  outbound: {
    hasSigningSecret: false,
    defaultHeaders: [],
    endpoints: [],
    delivery: { ...DEFAULT_WEBHOOK_DELIVERY },
  },
}

/** Maximum number of inbound calls retained in the Overview tab's ring buffer. */
export const REMOTE_CONTROL_RECENT_CALLS_LIMIT = 20

/**
 * Validator for the IP allowlist input. Accepts a bare IPv4 address or an
 * IPv4 CIDR (`a.b.c.d` or `a.b.c.d/N`). Returns an i18n key on failure, or
 * `null` when the value is acceptable.
 *
 * Kept i18n-key-shaped so callers can pass it through the existing
 * domain-list-input `validate` prop without leaking translator dependencies.
 */
export function validateCidrOrIp(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return "settings.remoteControl.inbound.allowlistEmpty"
  const cidrMatch = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(trimmed)
  if (!cidrMatch) return "settings.remoteControl.inbound.allowlistInvalid"
  const [, a, b, c, d, prefix] = cidrMatch
  for (const octet of [a, b, c, d]) {
    const n = Number(octet)
    if (n < 0 || n > 255) return "settings.remoteControl.inbound.allowlistInvalid"
  }
  if (prefix !== undefined) {
    const n = Number(prefix)
    if (n < 0 || n > 32) return "settings.remoteControl.inbound.allowlistInvalid"
  }
  return null
}

/** True when the CIDR / IP refers strictly to the loopback range. */
export function isLoopbackAllowlistEntry(entry: string): boolean {
  const trimmed = entry.trim()
  return trimmed === "127.0.0.1" || trimmed === "127.0.0.1/32"
}
