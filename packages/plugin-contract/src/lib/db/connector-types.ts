/**
 * The plugin contract's share of `lib/db/connector-types.ts`, which re-exports these.
 */
import type { A2UICapabilityMatrix } from "../../types/connectors/capability"
import type {
  ActiveRunDispatchMode,
  ConnectorMode,
  DeliveryReadiness,
  InboundActivationPolicy,
  TriggerPolicy,
} from "../../types/connectors/policy"
import type {
  AgentAuthority,
  AutonomyLevel,
  EngagementMode,
} from "@cognia/agent-config-types/agent-composition"
import type {
  ActionReviewAuthority,
  ActionReviewGrantScope,
} from "@cognia/agent-config-types/action-review"
import type { EscalationPolicy } from "../../types/connectors/escalation"
import type { ItemOwner, ItemProvenance } from "../../types/placement/item-owner"
import type { OutboundRequest } from "../../types/connectors/outbound"
import type { PlatformKind } from "../../types/connectors/platform-kind"
import type { PlatformSkillCapability } from "../../types/connectors/skill-capability"
import type { TransportMode } from "../../types/connectors/adapter"
import type { UsagePresenceConfig, UsagePresenceState } from "../../types/connectors/presence"

/** Host-owned capabilities that an IM adapter may further restrict. */
export type ImHostCapabilityId = "computer_use" | "ocr" | "goal_driving" | "schedule_tools"

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
 * The bot's own identity on its platform, confirmed by a live probe.
 *
 * This is what makes the sibling-bot guard sound: without a confirmed
 * account id, "is this inbound message from another one of my bots?" cannot
 * be answered, and the guard must fail closed rather than guess.
 */
export interface AdapterSelfIdentitySnapshot {
  /** The platform's own id for the account this instance authenticates as. */
  platformAccountId: string
  /** Bot-scoped id where the platform separates it from the account id. */
  platformBotId?: string
  /** Which probe established it — all three are authoritative. */
  source: "startup_probe" | "gateway_ready" | "whoami"
  confirmedAt: number
}

/**
 * Where a plugin-contributed instance came from. Absent on built-in kinds.
 * Recorded so an instance whose plugin was removed or downgraded can be
 * reported precisely instead of silently failing to start.
 */
export interface AdapterPluginProvenance {
  pluginId: string
  /** Stable id of the connector contribution inside that plugin. */
  contributionId: string
  /** Plugin version that registered the contribution. */
  pluginRelease: string
}

/**
 * What may be handed to a model from inbound binary media.
 *
 *   - `local_extract_only` — the default and the only safe one: binary bodies
 *     stay local, and only locally-derived text (OCR / transcription) may go
 *     to a model, after passing the PII gate again.
 *   - `allow_cloud_binary` — raw bytes may reach a cloud model. Only ever set
 *     by an explicit, revocable per-conversation grant.
 */
