// Dexie row shapes for the Platform Connector tables added in schema v18.
//
// Kept minimal here so the Dexie schema bump can land before the full
// lib/connectors/ port: each row carries only the columns its index
// references plus free-form blobs for everything else. The connector
// runtime treats these rows as authoritative; richer domain-specific
// validation is applied at the CRUD layer (lib/db/adapter-instances.ts, etc.)
//
// Why row types live here instead of `types/connectors/`:
//   * matches the convention set by `lib/db/plugin-types.ts`,
//     `lib/db/canvas-types.ts`, and `lib/db/a2ui-types.ts` — Dexie row
//     shapes co-locate with the schema, full domain types live elsewhere.
//   * keeps `lib/db/schema.ts` from depending on `types/connectors/*` until
//     those types are fully stabilised.

import type {
  AgentAuthority,
  AutonomyLevel,
  EngagementMode,
} from "@cognia/agent-config-types/agent-composition"
import type { MediaModelGrant } from "@/lib/connectors/media-model-gate"
import type { OutboundRequest } from "@/types/connectors/outbound"
import type {
  ActiveRunDispatchMode,
  DeliveryReadiness,
  InboundActivationPolicy,
  TriggerPolicy,
  ConnectorMode,
} from "@/types/connectors/policy"
import type {
  ConversationDeliveryTarget,
  ConversationReference,
  NormalizedInboundEvent,
  PlatformIdentity,
} from "@/types/connectors/event"
import type { AuditEntry } from "@/types/connectors/audit"
import type { EscalationPolicy } from "@/types/connectors/escalation"
import type { MessageSegment } from "@/types/connectors/segment"
import type { ConnectorCallbackBindingRow } from "@/types/connectors/interaction"
export type {
  AdapterImplMetadata,
  AdapterInstanceRow,
  AdapterPluginProvenance,
  AdapterSelfIdentitySnapshot,
  DispatchRule,
  DispatchRuleAction,
  DispatchRuleMatch,
  ImHostCapabilityId,
  MediaModelPolicy,
  OutboundJobRow,
  OutboundJobSource,
  OutboundJobStatus,
  OutboundJobWorkflowSource,
  OutboundTuningConfig,
} from "@cognia/plugin-contract/lib/db/connector-types"

export type { ConnectorCallbackBindingRow }

/**
 * One row per observed platform user. Extends the canonical PlatformIdentity
 * shape with a `lastSeenAt` timestamp used for stale-identity cleanup.
 */
export interface PlatformIdentityRow extends PlatformIdentity {
  /** Last time we observed this identity; helps cleanup. */
  lastSeenAt: number
  /**
   * Last time any writer changed the row (companion-sync cursor). `lastSeenAt`
   * is an observation stamp, so a merge or unmerge that rewrites the tree
   * without a sighting leaves it untouched, and a paired client would keep the
   * old tree forever. Non-indexed on purpose: the directory is scanned whole by
   * `upsertIdentity` already, and an index would cost a schema reset. Rows
   * written before this field existed fall back to `lastSeenAt`.
   */
  updatedAt?: number
  /**
   * Lossless merge history (CRM, schema v83 — non-indexed blob, no migration).
   * Each `mergeIdentities` call snapshots the absorbed secondary row here so
   * `unmergeIdentity` can restore it exactly. Parallel to `mergedFromIds`
   * (which keeps just the ids for quick membership checks).
   */
  mergedSnapshots?: PlatformIdentityRow[]
  /**
   * User-authored relationship to this contact ("my manager", "close friend"),
   * read by the IM reply copilot (ADR-0194) as always-on knowledge. Non-indexed
   * — no schema bump; merges carry it in `mergedSnapshots` like every other
   * field. Written only on the host (`updateIdentityProfile`).
   */
  relationship?: string
  /** User-authored note about this contact, same rules as `relationship`. */
  note?: string
}

/**
 * Dedup ledger row. Originally one row per received inbound message; v38
 * widened the table with a `namespace` field so the same dedup machinery
 * can serve any sliding-window dedup case (inbound messages, connector
 * callbacks, future webhook receivers, etc.) without proliferating tables.
 *
 * Rows persisted before v38 carry `namespace === "inbound"` (set by the
 * v38 upgrade hook). Newly-inserted rows always set namespace explicitly.
 *
 * Keyed `${adapterId}:${namespace}:${platformMessageId}` for new rows;
 * pre-v38 rows keep the original `${adapterId}:${platformMessageId}` id
 * — the row is queryable either way via the compound index.
 */
/**
 * `"outbound"` is the delivered-message ledger (`lib/connectors/delivered-messages.ts`):
 * platform ids WE sent, scoped by conversation, consulted by the exact
 * `reply-to-bot` trigger rule. `"landed-chat"` rows record a platform chat
 * the host's deliveries through a conversation landed in (same module); they
 * are never pruned.
 */
