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

import type { PlatformKind } from "@/types/connectors/platform-kind"
import type { OutboundRequest } from "@/types/connectors/outbound"
import type { TriggerPolicy, ConnectorMode } from "@/types/connectors/policy"
import type { TransportMode } from "@/types/connectors/adapter"
import type { A2UICapabilityMatrix } from "@/types/connectors/capability"
import type { PlatformSkillCapability } from "@/types/connectors/skill-capability"
import type { ConversationReference, PlatformIdentity } from "@/types/connectors/event"
import type { AuditEntry } from "@/types/connectors/audit"
import type { UsagePresenceConfig, UsagePresenceState } from "@/types/connectors/presence"
import type { MessageSegment } from "@/types/connectors/segment"
import type { ConnectorCallbackBindingRow } from "@/types/connectors/interaction"

export type { ConnectorCallbackBindingRow }

/**
 * Optional probe metadata captured at adapter start. Used by OneBot to
 * record which upstream implementation (NapCat / Lagrange / LLOneBot) the
 * adapter is talking to, alongside the version string and the set of
 * non-standard extensions the upstream advertises. Added at schema v41 in
 * support of A5 (OneBot feature detection) + B5 (NapCat simulated mapper).
 *
 * Treat the field as opaque outside of the adapter that wrote it: each
 * platform may use it differently in future revisions (e.g., a Slack
 * adapter could record `assistantAppEnabled` here). Unknown impls are
 * tagged with `impl: "unknown"` so consumers can degrade safely.
 */
export interface AdapterImplMetadata {
  /** e.g., `"napcat"`, `"lagrange"`, `"llonebot"`, `"unknown"`. */
  impl: string
  /** Free-form upstream version string ("v4.2.1", "0.0.13"). */
  version: string
  /**
   * Non-standard capability tokens detected at probe time. The mapper
   * consumes this set when deciding whether to emit native rich content
   * (e.g., `"napcat:markdown-card"` enables QQ markdown buttons).
   */
  features: string[]
}

/**
 * Match conditions for one inbound dispatch rule (W3 multi-bot). Every
 * provided field must hold for the rule to match (AND across fields); the
 * list-valued fields match on ANY entry (OR within a field). An empty /
 * absent match object is a catch-all. Empty arrays are treated as "not
 * provided" so a blanked-out settings field can never make a rule
 * unmatchable by accident.
 */
export interface DispatchRuleMatch {
  /** ANY keyword matches (case-insensitive substring of plainText). */
  keywords?: string[]
  /**
   * Regex source tested against plainText (invalid patterns never match;
   * compiled once and cached by source).
   */
  pattern?: string
  /** ANY id matches event.sender.id OR event.sender.remoteUserId. */
  senderIds?: string[]
  /** Restrict to these channel kinds (types/connectors/event.ts ChannelKind). */
  channelKinds?: Array<"private" | "group" | "channel" | "thread">
}

/**
 * Routing target of a dispatch rule. At least one field must be set for
 * the rule to participate in matching; `teamId` wins over `workflowId`
 * wins over `characterId` at dispatch time.
 */
export interface DispatchRuleAction {
  characterId?: string
  teamId?: string
  workflowId?: string
  /**
   * Deliver the reply through ANOTHER of our own bot instances (multi-bot
   * cross-account send). Must reference an enabled adapter instance of the
   * SAME platform; the runtime validates at dispatch time and falls back
   * to the receiving bot (with an audit trail) when the target is missing,
   * disabled, or cross-platform. A rule carrying ONLY this field is a
   * valid routing target — it keeps the default character/team handling
   * but swaps the sending bot.
   */
  respondViaAdapterId?: string
}

/** One declarative inbound dispatch rule — see `AdapterInstanceRow.dispatchRules`. */
export interface DispatchRule {
  id: string
  /** default true */
  enabled?: boolean
  /** operator label for UI/audit */
  name?: string
  match: DispatchRuleMatch
  /** at least one field; teamId wins over workflowId wins over characterId at dispatch */
  action: DispatchRuleAction
}

/**
 * Per-bot outbound throttle / circuit-breaker tuning. Every knob is
 * optional — omitted knobs keep the runner's built-in defaults (token
 * bucket 20 capacity / 5 refill per second; breaker 30 s window / 5 min
 * events / 50 % failure threshold / 30 s cooldown). Values are validated
 * at the consumption site (`sanitizeOutboundTuning`) so a hand-edited row
 * with a zero/negative/NaN knob degrades to the default instead of
 * stalling deliveries.
 */
