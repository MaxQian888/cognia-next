// Mobile outbound queue row shapes (Wave 2.1, schema v25).
//
// One row per write operation enqueued from the phone — chat sends, draft
// approvals, workflow triggers, twin ingests, backup exports — that needs
// to round-trip to the desktop server via `transport.call()`. Lives in its
// own table (`mobileOutboundQueue`) so the connector outbound queue stays
// decoupled.

export const MOBILE_OUTBOUND_COMMANDS = [
  "connector_send",
  "connector_approve_draft",
  "connector_reject_draft",
  "workflow_trigger_manual",
  "twin_ingest_source",
  "backup_export",
  "session_send",
  "session_delete",
  "session_pin",
  "session_mute",
  // Wave 2 mutating RPCs that the phone may queue while offline.
  "character_upsert",
  "character_delete",
  "character_bind_twin",
  "skill_set_enabled",
  "plugin_set_enabled",
  "adapter_update_policy",
  "app_settings_update",
  "rpc_generic",
] as const

export type MobileOutboundCommand = (typeof MOBILE_OUTBOUND_COMMANDS)[number]

export type MobileOutboundStatus = "pending" | "sending" | "sent" | "failed" | "deadlettered"

export interface MobileOutboundJobRow {
  /** UUIDv4 primary key. */
  id: string
  /** Mapped to the `_rpc/<command>` endpoint on the desktop server. */
  command: MobileOutboundCommand
  /** Forwarded as the JSON body of the RPC call. */
  payload: Record<string, unknown>
  status: MobileOutboundStatus
  attempts: number
  /** Last error message — surfaced in the offline-banner / deadletter view. */
  lastError?: string
  /** Epoch ms of original enqueue. */
  createdAt: number
  /** Epoch ms at which the runner is allowed to retry. */
  nextAttemptAt: number
  /**
   * Idempotency key — replayed if the row is retried and the desktop has a
   * cached result. Enables exactly-once semantics under flaky network.
   */
  idempotencyKey: string
  /**
   * Free-form human label rendered in the queue UI. Examples:
   *   "Send to Slack #general"
   *   "Approve Connector draft #abc"
   *   "Trigger workflow Daily Digest"
   */
  label?: string
}