export type InboundLedgerNamespace = "inbound" | "callback" | "welcome" | "outbound" | "landed-chat"

export interface InboundLedgerRow {
  /** `${adapterId}:${namespace}:${platformMessageId}` (or legacy form). */
  id: string
  adapterId: string
  /** Sliding-window namespace; defaults to `"inbound"` for legacy rows. */
  namespace: InboundLedgerNamespace
  platformMessageId: string
  receivedAt: number
}

/**
 * Operator-configured workflow run fan-out: "every run of workflow X
 * mirrors progress to channel Y". Bound to `workflowId` (static rule —
 * covers all future runs). One row per `(workflowId, adapterId,
 * conversationKey)` triple; the writer enforces the uniqueness because
 * Dexie doesn't support multi-column unique constraints.
 *
 * Originator channels are NOT stored here — the run's `triggeredBy`
 * carries that. The progress-runner dedupes at watcher creation when an
 * originator overlaps with a subscription so the user sees one card per
 * conversation.
 *
 * Added in schema v55.
 */
export interface WorkflowFanoutSubscriptionRow {
  id: string
  workflowId: string
  adapterId: string
  conversationKey: string
  enabled: boolean
  /**
   * Audit-only provenance — the UI flow it was created through. Free-form
   * string so plugins can stamp their own value.
   */
  createdBy: "settings-ui" | "claude-tool" | string
  createdAt: number
  updatedAt: number
}

/**
 * Per-conversation settings that override the adapter-level defaults.
 * Keyed by `conversationKey` (unique constraint `&conversationKey`).
 */
