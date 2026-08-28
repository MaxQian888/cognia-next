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
//      the same name in `KNOWN_COMMANDS` AND one of the per-domain modules
//      under `src-tauri/src/companion_api/rpc/` (`data_sync.rs` for the
//      bridged desktop writes) has a `match` arm that routes it to a real
//      handler. Drift here surfaces as 404 unknown_command when the queue
//      runner drains.
//   3. The TS-side dispatch lives either in `lib/companion/desktop-write-source.ts`
//      (mutations against desktop Dexie) or in a direct Tauri command
//      (`claude_*`, `read_agent_config`, etc.).
//   4. Idempotency: the row's `idempotencyKey` is minted ONCE at enqueue and
//      reused on every retry (`Idempotency-Key` header → Rust ledger replay).
//      Commands whose host arm has its own dedupe (ADR-0131 inbox relay:
//      `connector_enqueue_outbound` on `outboundQueue.idempotencyKey`,
//      `connector_approve_draft` on draft status) MUST be enqueued with the
//      SAME key the arm dedupes on — see `lib/connectors/inbox-writes/remote.ts`.
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
  // ADR-0131 cross-shell inbox relay (`lib/connectors/inbox-writes/remote.ts`):
  // a thin client's manual reply → the host's governed outboundQueue
  // (`connector_send` only appends a local user message; it never delivers),
  // and every Inbox override control (mode / assignee / pin / archive /
  // label / status / computer-use / model) → the host's authoritative
  // `conversationOverrides` row.
  "connector_enqueue_outbound",
  "conversation_overrides_update",
  // Workflow subsystem (mobile trigger button + delete mirror + schedule
  // pause/resume from the row-actions sheet).
  "workflow_trigger_manual",
  "workflow_delete",
  "workflow_schedule_pause",
  "workflow_schedule_resume",
  // Durable result chunks for Host-issued interactive mobile steps. The same
  // request/sequence key is replayed until the Host acknowledges the chunk.
  "workflow_step_result",
  // Twin subsystem (twin-sources + twin-drafts panels).
  "twin_ingest_source",
  "twin_source_create",
  "twin_source_delete",
  "twin_draft_review",
  // Wave 2 desktop-write mutating RPCs.
  "character_upsert",
  "character_delete",
  "character_bind_twin",
  "skill_set_enabled",
  "plugin_set_enabled",
  // MCP servers (ADR-0056 Wave 4 follow-up): a paired client can flip a
  // server on/off and rewrite its per-tool deny rules. Creating, editing and
  // deleting a definition stays desktop-only — those carry credentials and a
  // trust decision, neither of which belongs on the wire.
  "mcp_set_enabled",
  "mcp_set_tool_rules",
  "adapter_update_policy",
  "app_settings_update",
  // Long-term memory mutations — mobile edits must reach the desktop
  // authority instead of only changing the offline sync mirror.
  "memory_update",
  "memory_forget",
  // External agents (ADR-0056, Wave 4) — enable/disable + permission-mode edit.
  "external_agent_update",
  // Host-owned external-agent configurations (head + revision store in
  // Dexie). Distinct from `external_agent_update`, which edits the desktop's
  // own localStorage configs; these are the ones a paired browser runs against.
  "external_agent_config_create",
  "external_agent_config_delete",
  "external_agent_config_reconcile",
  "external_agent_config_update",
  // HostStateProtocol — the same durable queue now carries attached-client
  // session intents from Web, Mobile, Desktop, and TUI adapters.
  "host_state_submit",
  // ADR-0149 collaboration-plane writes. These are drained by the collab
  // dispatcher, not Companion RPC, but intentionally share this durable queue.
  "collab_issue_create",
  "collab_issue_patch",
  "collab_issue_append_event",
  "collab_plan_create",
  "collab_plan_patch",
  "collab_run_create",
  "collab_run_patch",
] as const

export type MobileOutboundCommand = (typeof MOBILE_OUTBOUND_COMMANDS)[number]

/**
 * `"failed"` is **never written**. `recordFailure` is the only writer of a
 * post-dispatch status and it stores `decideNextAttempt`'s verdict, which is
 * `"pending"` (retry scheduled) or `"deadlettered"` (out of retries). The
 * member survives so rows persisted by a build that did write it still parse;
 * nothing may treat it as a lane the queue can enter.
 */
export type MobileOutboundStatus =
  "pending" | "sending" | "sent" | "failed" | "deadlettered" | "rejected" | "conflicted"

export interface MobileOutboundJobRow {
  /** UUIDv4 primary key. */
  id: string
  /** Local account that created the row. Never inferred at dispatch time. */
  accountId: string
  /** Runtime target that must receive the row. */
  targetId: string
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
  /**
   * When `claimNext` flipped this row to `sending`.
   *
   * Lets a startup reclaim tell a claim abandoned by a killed process from one
   * a concurrently running dispatcher is still awaiting. Absent on rows claimed
   * before this field existed, which are treated as abandoned.
   */
  claimedAt?: number
  /** Absent on v25-v167 rows, which are interpreted as legacy RPC jobs. */
  protocol?: "legacy-rpc" | "host-state" | "collab-v1"
  channel?: string
  hostGeneration?: number
  clientId?: string
  clientSeq?: number
  actionId?: string
  baseRevision?: number
  rejectionCode?: string
  currentRevision?: number
  /** Server-authoritative resource retained for a manual 409 rebase/discard UI. */
  conflictAuthoritative?: unknown
}