export interface OutboundTuningConfig {
  /** Token-bucket capacity (max burst size). */
  rateCapacity?: number
  /** Token-bucket refill rate, tokens per second (fractional allowed). */
  rateRefillPerSec?: number
  /** Circuit-breaker sliding window, ms. */
  breakerWindowMs?: number
  /** Minimum events inside the window before the threshold is evaluated. */
  breakerMinEvents?: number
  /** Failure percentage (0–100) that trips the breaker. */
  breakerFailureThresholdPct?: number
  /** How long the breaker stays open before probing again, ms. */
  breakerCooldownMs?: number
}

/**
 * One row per configured adapter instance (one Telegram bot, one Discord
 * guild connection, etc.). The `credentialsRef` field points into the OS
 * keyring — it never holds the actual secret value.
 */
export interface AdapterInstanceRow {
  id: string
  type: PlatformKind
  displayName: string
  enabled: boolean
  transportMode: TransportMode
  /** Non-secret JSON-Schema-validated settings. */
  settings: Record<string, unknown>
  /** Reference to keyring entries; never holds the secret value. */
  credentialsRef: { keyringService: string; accounts: string[] }
  trigger: TriggerPolicy
  defaultCharacterId?: string
  defaultMode: ConnectorMode
  /** For webhook / reverse-WS: path under the connectors axum app. */
  webhookPath?: string
  /** Resolved public URL (tunnel or user-supplied) for paste into platform settings. */
  publicUrl?: string
  /** Per-adapter quiet hours, optional. */
  quietHours?: { from: string; to: string; tz: string }
  /** Adapter is muted globally (drops outbound). */
  muted?: boolean
  /**
   * Per-bot outbound throttle / circuit-breaker tuning. Overrides the
   * runner's built-in defaults for THIS adapter instance only. Consumed by
   * `lib/connectors/outbound-runner.ts:getAdapterState`, which rebuilds the
   * live bucket/breaker when the tuning fingerprint changes, so edits apply
   * on the next delivery without restarting the runner.
   */
  outboundTuning?: OutboundTuningConfig
  /**
   * Ordered failover targets (multi-bot): when THIS adapter's circuit
   * breaker is open at delivery time, the outbound runner re-enqueues the
   * job through the first enabled same-platform sibling listed here instead
   * of dead-lettering it. Single hop only — a failed-over job never fails
   * over again (`request.metadata.failoverFromAdapterId` guard), so two
   * bots cannot ping-pong a job between their open circuits.
   */
  failoverAdapterIds?: string[]
  /**
   * Ordered load-balancing spillover targets (multi-bot). When THIS
   * adapter's outbound token bucket is exhausted at delivery time, the
   * runner re-enqueues the job through the first enabled same-platform
   * sibling listed here that still has send capacity, instead of deferring
   * it behind the rate limit. Complements `failoverAdapterIds` (hard
   * failure → failover; throughput pressure → balance). Single hop only —
   * a rerouted job (either mechanism) is never rerouted again
   * (`request.metadata.balancedFromAdapterId` / `failoverFromAdapterId`
   * guards), so two saturated bots cannot ping-pong a job.
   */
  balanceAdapterIds?: string[]
  /**
   * Cache of `PlatformAdapter.a2uiCapability()` written at adapter start.
   * `lib/claude/build-options.ts:resolveSendOptions` reads this to inject
   * a capability-aware system prompt without an async fan-out at every
   * send. Rows that pre-date v38 will have `undefined` here; the resolver
   * treats that as "all components fallback" and the runtime refreshes
   * the cache the next time the adapter starts.
   */
  lastKnownCapabilities?: A2UICapabilityMatrix
  /**
   * Cache of `PlatformAdapter.platformSkillCapabilities()` written at
   * adapter start. Added at v43 (ADR-0026) so the build-options resolver
   * can render the "Built-in skills available on this channel: …" prompt
   * section without an async fan-out across the skill registry at every
   * send. Rows that pre-date v43 will have `undefined` here; the
   * resolver treats that as "no built-in skills available" and the
   * runtime refreshes the cache the next time the adapter starts.
   *
   * Adapters that don't expose any built-in skill families (Telegram,
   * Discord, OneBot in v1) write `[]` so the cache hit is unambiguous.
   */
  lastKnownSkillCapabilities?: readonly PlatformSkillCapability[]
  /**
   * Optional upstream-implementation probe result. Added at v41 in support
   * of OneBot NapCat / Lagrange / LLOneBot feature detection. Other
   * adapters MAY populate this when feature-detect probes (`auth.test`,
   * `getMe`, etc.) carry useful upstream metadata. Re-written on each
   * adapter start so reconnects can detect upstream upgrades.
   */
  implMetadata?: AdapterImplMetadata
  /**
   * Per-adapter at-mention response strategy (v45, Lark first). Reads:
   *   - "always"        — respond to every inbound message in scope.
   *   - "mention_only"  — only respond when the bot is @-mentioned. DMs
   *                       (1:1 chats) bypass this regardless because they
   *                       have no mention surface.
   *   - "direct_only"   — only respond in 1:1 DMs; group chats are
   *                       dropped even if the bot is mentioned.
   *
   * Enforced in `lib/connectors/adapters/lark/at-gate.ts`. Rows without
   * the field default to "mention_only" — the safer choice for a freshly
   * added Lark bot that may have been invited into chatty group channels.
   */
  atResponseStrategy?: "always" | "mention_only" | "direct_only"
  /**
   * Per-adapter chat allow/blocklist (v45). `chatAllowlist` non-empty means
   * "only these `chat_id`s may trigger a response"; `chatBlocklist` hit
   * means "never respond in this chat". Both lists are checked alongside
   * `atResponseStrategy` by `shouldRespondToMessage` — denial in either
   * gate short-circuits before the bus is invoked.
   */
  chatAllowlist?: string[]
  chatBlocklist?: string[]
  /**
   * How to treat inbound messages authored by ANOTHER of our own bot
   * instances in the same remote chat (W5 multi-bot same-group
   * collaboration; non-indexed additive, same placement rationale as
   * `welcomeCardEnabled`). Detected by
   * `lib/connectors/sibling-bots.ts:findSiblingBotSender` and enforced in
   * the shared inbound gate (`lib/connectors/at-gate.ts:gateInboundEvent`).
   *
   *   - "ignore" (default) — never AI-respond to a sibling bot's message
   *     (audited as `inbound.sibling_bot_ignored`), killing cross-instance
   *     mention loops at the door.
   *   - "respond" — sibling messages may trigger a response, but bounded by
   *     `botInterplayBudget`; over-budget messages are dropped with
   *     `inbound.sibling_bot_budget_exhausted`.
   */
  siblingBotPolicy?: "ignore" | "respond"
  /**
   * Max AI responses to sibling-bot messages per chat per sliding hour when
   * `siblingBotPolicy === "respond"` (default 4). Guards against slow-burn
   * bot↔bot ping-pong that the mention gate alone cannot stop.
   */
  botInterplayBudget?: number
  /**
   * Cross-provider help / welcome card settings (shared across every IM
   * adapter, same row-level placement rationale as `quietHours`/`muted`:
   * a cross-cutting concern the bus reads without parsing platform-specific
   * `settings`). All three are non-indexed JSON columns — IndexedDB stores
   * extra keys transparently, so no schema-version bump is required; the
   * reader defaults a missing value (`welcomeCardEnabled ?? true`).
   *
   *   - `welcomeCardEnabled` — send a welcome card when the bot joins a chat
   *     (`systemKind === "member_added"`) or on the first inbound in a
   *     conversation. Defaults to `true`.
   *   - `helpTriggers` — message texts that trigger an on-demand help card
   *     instead of an AI turn. Matched case-insensitively against the
   *     trimmed `plainText`. Defaults to `["/help", "帮助"]` when undefined
   *     or empty.
   *   - `welcomeText` — optional operator-authored intro line injected into
   *     the welcome card; falls back to a built-in bilingual default.
   */
  welcomeCardEnabled?: boolean
  helpTriggers?: string[]
  welcomeText?: string
  /**
   * In-chat control-command policy (control-plane completion). Governs who may
   * run `/model`, `/mode`, `/new`, … from an inbound IM message. Non-indexed
   * JSON column — same placement rationale as `welcomeCardEnabled` (no schema
   * bump). Read by `lib/connectors/commands/dispatch.ts`.
   *
   *   - `mode: "everyone"`      — anyone in any chat may run state-changing
   *                               commands.
   *   - `mode: "private-only"`  — DEFAULT. State-changing commands only in 1:1
   *                               DMs; group chats require the allowlist.
   *   - `mode: "allowlist"`     — only `allowedUserIds` (matched against
   *                               `event.sender.id`) may run state-changing
   *                               commands, in any chat.
   *
   * Read-only commands (`/help` `/status` `/sessions` `/dir`) are always
   * allowed regardless of mode. `enabled === false` disables the whole
   * interceptor (inbound `/…` text flows to the AI as a normal message).
   */
  controlCommands?: {
    enabled?: boolean
    mode?: "everyone" | "private-only" | "allowlist"
    allowedUserIds?: string[]
  }
  /**
   * Instance-level AI binding defaults (per-bot "which agent answers"),
   * same non-indexed-JSON placement rationale as `welcomeCardEnabled` — no
   * schema-version index change (documented anchor: v106). `undefined`
   * means "no bot-level default"; empty strings are treated as unset by
   * every reader. Precedence: an explicit per-conversation override
   * (`ConversationOverrideRow`) always wins; the bot default wins over the
   * character's own `model`/`providerId` (an operator pinning a model on a
   * bot expects that model even when the persona declares one); app
   * settings are the final fallback.
   *
   *   - `defaultTeamId`   — dispatch inbound AI-runs to this Agent Team
   *                         unless the conversation binds/disables one
   *                         (`resolveEffectiveTeamBinding`).
   *   - `defaultModel`    — model id or routing alias; resolved through the
   *                         same alias engine as every other model source.
   *   - `defaultProvider` — provider id; unknown ids keep the resolver's
   *                         best-effort fallback semantics.
   *   - `defaultReasoning`— reasoning-effort level; silently dropped by the
   *                         existing `modelSupportsEffort` gate when the
   *                         effective model cannot reason.
   */
  defaultTeamId?: string
  defaultModel?: string
  defaultProvider?: string
  defaultReasoning?: "low" | "medium" | "high" | "xhigh" | "max"
  /**
   * Platform scopes observed missing at runtime (chat-management calls that
   * failed with a permission error record the scope they needed here, e.g.
   * Lark `im:chat:create`). Rendered as a warning row by the whoami panel so
   * the operator learns which Developer Console permissions to enable.
   * Best-effort, append-only-with-dedup; cleared by a successful re-probe.
   * Non-indexed additive.
   */
  lastMissingScopes?: string[]
  /**
   * Declarative inbound dispatch rules (条件规则表, W3 multi-bot) — same
   * non-indexed-JSON placement rationale as `welcomeCardEnabled`: no
   * schema-version index change (documented anchor: v107). Evaluated in
   * array order by `lib/connectors/dispatch-rules.ts:matchDispatchRule`;
   * the first enabled rule whose match conditions ALL hold routes the
   * inbound AI-run to the rule's character / team / workflow. Precedence:
   * explicit conversation override (`/team`, `/character`, `/workflow`,
   * `teamDisabled`) > first matching rule > instance defaults
   * (`defaultTeamId` / `defaultCharacterId`). Deterministic condition
   * table only — no AI triage in v1.
   */
  dispatchRules?: DispatchRule[]
  /**
   * Cached bot identity probe written by
   * `lib/connectors/adapters/lark/whoami.ts:probeBotIdentity`. The
   * adapter detail Config tab renders this so the operator can confirm
   * "credentials map to the expected bot in the expected tenant" without
   * leaving the settings page. Re-fetched automatically on first save and
   * on demand via the "Re-probe" button. Rows that pre-date v45 carry no
   * cached value; the probe runs the first time the operator opens the
   * detail panel.
   */
  /**
   * Token-usage presence settings + runner state (cross-provider, same
   * non-indexed-JSON placement rationale as `welcomeCardEnabled` — no
   * schema bump). `presence` is operator config; `presenceState` is
   * refresh-runner state (pinned-card message id, last refresh, last
   * error). Read/written by
   * `lib/connectors/presence/usage-status-runner.ts`.
   */
  presence?: UsagePresenceConfig
  presenceState?: UsagePresenceState
  lastWhoamiAt?: number
  lastWhoamiResult?: {
    /** Bot display name as registered on the Lark Developer Console. */
    botName: string
    /** Lark CDN URL for the bot avatar; optional because legacy bots may omit it. */
    botAvatar?: string
    /** Lark App ID (`cli_...`). */
    appId: string
    /** Bot's own `open_id`, used by the adapter to detect self-mentions. */
    openId: string
    /**
     * Lark tenant key. Optional because the `/bot/v3/info` endpoint does
     * not return it — the bus backfills this field from the first
     * inbound event envelope's `tenant_key` header.
     */
    tenantKey?: string
    /**
     * Scope list. Optional because Lark does not expose a bot-side scope
     * probe endpoint (scopes are configured on the Developer Console).
     * The whoami probe leaves this undefined; future work may populate
     * it via per-endpoint capability probes if the operator opts in.
     */
    scopes?: string[]
    /**
     * Lark bot activation status code (from `/bot/v3/info.activate_status`):
     * - 0 = uninitialized
     * - 1 = initialized but offline
     * - 2 = activated and online
     * - 3 = stopped
     * The whoami panel translates this code into a human-readable badge.
     */
    activateStatus?: number
  }
  /**
   * Wall-clock epoch ms at which a user-OAuth access token was last
   * persisted to the keyring under `<adapterId>:user_token` +
   * `<adapterId>:user_refresh_token`. The OAuth card uses this to decide
   * whether to show "Connect with Lark" (undefined) versus "Re-authorise"
   * / "Revoke" (defined). The actual token never lives in this row.
   */
  userTokenStoredAt?: number
  createdAt: number
  updatedAt: number
}