export interface ConversationOverrideRow {
  id: string
  conversationKey: string
  /**
   * Explicit, revocable permission to send this conversation's raw binary
   * media to a model. Absent (the norm) means the adapter's
   * `mediaModelPolicy` applies, which defaults to local-extract-only.
   *
   * Provider-scoped: allowing a local vision model to see an image is a
   * different decision from uploading it to a third party, and the grant must
   * not silently transfer when the conversation's provider changes. Revoked by
   * deleting the field; expires on its own via `expiresAt`.
   *
   * Non-indexed additive — no Dexie bump. Resolved by
   * `lib/connectors/media-model-gate.ts:resolveMediaModelPolicy`.
   */
  mediaModelGrant?: MediaModelGrant
  /**
   * Owning workspace id — Workspace isolation column (Dexie v86). Per-project
   * routing state; `conversationKey` stays the globally-unique primary key
   * (one conversation maps to one workspace), so this is a plain filter index.
   */
  projectId?: string
  /** The cognia-next ChatSession this conversation maps to. */
  sessionId: string
  mode?: ConnectorMode
  /** Optional topic/channel-specific override of the adapter admission policy. */
  inboundActivationPolicy?: InboundActivationPolicy
  /** Optional topic/channel-specific override of the adapter active-run policy. */
  activeRunDispatchMode?: ActiveRunDispatchMode
  /** Topic-specific sliding activation lifetime override. */
  activationTtlMs?: number
  characterId?: string
  /** Explicitly suppress rule/adapter Character inheritance for this conversation. */
  characterDisabled?: boolean
  trigger?: Partial<TriggerPolicy>
  pinned?: boolean
  archived?: boolean
  /** Last-read pointer; in tandem with the existing sessionState table. */
  lastReadAt?: number
  /**
   * Per-conversation opt-in for Anthropic native Computer Use tools.
   * G6 default for IM-channel conversations is "no" — operators MUST
   * flip this true explicitly so a Telegram/Discord/Slack reply cannot
   * accidentally fire screenshot / mouse / keyboard actions on the host.
   */
  allowComputerUse?: boolean
  /**
   * Per-conversation gate for the OCR agent tool in IM-channel conversations.
   * Unlike `allowComputerUse` (default-deny), OCR is low-risk and default-allow:
   * inbound images are routinely worth reading, so the tool stays available
   * unless an operator sets this `false` to suppress it for a conversation.
   */
  allowOcr?: boolean
  /**
   * Per-conversation A2UI switch. `undefined` inherits the bot's
   * `a2uiEnabled`, which in turn defaults to "whatever this channel supports".
   * `false` is how a chat that wants plain text says so.
   *
   * Non-indexed additive — no Dexie bump.
   */
  a2uiEnabled?: boolean
  /**
   * Per-conversation opt-in for the self-driving `/goal` command (v49
   * inbox optimization). Mirrors `allowComputerUse` exactly in shape and
   * semantics: when this row is bound to an IM platform (the parent
   * session carries `platformBinding`), `GoalRuntime.createGoal` MUST
   * reject the goal unless this flag is `true`. The block fires a
   * `goal.blocked.im` audit row; opt-in goals fire `goal.started.im` so
   * the operator can audit self-driving goals running in inbox sessions.
   * Direct (non-IM) sessions ignore this field — the goal subsystem
   * gates only on the presence of an IM binding.
   */
  allowGoalDriving?: boolean
  /**
   * Per-conversation opt-in for agent-facing scheduler MCP tools.
   * Default OFF: an inbound prompt cannot create recurring work unless the
   * operator explicitly enables this conversation.
   */
  allowScheduleTools?: boolean
  /**
   * Per-conversation provider override (added at schema v41 in support
   * of A6). When set, takes precedence over the character / app default
   * provider in `lib/claude/build-options.ts:resolveSendOptions`. Use
   * for "this Telegram channel always routes to Codex, this Slack
   * workspace routes to OpenCode" kinds of overrides. Validation lives
   * at the CRUD layer; an unknown providerId here is treated as "no
   * override" by the resolver to avoid hard-failing sends.
   */
  providerOverride?: string
  /**
   * Per-conversation model override (added at schema v41 in support
   * of A6). When set, takes precedence over the character / app default
   * model. Independent of `providerOverride` — operators MAY set just
   * the model (e.g., "always use gpt-5 on this channel, regardless of
   * which Codex account is currently active") without changing provider.
   */
  modelOverride?: string
  /**
   * Per-conversation reasoning-effort ("thinking level") override
   * (control-plane completion). Set by the `/reasoning <level>` in-chat
   * command. Takes precedence over `session.effort` and
   * `AppSettings.defaultEffort` in `lib/claude/build-options.ts`. Non-indexed
   * additive field — no schema bump. Unknown levels are rejected at the
   * command layer, so the resolver can trust a stored value.
   */
  reasoningOverride?: "low" | "medium" | "high" | "xhigh" | "max"
  /**
   * Pointer to the currently-active ChatSession for this IM conversation
   * (control-plane multi-session). Set by `/new` and `/switch`; consulted by
   * `findActiveSessionForConversation` so AI turns target the session the
   * user switched to. Undefined → fall back to the most-recently-updated
   * bound session (today's behaviour). Non-indexed — looked up via the unique
   * `conversationKey`.
   */
  activeSessionId?: string
  /**
   * Per-conversation Agent Team binding (control-plane multi-agent). When set,
   * an inbound AI-run dispatches to the team runtime (`runTeamLifecycle`) via
   * `lib/connectors/team-dispatch.ts` instead of the single-character
   * `runAndCapture` path. Coexists with `characterId` (which still seeds the
   * session identity/title); `teamId` wins routing. Bound via `/team` or the
   * inbox responder selector; `/team off` clears it. Non-indexed additive.
   */
  teamId?: string
  /**
   * Explicit "no team in this conversation" sentinel. `/team off` used to
   * just clear `teamId`, which was indistinguishable from "never bound" —
   * with `AdapterInstanceRow.defaultTeamId` in play that could no longer
   * express "run single-character here even though the bot defaults to a
   * team". `true` suppresses BOTH the conversation `teamId` and the bot's
   * `defaultTeamId` (`resolveEffectiveTeamBinding`); re-binding via
   * `/team <name>` clears the flag. Non-indexed additive.
   */
  teamDisabled?: boolean
  /**
   * Per-conversation Visual Workflow binding (workflow⇄IM parity). When set
   * (and `teamId` is NOT set — `teamId` wins routing), an inbound AI-run
   * dispatches to the workflow orchestrator (`startWorkflowFromIM`) via
   * `lib/workflow/runtime/start-from-im.ts` instead of the single-character
   * `runAndCapture` path; the message text is surfaced as `$trigger.payload`.
   * Progress + final fan back through the same run-presentation runner the
   * team path uses. Bound via `/workflow <name|id>` or the inbox override form;
   * `/workflow off` clears it. Non-indexed additive (mirrors `teamId` — no
   * Dexie bump).
   */
  workflowId?: string
  /** Explicitly suppress rule/adapter Workflow inheritance for this conversation. */
  workflowDisabled?: boolean
  /**
   * Tool-approval mode for HITL ask-tier tools on this IM conversation
   * (control-plane HITL). `"prompt"` (DEFAULT) projects an A2UI Allow/Deny
   * card and waits for the user's button-press; `"yolo"` auto-approves every
   * ask-tier tool (cc-connect parity). Toggled via `/mode yolo|prompt`.
   * Non-indexed additive.
   */
  approvalMode?: "prompt" | "yolo"
  /**
   * Composed-mode axes for this conversation (ADR-0117).
   *
   * `autonomy` and `engagement` are the axis-native successors to `mode`, and
   * `authority` is the successor to `approvalMode` (`"yolo"` was
   * `bypassPermissions` scoped by the IM ceiling, which is a duplicate
   * permission model the composition already owns). All three are read in
   * preference to the legacy fields, which every write still mirrors so a
   * rollback needs no reverse migration.
   *
   * Orchestration is deliberately absent: its storage of record stays with
   * `teamId` / `workflowId` above, so a conversation can never carry two
   * disagreeing answers to "which engine runs this".
   *
   * Non-indexed additive fields — no Dexie bump.
   */
  autonomy?: AutonomyLevel
  engagement?: EngagementMode
  authority?: AgentAuthority
  /**
   * Marks a `mode` / `autonomy` that an SLA escalation step forced rather than
   * an operator choosing it (`runSwitchMode`). Provenance only: without it the
   * effective-config facade collapses an escalation-driven change to
   * `conversation-override`, so the ladder silently changing a conversation's
   * mode is invisible in every UI — the same defect `routingSource:
   * "assignment"` was added to fix. Cleared by any explicit mode write.
   */
  modeForcedBy?: "escalation"
  /**
   * Per-conversation opt-in for proactive event-driven notifications over IM
   * (control-plane notifications). Fail-closed default OFF: the
   * Notification Center's `im` delivery channel
   * (`lib/notifications/im-deliver.ts`) only pushes task-complete / error /
   * input-required events to this conversation when this flag is `true`.
   * Non-indexed additive.
   */
  proactivePush?: boolean
  /**
   * Issue tracker binding (ADR-0132 slice ③): the delivery container an issue
   * created from this conversation lands in by default. Written when the
   * user picks a project on the "create issue" confirmation card, so the next
   * card preselects it; also lets `lib/issues/notify.ts` push that project's
   * issue lifecycle back here (still gated by `proactivePush`). Non-indexed
   * additive (mirrors `teamId` / `workflowId`).
   */
  issueProjectId?: string
  /**
   * Per-conversation opt-in for the live in-turn activity card
   * (control-plane visibility — the cc-connect-style "the agent is
   * working" live card). DEFAULT ON (`undefined`/`true`): the connector
   * runtime wires `onEvent` on `runAndCaptureAssistantReply` so a single
   * cumulative A2UI card updates in chat as the turn progresses (tool
   * count, elapsed time, current action, per-file edits). Operators MAY
   * set this to `false` to suppress the live card for noisy channels —
   * the final reply still arrives through the normal outbound path.
   * Read in `lib/connectors/runtime.ts` when building the capture
   * options; non-indexed additive (mirrors `proactivePush`).
   */
  liveActivity?: boolean
  /**
   * Per-conversation opt-out for APPEND-mode live activity on adapters WITHOUT
   * `edit()` (workflow⇄IM visibility parity). DEFAULT ON (`undefined`/`true`):
   * such adapters get one compact progress line per throttled boundary during
   * a turn instead of full suppression. Set `false` to suppress append lines on
   * noisy channels (the final reply still arrives). Has no effect on adapters
   * that support `edit()` (those use the cumulative card via `liveActivity`).
   * Read in `lib/connectors/runtime.ts`; non-indexed additive (mirrors
   * `liveActivity`).
   */
  appendActivity?: boolean
  /**
   * Per-conversation switch for QUOTING the triggering message on ai-run
   * replies in group / thread scopes (ADR-0009 §3A.3). DEFAULT ON
   * (`undefined`/`true`): when the platform declares `send.reply` and the
   * reply streams back through the receiving conversation, the runtime sets
   * `replyTo: { messageId }` so a busy group can tell which message the bot
   * is answering. Private chats never quote (there is one interlocutor).
   * `false` opts this conversation out; `undefined` inherits
   * `AdapterInstanceRow.replyQuoting`. Non-indexed additive.
   */
  replyQuoting?: boolean
  /**
   * Per-conversation allowlist for built-in skills (ADR-0026 / schema v43).
   *
   *   - `undefined` / `"all"` — fall back to per-skill `imAccess` defaults
   *     (read skills are always available, write skills go through HITL,
   *     destructive skills are blocked).
   *   - `[]` — block every built-in skill on this channel.
   *   - `string[]` — only these skill IDs may be invoked. Matches against
   *     `BuiltInSkill.id` (e.g. `"lark.calendar.list_events"`) — wildcard
   *     entries like `"lark.calendar.*"` match every skill in that family.
   *
   * Independent of `requireHitlForWrites`: a skill must clear BOTH gates
   * (be in this allowlist AND pass the HITL routing) before
   * `runBuiltInSkill` executes it.
   */
  allowedBuiltInSkillIds?: string[] | "all"
  /**
   * Whether write-tier skills go through A2UI confirm-card HITL on this
   * channel (ADR-0026 / schema v43). Defaults to `true`. Operators MAY
   * set `false` for trusted internal channels to skip the confirm card
   * on `mutation === "write"` skills. Destructive skills always HITL
   * regardless of this flag.
   */
  requireHitlForWrites?: boolean
  /**
   * Per-conversation quiet hours window (im-refactored-crayon Phase 1.4).
   * When set, takes precedence over `AdapterInstanceRow.quietHours` for
   * outbound traffic on this conversation. Same shape as the adapter
   * field so the outbound-runner can swap them transparently. Times are
   * `HH:mm` 24-hour strings; `tz` is an IANA zone id ("Asia/Shanghai",
   * "UTC", etc.). Cleared by leaving the form's quiet-hours toggle off.
   */
  quietHours?: { from: string; to: string; tz: string }
  /**
   * Per-conversation outbound mute (fine-grained control). When `true`,
   * the outbound runner defers every delivery on THIS conversation exactly
   * like the adapter-level `AdapterInstanceRow.muted` (60 s re-check, not a
   * failure), while the bot keeps talking in its other conversations.
   * Precedence: adapter-level mute is checked first (global wins), then
   * this flag. Non-indexed additive — no Dexie bump.
   */
  muted?: boolean
  /**
   * Conversation lifecycle status (CRM maturation, schema v83). Chatwoot-style:
   * absent / "open" (active) | "pending" (waiting on someone) | "snoozed"
   * (muted until `snoozeUntil`) | "resolved" (closed). The bus auto-reopens a
   * "resolved" conversation on fresh inbound. Read helpers default absent → "open".
   */
  status?: "open" | "pending" | "snoozed" | "resolved"
  /** Epoch ms a "snoozed" conversation automatically wakes back to "open". */
  snoozeUntil?: number
  /**
   * Current assignee (schema v83). The local app is single-user, so "human"
   * carries no id; "character" / "team" reference the bound Character / Agent
   * Team that should own replies. The full object is a non-indexed blob —
   * IndexedDB can't index nested fields — so `assigneeKind` mirrors the kind
   * for filtering.
   */
  assignee?: { kind: "human" | "character" | "team"; id?: string; label?: string }
  /** Indexed discriminator mirroring `assignee.kind` (schema v83). */
  assigneeKind?: "human" | "character" | "team"
  /** Conversation label ids (schema v83). Multi-entry indexed via `*labelIds`. */
  labelIds?: string[]
  /** First-response SLA due time (epoch ms); set on first inbound, cleared on first outbound. */
  firstResponseDueAt?: number
  /** Next-response SLA due time (epoch ms); recomputed on inbound, cleared on outbound. */
  nextResponseDueAt?: number
  /** Epoch ms of the first outbound reply (SLA first-response measurement). */
  firstRespondedAt?: number
  /**
   * Per-conversation response-SLA target in minutes (schema v83). When set,
   * the connector bus stamps `nextResponseDueAt = computeDueAt(inboundTime,
   * slaResponseMinutes, quietHours)` on each fresh inbound, and the outbound
   * runner clears it (markResponded) on reply. Non-indexed; absent = no SLA.
   */
  slaResponseMinutes?: number
  /**
   * Per-conversation SLA escalation chain (slice 1B). `undefined` inherits
   * `AdapterInstanceRow.defaultEscalation`; an explicit `{ steps: [] }`
   * disables escalation for this conversation only. Non-indexed additive.
   */
  escalation?: EscalationPolicy
  /**
   * Index of the LAST escalation step that fired for the current overdue
   * window (0-based). The sweep only fires steps with a higher index, so each
   * step runs exactly once per breach. Cleared (with `escalatedAt`) by
   * `markResponded` and by `setStatus("resolved")`. Non-indexed additive.
   */
  escalatedStep?: number
  /** Epoch ms at which `escalatedStep` fired. */
  escalatedAt?: number
  /**
   * Assignment ↔ routing sync marker (slice 1A). Set to `"assignment"` by
   * `setAssignee` when a character / team assignment wrote `characterId` /
   * `teamId` on this row, so `resolveEffectiveRouting` can label the source
   * "assignment" and unassign can restore `assignmentPreviousRouting`.
   * Cleared by `clearAssignmentRoutingMarker` whenever the operator edits the
   * routing explicitly (override form / `/character` / `/team` / `/mode`),
   * after which unassign leaves the routing alone.
   */
  routingSource?: "assignment"
  /**
   * The row's `mode` before a HUMAN assignment forced `mode = "manual"`
   * (slice 1A). `null` records "no explicit mode (inherit adapter default)";
   * `undefined` means no human assignment is in force. Restored on unassign
   * or when the conversation is reassigned to a character / team.
   */
  assignmentPreviousMode?: ConnectorMode | null
  /**
   * The axis-native counterparts of {@link assignmentPreviousMode}, snapshotted
   * and restored by the same code path. Separate fields rather than a derived
   * value because an operator may have set `autonomy` without ever touching
   * the legacy `mode`, and unassign has to give back exactly what it took.
   */
  assignmentPreviousAutonomy?: AutonomyLevel | null
  assignmentPreviousEngagement?: EngagementMode | null
  /**
   * Snapshot of the routing fields taken ONCE when the first assignment-driven
   * routing write happened (slice 1A). Restored verbatim on unassign while
   * `routingSource === "assignment"`; discarded by
   * `clearAssignmentRoutingMarker`.
   */
  assignmentPreviousRouting?: {
    characterId?: string
    characterDisabled?: boolean
    teamId?: string
    teamDisabled?: boolean
    workflowDisabled?: boolean
  }
  createdAt: number
  updatedAt: number
}