export type MediaModelPolicy = "local_extract_only" | "allow_cloud_binary"

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
   * Bot-wide default for quoting the triggering message on ai-run replies in
   * group / thread scopes (ADR-0009 §3A.3). DEFAULT ON (`undefined`/`true`);
   * `false` turns quoting off for every conversation of this bot unless a
   * `ConversationOverrideRow.replyQuoting` says otherwise. Only meaningful on
   * platforms whose adapter declares `send.reply`. Edited by
   * `components/settings/connections/forms/reply-quoting-default.tsx`.
   * Non-indexed additive.
   */
  replyQuoting?: boolean
  /**
   * Whether this bot's replies may paint interactive A2UI surfaces.
   *
   * Tri-state, and `undefined` is NOT "off": it means "whatever this channel
   * supports", which is what `build-options.ts` has always forced for an IM
   * session whose adapter has a cached capability matrix — an IM reply has no
   * artifact dock, so making A2UI opt-in per bot would degrade every rich reply
   * to plain markdown. `false` is an explicit opt-out for a channel where
   * cards are unwanted; `true` turns it on even before a matrix is cached.
   *
   * Non-indexed additive — no Dexie bump. Read by `resolveSendOptions`.
   */
  a2uiEnabled?: boolean
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
  /** Platform-neutral successor to `atResponseStrategy`; legacy rows map explicitly at read time. */
  inboundActivationPolicy?: InboundActivationPolicy
  /** Default handling of new messages while this adapter already has an active run. */
  activeRunDispatchMode?: ActiveRunDispatchMode
  /** Sliding topic activation lifetime; defaults to 24 hours. */
  activationTtlMs?: number
  /** Runtime-observed delivery readiness; configuration alone never sets this to verified. */
  deliveryReadiness?: DeliveryReadiness
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
  /** Default deployed Visual Workflow when no override or dispatch rule selects a target. */
  defaultWorkflowId?: string
  defaultModel?: string
  defaultProvider?: string
  defaultReasoning?: "low" | "medium" | "high" | "xhigh" | "max"
  /**
   * Composed-mode defaults for this bot (ADR-0117 axes).
   *
   * These are the axis-native successors to `defaultMode`, which stays as the
   * compat mirror: every write sets both, and a read prefers these when
   * present. Keeping `defaultMode` is not sentiment — `InboxSendPolicy.
   * forcedMode` still reads it on the scheduled-digest path, which has no
   * mode router of its own.
   *
   * Non-indexed additive fields — no Dexie bump, matching `defaultTeamId` /
   * `defaultModel` / `defaultReasoning` above.
   */
  defaultAutonomy?: AutonomyLevel
  defaultEngagement?: EngagementMode
  defaultAuthority?: AgentAuthority
  /** Optional channel ceiling over registered built-in skill ids/wildcards. */
  builtInSkillCeiling?: string[]
  /** Optional channel ceiling over host-owned capabilities. Undefined means no extra clamp. */
  hostCapabilityCeiling?: ImHostCapabilityId[]
  /** Default HITL policy for normal write-tier skills; destructive skills always require HITL. */
  requireHitlForWrites?: boolean
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
     * not return it — the Lark adapter backfills this field from the first
     * inbound event that carries a `tenant_key` (see
     * `adapters/lark/index.ts:maybeBackfillTenantKey`).
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
   * The bot's confirmed identity on its platform, written by the startup
   * probe / gateway-ready event / whoami call. Read by the sibling-bot guard,
   * which fails closed when it is absent rather than treating an unknown
   * sender as human.
   */
  selfIdentity?: AdapterSelfIdentitySnapshot
  /**
   * Provenance for plugin-contributed instances; absent for built-in kinds.
   */
  plugin?: AdapterPluginProvenance
  /**
   * Whether raw binary media from this bot may reach a cloud model. Backfilled
   * to `local_extract_only` for every pre-v178 row and defaulted the same way
   * on create, so the permissive value only ever exists where someone set it.
   */
  mediaModelPolicy: MediaModelPolicy
  /**
   * Bot-wide response-SLA target in minutes (IM delegation slice 1B). Used
   * when a conversation has no `ConversationOverrideRow.slaResponseMinutes`
   * of its own: the bus stamps `nextResponseDueAt` from this value on every
   * fresh inbound (`bus.ts` step 3.6) and the runtime backfills it right after
   * the first platform session is created (`stampSlaDeadline`). Non-indexed
   * additive — no Dexie bump. Absent / <= 0 = no default SLA.
   */
  defaultSlaResponseMinutes?: number
  /**
   * Bot-wide SLA escalation chain (slice 1B). Resolved by the escalation
   * sweep as `override.escalation ?? adapter.defaultEscalation`; `undefined`
   * = no escalation. Edited by `sla-escalation-defaults.tsx`. Non-indexed
   * additive — no Dexie bump.
   */
  defaultEscalation?: EscalationPolicy
  /**
   * Which machine runs this instance (ADR-0224). `remote-host` marks a
   * disabled placeholder for an instance that moved to a paired host:
   * `installConnectorRuntime` never builds it and the edit paths refuse it.
   * Written only by `setAdapterInstanceOwner`. Non-indexed additive, so no
   * Dexie bump.
   */
  owner?: ItemOwner
  /**
   * Set when the instance arrived from another device (ADR-0224). A migration
   * replayed after a dropped connection finds the row it created by this.
   */
  provenance?: ItemProvenance
  createdAt: number
  updatedAt: number
}