/**
 * One row per observed platform user. Extends the canonical PlatformIdentity
 * shape with a `lastSeenAt` timestamp used for stale-identity cleanup.
 */
export interface PlatformIdentityRow extends PlatformIdentity {
  /** Last time we observed this identity; helps cleanup. */
  lastSeenAt: number
  /**
   * Lossless merge history (CRM, schema v83 — non-indexed blob, no migration).
   * Each `mergeIdentities` call snapshots the absorbed secondary row here so
   * `unmergeIdentity` can restore it exactly. Parallel to `mergedFromIds`
   * (which keeps just the ids for quick membership checks).
   */
  mergedSnapshots?: PlatformIdentityRow[]
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
export type InboundLedgerNamespace = "inbound" | "callback" | "welcome"

export interface InboundLedgerRow {
  /** `${adapterId}:${namespace}:${platformMessageId}` (or legacy form). */
  id: string
  adapterId: string
  /** Sliding-window namespace; defaults to `"inbound"` for legacy rows. */
  namespace: InboundLedgerNamespace
  platformMessageId: string
  receivedAt: number
}

export type OutboundJobStatus = "pending" | "sending" | "sent" | "failed" | "deadlettered"

/**
 * Provenance of an outbound job. Added at schema v41 so the inbox UI can
 * tell a workflow-pushed message apart from a normal ai-run reply, and
 * the audit log carries one extra dimension for routing introspection.
 *
 *   - `"ai-run"`         — the connector runtime ran the AI loop on an
 *                          inbound trigger and enqueued the assistant's
 *                          reply (this is the v18-v40 baseline).
 *   - `"manual"`         — operator typed the message into the inbox
 *                          composer and clicked Send.
 *   - `"workflow"`       — a Visual Workflow node (`action.connector.send`)
 *                          drove the send. `sourceWorkflow` carries the
 *                          {workflowId, runId, nodeId} triple for jump-to.
 *   - `"draft-approved"` — the message originated as a `ConnectorDraftRow`
 *                          (manual-mode AI reply), then the operator
 *                          clicked Approve.
 *   - `"skill"`          — an `im.*` built-in skill (agent-invoked chat
 *                          management: first message of a freshly created
 *                          chat, or an `im.broadcast` fan-out target)
 *                          enqueued the send after passing its own PII gate
 *                          and HITL confirmation.
 *   - `"plugin"`         — a plugin called `ctx.connectors.enqueueSend`
 *                          (gated `connectors:send` + the enqueue-side PII
 *                          gate) to ride the durable queue.
 *
 * Rows persisted before v41 backfill to `"ai-run"` because that's the
 * only path that existed when they were created.
 */
export type OutboundJobSource =
  "ai-run" | "manual" | "workflow" | "draft-approved" | "skill" | "plugin"

/**
 * Cross-reference back to the Visual Workflow node that produced a
 * workflow-sourced outbound job. Populated only when `source = "workflow"`;
 * undefined otherwise. Used by `components/inbox/conversation-list.tsx`
 * to render a workflow badge with click-to-jump.
 */
export interface OutboundJobWorkflowSource {
  workflowId: string
  runId: string
  nodeId: string
}

/**
 * One row per outbound delivery job. The runner processes rows in
 * `[conversationKey+createdAt]` order (FIFO per conversation lane).
 */
export interface OutboundJobRow {
  id: string
  adapterId: string
  /** Owning workspace id — Workspace isolation column (Dexie v86). Outbound routing is per-project. */
  projectId?: string
  conversationKey: string
  request: OutboundRequest
  status: OutboundJobStatus
  attempts: number
  lastError?: string
  /** Error code from the last attempt, used by the audit log + breaker. */
  lastErrorCode?: string
  createdAt: number
  /** Wall-clock at which the runner is allowed to retry. */
  nextAttemptAt: number
  idempotencyKey: string
  /**
   * Provenance of the enqueue. Added at v41; rows persisted before v41
   * backfill to `"ai-run"` via the upgrade hook. Required on new rows
   * so the inbox UI can avoid the `?? "ai-run"` defensive read at every
   * render path.
   */
  source: OutboundJobSource
  /**
   * Cross-reference back to the workflow that produced this job.
   * Populated only when `source === "workflow"`. Used by the inbox UI
   * to render a workflow badge.
   */
  sourceWorkflow?: OutboundJobWorkflowSource
  /**
   * The platform-side message id returned by the adapter after a
   * successful send/edit. Persisted so downstream consumers (notably the
   * workflow-progress-runner's in-place card edit path) can correlate
   * the original send back to the platform's message handle without
   * re-querying the platform API. Non-indexed JSON column — no schema
   * version bump required since IndexedDB stores extra keys
   * transparently.
   */
  platformMessageId?: string
  /**
   * When the runner reroutes this job to a sibling bot (circuit-open
   * failover or rate-limit load-balance), the ORIGINAL job is dead-lettered
   * (reason `failover`/`balanced`) and this points at the NEW job on the
   * sibling that actually carries the delivery. A caller awaiting the
   * original follows this pointer (`waitForOutboundTerminal`) to the
   * sibling's true terminal status instead of misreading the reroute as a
   * failure. Non-indexed JSON column — no schema version bump.
   */
  reroutedToJobId?: string
  /** How the reroute happened, set alongside {@link reroutedToJobId}. */
  reroutedMechanism?: "failover" | "balanced"
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
   * Owning workspace id — Workspace isolation column (Dexie v86). Per-project
   * routing state; `conversationKey` stays the globally-unique primary key
   * (one conversation maps to one workspace), so this is a plain filter index.
   */
  projectId?: string
  /** The cognia-next ChatSession this conversation maps to. */
  sessionId: string
  mode?: ConnectorMode
  characterId?: string
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
   * Progress + final fan back through the same `workflow-progress-runner` the
   * team path uses. Bound via `/workflow <name|id>` or the inbox override form;
   * `/workflow off` clears it. Non-indexed additive (mirrors `teamId` — no
   * Dexie bump).
   */
  workflowId?: string
  /**
   * Tool-approval mode for HITL ask-tier tools on this IM conversation
   * (control-plane HITL). `"prompt"` (DEFAULT) projects an A2UI Allow/Deny
   * card and waits for the user's button-press; `"yolo"` auto-approves every
   * ask-tier tool (cc-connect parity). Toggled via `/mode yolo|prompt`.
   * Non-indexed additive.
   */
  approvalMode?: "prompt" | "yolo"
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
  /** Path inside <appData>/cognia/connectors/cache (encrypted on disk). */
  localPath: string
  mimeType: string
  sizeBytes: number
  fetchedAt: number
  expiresAt?: number
}

/** Borrowed-shape: same ConversationReference as types/connectors/event.ts. */
export type ConversationReferenceRow = ConversationReference