export type ConnectorConversationActivationStatus = "inactive" | "active"

/** Durable runtime state for one platform conversation scope (Dexie v120). */
export interface ConnectorConversationStateRow {
  /** Same value as the stable opaque conversation key. */
  conversationKey: string
  adapterId: string
  activationStatus: ConnectorConversationActivationStatus
  activatedBy?: string
  activatedAt?: number
  lastHumanActivityAt?: number
  expiresAt?: number
  dispatchMode?: ActiveRunDispatchMode
  deliveryReadiness: DeliveryReadiness
  deliveryTarget: ConversationDeliveryTarget
  historyCursor?: {
    beforeTimestamp?: number
    afterTimestamp?: number
    pageToken?: string
  }
  /**
   * Cognia account this conversation last resolved to (Lark unified identity,
   * plan 2026-07-24 P1.4). Optional: absent on legacy rows and whenever the
   * principal registry flag is off.
   */
  accountId?: string
  /** FeishuPrincipalRow id of the most recent resolved sender. */
  lastPrincipalId?: string
  createdAt: number
  updatedAt: number
}

export type ConnectorInboundJobStatus =
  | "queued"
  | "steering"
  | "running"
  | "completed"
  | "failed"
  | "recovery_required"
  | "dismissed"
  | "history_only"

