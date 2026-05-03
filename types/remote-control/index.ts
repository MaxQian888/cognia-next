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
  /** Which endpoint was hit. */
  route: "/api/v1/health" | "/api/v1/tasks/:id/run" | "/api/v1/events"
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
  },
  outbound: {
    hasSigningSecret: false,
    defaultHeaders: [],
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
