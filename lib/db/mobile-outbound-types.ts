// Mobile outbound queue row shapes (Wave 2.1, schema v25).
//
// One row per write operation enqueued from the phone — chat sends, draft
// approvals, workflow triggers, twin ingests — that needs to round-trip
// to the desktop server via `transport.call()`. Lives in its own table
// (`mobileOutboundQueue`) so the connector outbound queue stays decoupled.
//
// SINGLE SOURCE OF TRUTH for the mobile outbound command surface. Every
// entry below MUST satisfy three invariants:
//   1. At least one production UI surface enqueues it (grep `enqueue\({`
//      across components/mobile + app/share-target).
//   2. The Rust RPC dispatcher (`src-tauri/src/companion_api/rpc.rs`) lists
//      the same name in `KNOWN_COMMANDS` AND has a `match` arm that routes
//      it to a real handler. Drift here surfaces as 404 unknown_command
//      when the queue runner drains.
//   3. The TS-side dispatch lives either in `lib/companion/desktop-write-source.ts`
//      (mutations against desktop Dexie) or in a direct Tauri command
//      (`claude_*`, `read_agent_config`, etc.).
//
// Audit-pass 2026-05-17 trimmed `session_send` / `session_delete` /
// `session_pin` / `session_mute` / `backup_export` / `rpc_generic` from the
// list — none had a production UI enqueue site, and `message_send` covers
// the chat-send path. Re-add an entry here ONLY together with its UI
// trigger, RPC dispatch arm, and handler.
export const MOBILE_OUTBOUND_COMMANDS = [
  // Connector subsystem (share-target + draft approval panel).
  "connector_send",
  "connector_approve_draft",
  "connector_reject_draft",
  // Workflow subsystem (mobile trigger button).
  "workflow_trigger_manual",
  // Twin subsystem (twin-sources + twin-drafts panels).
  "twin_ingest_source",
  // Wave 2 desktop-write mutating RPCs.
  "character_upsert",
  "character_delete",
  "character_bind_twin",
  "skill_set_enabled",
  "plugin_set_enabled",
  "adapter_update_policy",
  "app_settings_update",
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