/** Durable inbound execution unit, unique per adapter/platform message (Dexie v120). */
export interface ConnectorInboundJobRow {
  id: string
  adapterId: string
  /** Conversation-scoped platform identity used by the unique Dexie index. */
  platformMessageId: string
  /** Original adapter message id, retained for diagnostics and outbound anchors. */
  sourceMessageId: string
  conversationKey: string
  event: NormalizedInboundEvent
  dispatchMode: ActiveRunDispatchMode
  status: ConnectorInboundJobStatus
  attempts: number
  /** Terminal recall fence, including recalls received before transcript insertion. */
  recalledAt?: number
  /** Latest edit while the create is waiting to enter the transcript. */
  pendingEdit?: NormalizedInboundEvent
  /** Matrix candidates remain separate until the original author's identity is known. */
  pendingEditsBySender?: Record<string, NormalizedInboundEvent>
  /** Retained Matrix replacement candidates, including superseded revisions. */
  matrixEditRevisions?: Record<string, NormalizedInboundEvent>
  matrixRedactedEditIds?: string[]
  /** Durable mutation intent must not expire before its canonical write commits. */
  mutationRevision?: number
  appliedMutationRevision?: number
  leaseOwner?: string
  leaseExpiresAt?: number
  executionRunId?: string
  recoveryReason?: string
  lastError?: string
  /**
   * Cognia account/principal the event resolved to (Lark unified identity,
   * plan 2026-07-24 P1.4). Stamped by the bus principal-resolution step;
   * absent on legacy rows and whenever the principal registry flag is off.
   * Recovery replays re-run resolution, so these are advisory denorms — the
   * registry stays the authority.
   */
  accountId?: string
  principalId?: string
  receivedAt: number
  createdAt: number
  updatedAt: number
}

