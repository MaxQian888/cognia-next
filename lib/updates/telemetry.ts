/**
 * Privacy-safe update telemetry.
 *
 * What is recorded is fixed by this type, not by the call sites, so a future
 * adapter cannot smuggle release notes, download headers, proxy details or
 * user content into the event stream. Everything here is either an enum, a
 * version string, or a count.
 */

import type {
  UpdateAssetKind,
  UpdateChannel,
  UpdateErrorKind,
  UpdateExecutor,
  UpdateState,
} from "@cognia/agent-config-types"

export interface UpdateTelemetryEvent {
  attemptId: string
  kind: UpdateAssetKind
  executor: UpdateExecutor
  channel: UpdateChannel
  fromVersion: string | null
  toVersion: string | null
  phase: UpdateState
  /** Milliseconds spent in the phase that just ended. */
  durationMs?: number
  bytes?: number
  outcome: "started" | "succeeded" | "failed" | "cancelled" | "handed-off"
  /** Stable error family. Never a raw message. */
  errorKind?: UpdateErrorKind
  /** Stable error code. Never a raw message. */
  errorCode?: string
}

export type UpdateTelemetrySink = (event: UpdateTelemetryEvent) => void

const FORBIDDEN_KEYS = new Set(["releaseNotes", "url", "externalUrl", "headers", "proxy", "body"])

/**
 * Strip anything the contract does not name. Defence in depth for adapters
 * that build events dynamically.
 */
export function sanitizeTelemetryEvent(event: UpdateTelemetryEvent): UpdateTelemetryEvent {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event)) {
    if (FORBIDDEN_KEYS.has(key)) continue
    if (value === undefined) continue
    out[key] = value
  }
  return out as unknown as UpdateTelemetryEvent
}

/** Correlation id for one install attempt. Random, not derived from identity. */
export function newAttemptId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === "function") return c.randomUUID()
  return `att_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}