export type OutboundJobStatus =
  "pending" | "sending" | "sent" | "failed" | "deadlettered" | "delivery_unknown"

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
  | "ai-run"
  | "manual"
  | "workflow"
  | "draft-approved"
  | "skill"
  | "plugin"
  /**
   * A governed Notification V2 delivery (Dexie v227). The job is owned by a
   * `NotificationDeliveryIntent` — the runner still does the send, but the
   * receipt projects back onto the intent rather than a run presentation.
   * Distinct from `"ai-run"` so inbox filters and retry ownership can tell a
   * notification op apart from a run's live card.
   */
  | "notification"

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
 * `[conversationKey+orderSeq]` order (stable FIFO per conversation lane).
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
  /**
   * Last status/state write (Dexie v173, indexed). Every writer in
   * `lib/db/outbound-jobs.ts` stamps it so companion sync can pull an
   * `updatedAt`-cursor delta of this table (ADR-0131 inbox relay). Optional
   * only so pre-v173 backup payloads still type-check; the v173 upgrade
   * backfills `updatedAt = createdAt`.
   */
  updatedAt?: number
  /**
   * `true` on rows mirrored from a paired host by companion sync (ADR-0131).
   * A mirrored row is a status PROJECTION — `request.segments` is empty and
   * the host owns delivery. The local outbound runner never dispatches these
   * (`listDueNow` / `pickNextDue` / `recoverStaleSendingJobs` filter them);
   * they exist so `OutboundStatusPill` / saturation readers work unchanged
   * on a thin client. Non-indexed column.
   */
  syncedFromHost?: true
  /**
   * Monotonic sequence allocated transactionally within a conversation.
   * New rows always carry it; optional only so pre-v151 backup payloads can
   * still be imported and backfilled without lying to TypeScript.
   */
  orderSeq?: number
  /** Claim timestamp used by the indexed stale-sending recovery sweep. */
  claimedAt?: number
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
   * run-presentation runner's in-place card edit path) can correlate
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
  /**
   * Notification V2 operation-authority key (Dexie v227, unique index).
   *
   * Set only on jobs persisted through
   * `persistGovernedNotificationInsideTransaction` — it is the SAME value as
   * the owning `NotificationDeliveryIntent.operationKey`, so the outbound
   * row and the intent share one dedupe/authority identity. Two jobs with
   * the same key are the same operation: the unique index makes a double-
   * persist a constraint violation instead of a duplicate send. Absent on
   * every legacy / non-notification job (the unique index simply does not
   * index rows that lack the field, so they cannot collide).
   */
  notificationOperationKey?: string
  /**
   * What authorized this delivery (ADR-0239), written by the delivery
   * gateway for an automated source. Absent on a person's own send
   * (`manual`, `draft-approved`) and on rows written before the outbound
   * policy existed. Non-indexed JSON column — no schema version bump.
   */
  authorizedBy?: OutboundJobAuthorization
}

/**
 * The authorization an automated delivery rests on (ADR-0239).
 *
 * The receipt holds the full record (targets, root session, epoch, plan); the
 * job keeps only what lets a reader find it and see at a glance who allowed
 * the send.
 */
export interface OutboundJobAuthorization {
  /**
   * The receipt the authorization is recorded on: the chat-tool review of the
   * tool call that made the delivery, or the delivery's own
   * `connector-delivery` receipt. Absent for a reply into the conversation
   * the request came from, which needs no receipt.
   */
  receiptId?: string
  authority: ActionReviewAuthority
  grantScope?: ActionReviewGrantScope
  /** For a `policy` grant: the configured list, e.g. `bot:<installationId>`. */
  policyRef?: string
}