/**
 * Connector audit log row. Aliases `AuditEntry` verbatim; a separate name
 * is used so we can add connector-specific fields in the future without
 * touching the shared type.
 */
export type ConnectorAuditRow = AuditEntry

/**
 * Heartbeat row (schema v51). Heartbeats used to live in `connectorAudit`
 * but at 2 880 rows/day/adapter they churned the global 5000-row audit cap
 * (every append triggered `pruneOldest`) and evicted operator-visible
 * events. They now have a dedicated table so the audit log stays a record
 * of real events while the Health view still gets its continuous signal.
 *
 * The shape is a structural subset of `AuditEntry` with `kind` pinned to
 * `"adapter.heartbeat"`, so a `ConnectorHeartbeatRow` is assignable to
 * `AuditEntry` and can be merged with audit rows before feeding the shared
 * `derive-history` helpers unchanged (the 24h dot grid interleaves
 * heartbeat "filler" with real delivery/error events).
 */
export interface ConnectorHeartbeatRow {
  id: string
  adapterId: string
  kind: "adapter.heartbeat"
  at: number
  reason?: string
  /** Same free-form snapshot the heartbeat writer used to put in the audit row. */
  fields?: Record<string, unknown>
}

export type ConnectorDraftStatus = "pending" | "approved" | "rejected" | "expired"

