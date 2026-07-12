/**
 * Row shape for `inboxTelemetryEvents` (Dexie schema v49).
 *
 * Lives in a separate `*-types.ts` file so `lib/db/schema.ts` can import the
 * row type without pulling in the CRUD module (and its dependency on
 * `connector-audit`-style ring-buffer transactions). The CRUD module
 * (`./inbox-telemetry.ts`) re-exports this type for ergonomic callers.
 *
 * Telemetry events are breadcrumbs, not analytics: stored locally in a
 * 3000-row ring buffer that rotates fastest first. The `Settings →
 * Diagnostics → Export inbox telemetry` button serializes the table via the
 * same CSV/JSON pipeline used by the connector audit log.
 */

/**
 * Discriminator union for the six emit sites the breadcrumb layer covers.
 *
 *   • `inbound.received`   — `ConnectorBus.dispatchInboundFull` after dedup.
 *   • `outbound.sent`      — `outbound-runner` on successful delivery.
 *   • `outbound.failed`    — `outbound-runner` on terminal failure / retry.
 *   • `breaker.open`       — `circuit-breaker` on open transition.
 *   • `breaker.close`      — `circuit-breaker` on close (recovery).
 *   • `quiet.deferred`     — `outbound-runner` defers a job for quiet hours.
 *   • `a2ui.downgrade`     — `a2ui-bridge/a2ui-to-segments` falls back to plainTextMirror.
 */
export type InboxTelemetryKind =
  | "inbound.received"
  | "outbound.sent"
  | "outbound.failed"
  // Circuit-open failover: `outbound-runner` re-enqueued a job through a
  // sibling bot. `fields` carries `toAdapterId` + `newJobId`.
  | "outbound.failover"
  // Rate-limit spillover: `outbound-runner` re-enqueued a job through a
  // less-loaded sibling bot. `fields` carries `toAdapterId` + `newJobId`.
  | "outbound.balanced"
  | "breaker.open"
  | "breaker.close"
  | "quiet.deferred"
  | "a2ui.downgrade"

/**
 * One row in the `inboxTelemetryEvents` table. Same shape across every
 * kind; `fields` carries per-kind payload (latency for `outbound.sent`,
 * error code for `outbound.failed`, platform + reason for `a2ui.downgrade`).
 */
export interface InboxTelemetryEventRow {
  /** Primary key — unique random id per insert. */
  id: string
  /** Event kind discriminator. */
  kind: InboxTelemetryKind
  /** Epoch ms when the event was recorded. */
  at: number
  /** Adapter the event is associated with; undefined for cross-adapter events. */
  adapterId?: string
  /** Conversation key the event is associated with; undefined when not applicable. */
  conversationKey?: string
  /** Free-form per-kind payload. Persisted as-is; do not store secrets. */
  fields?: Record<string, unknown>
}