/**
 * One row per outbound draft awaiting human approval (manual mode).
 */
export interface ConnectorDraftRow {
  id: string
  conversationKey: string
  /** Owning workspace id — Workspace isolation column (Dexie v86); inherits the session's project. */
  projectId?: string
  sessionId: string
  segments: MessageSegment[]
  status: ConnectorDraftStatus
  createdAt: number
  /**
   * Last status write (Dexie v173, indexed) — the companion sync cursor for
   * this table (ADR-0131). Optional only for pre-v173 backup payloads; the
   * upgrade backfills `updatedAt = createdAt`.
   */
  updatedAt?: number
  expiresAt?: number
  /** The inbound StoredMessage.id this draft is replying to. */
  sourceMessageId?: string
  /** Pre-built OutboundRequest the user can fire on approve (idempotencyKey already issued). */
  outboundPreview?: OutboundRequest
}

/**
 * One row per fetched platform attachment, cached on-disk under
 * `<appData>/cognia/connectors/cache` (encrypted). The `[adapterId+remoteRef]`
 * composite unique index lets the attachment layer do O(1) "do I have it?"
 * checks before issuing a Tauri fetch command.
 */
export interface ConnectorAttachmentRow {
  id: string
  adapterId: string
  remoteRef: string
  /**
   * Hex SHA-256 of `"<adapterId>:<remoteRef>"` — the handle Rust deletes by.
   * There is no local path: the cache stores encrypted envelopes only, and
   * bytes come back through `connectorsAttachmentRead`.
   */
  cacheKey: string
  mimeType: string
  /** Real decrypted size, as reported by Rust. Never a client-side guess. */
  sizeBytes: number
  fetchedAt: number
  /**
   * Last read, mirrored from the envelope so the settings UI can show cache
   * age. The eviction authority is Rust's copy, not this one.
   */
  lastAccessedAt: number
  expiresAt?: number
}

/**
 * A blob whose Dexie row is gone (or is about to be) but whose encrypted file
 * has not been confirmed deleted yet.
 *
 * Deleting a cached attachment is two writes across two stores, and the disk
 * side can fail (locked file, permissions, headless host with no Rust). The
 * ledger is what keeps that from silently orphaning ciphertext: the Dexie row
 * is only dropped once Rust confirms the delete, and anything else lands here
 * to be retried with backoff and surfaced in health diagnostics.
 */
export interface ConnectorCleanupJobRow {
  /** The cache key — one outstanding job per blob. */
  id: string
  /** Adapter the blob belonged to, for diagnostics and bulk retry. */
  adapterId: string
  /** Why the blob is being removed. */
  reason: "adapter_removed" | "expired" | "evicted" | "orphaned" | "manual"
  attempts: number
  /** Epoch ms; the sweep skips jobs that are not due yet. */
  nextAttemptAt: number
  lastAttemptAt?: number
  /** Message from the last failed attempt, shown in health diagnostics. */
  lastError?: string
  createdAt: number
}

/** Borrowed-shape: same ConversationReference as types/connectors/event.ts. */
export type ConversationReferenceRow = ConversationReference

// ─── Feishu unified identity registry (plan 2026-07-24, Phase 1) ────────────
//
// Server-authoritative mapping `tenantKey + appId + openId → Cognia
// account/user`. These tables are the AUTHENTICATION authority for Lark
// inbound events and callbacks when `larkPrincipalRegistry` is on;
// `platformIdentities` above stays a display/contact directory only and never
// authorizes anything. Uniqueness is enforced by compound Dexie indexes:
// feishuTenants `&[tenantKey+appId]`, feishuPrincipals
// `&[tenantKey+appId+openId]` — the same openId text under another tenant or
// app is a DIFFERENT principal by construction.

export type FeishuTenantStatus = "active" | "disabled"

/** One row per (tenantKey, appId) pair an operator has admitted. */
export interface FeishuTenantRow {
  id: string
  tenantKey: string
  appId: string
  /** Cognia account this tenant's traffic belongs to. */
  cogniaAccountId: string
  status: FeishuTenantStatus
  configuredAt: number
  disabledAt?: number
  updatedAt: number
}

export type FeishuPrincipalStatus = "active" | "disabled" | "unlinked"

/** One row per verified Feishu user identity within a tenant/app scope. */
export interface FeishuPrincipalRow {
  id: string
  tenantKey: string
  appId: string
  openId: string
  unionId?: string
  cogniaAccountId: string
  /**
   * The `User` (`usr_…`) this Feishu identity belongs to — ADR-0149 §3.
   *
   * Rows written before Batch 5 hold a LocalProfile id (`acct_…`) here, which
   * is why every reader treats it as an opaque string rather than joining on
   * it: the registry seeded the operator's own profile id for senders it had
   * no person for. New rows carry a real person, and `lib/connectors/principal/person.ts`
   * is the only place one is resolved.
   */
  cogniaUserId: string
  /**
   * The person's Logto subject (P1.3). Written when the principal is created
   * for a person whose login is already known (bind approval, the signed-in
   * owner's self-bind), and back-filled onto matching principals when that
   * person signs in later (`lib/connectors/principal/login-link.ts`). Never
   * written for a principal that belongs to somebody else.
   */
  logtoSubject?: string
  logtoOrganizationId?: string
  /**
   * When the profile's signed-in person approved this principal as
   * THEMSELVES (`approveFeishuBind({ asSignedInOwner: true })`). The only
   * evidence `principal/self-bind.ts` accepts for admitting the same
   * `union_id` in another bot app of the tenant. Non-indexed.
   */
  ownerConfirmedAt?: number
  /**
   * When `principal/self-bind.ts` admitted (or re-admitted) this principal on
   * the strength of an owner confirmation. Marks the rows a sign-out unlinks.
   */
  selfBoundAt?: number
  /** Display-identity reference into `platformIdentities` (directory only). */
  platformIdentityId?: string
  status: FeishuPrincipalStatus
  linkedAt: number
  lastVerifiedAt?: number
  updatedAt: number
  /** Optimistic revision, bumped on every mutation for audit/rebind flows. */
  version: number
}

// ─── Lark entry surfaces (plan 2026-07-24, Phases 3-5; Dexie v126) ──────────

/**
 * Brain-side ledger of issued personal entry tokens (jti-keyed). The Rust
 * companion enforces single-use via its in-process LRU; this ledger is the
 * durable audit/ops view (issued → consumed) that survives restarts.
 */
export interface LarkEntryContextRow {
  /** Token jti. */
  id: string
  adapterId: string
  principalId: string
  accountId: string
  entryType: string
  conversationKey: string
  sessionId?: string
  issuedAt: number
  expiresAt: number
  consumedAt?: number
}

export type LarkChatSurfaceType = "chat_tab" | "group_menu"

/**
 * `blocked` is terminal-until-reconfigured: the platform refused for a reason
 * retrying cannot fix (scope not granted, or a p2p chat for a group-only
 * surface). Retrying those on the exponential backoff produced a permanent
 * error-log drip and burned tenant-token quota, so they park instead and are
 * re-armed only by an explicit resync or a changed desired URL.
 */
export type LarkChatSurfaceStatus =
  "pending" | "synced" | "error" | "blocked" | "rebuild_required" | "removed"

/** Reconcile state for one platform-side chat surface (Chat Tab / 群菜单). */
export interface LarkChatSurfaceRow {
  adapterId: string
  chatId: string
  surfaceType: LarkChatSurfaceType
  tenantKey?: string
  appId?: string
  /** Platform-side id of the created tab / menu, when known. */
  platformSurfaceId?: string
  urlVersion: number
  desiredUrl?: string
  status: LarkChatSurfaceStatus
  attempt: number
  nextAttemptAt?: number
  lastSyncAt?: number
  lastError?: string
  createdAt: number
  updatedAt: number
}

/** Idempotency + provenance record for one message-shortcut import. */
export interface LarkMessageImportRow {
  id: string
  /** sha256(adapterId + chatId + sorted messageIds) — replay returns the row. */
  sourceHash: string
  adapterId: string
  chatId: string
  conversationKey: string
  sessionId: string
  messageIds: string[]
  /** Per-message skip reasons (recalled, unsupported, fetch_failed …). */
  skipped?: Array<{ messageId: string; reason: string }>
  createdAt: number
}

/**
 * Ledger of web SSO sessions the brain has SEEN (via entry resolves /
 * intents). Enforcement lives in the token TTL; this row enables a future
 * revocation UI and the audit trail. Keyed by a hash of the session jti —
 * the raw token never lands in Dexie.
 */
export interface LarkWebSessionRow {
  /** sha256 hash (first 12) of the session jti. */
  id: string
  adapterId: string
  principalId?: string
  openIdHash: string
  tenantKey: string
  appId: string
  issuedAt: number
  expiresAt: number
  lastSeenAt: number
  revokedAt?: number
}

export type FeishuBindRequestStatus = "pending" | "approved" | "rejected" | "expired"

/**
 * Pending admin-bind request for an unbound Feishu sender. The row id doubles
 * as the short unguessable code shown to the user in the "not linked yet"
 * reply, so an operator can approve it from the admin side.
 */
export interface FeishuPrincipalBindRequestRow {
  id: string
  openId: string
  /** The sender's `union_id`; non-indexed, absent on rows from older parsers. */
  unionId?: string
  adapterId: string
  tenantKey?: string
  appId?: string
  conversationKey?: string
  status: FeishuBindRequestStatus
  requestedAt: number
  resolvedAt?: number
  resolvedPrincipalId?: string
  expiresAt: number
}
