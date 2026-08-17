/**
 * Unified inbound-callback envelope.
 *
 * Platforms that ship interactive rich content (Slack Block Kit buttons /
 * Lark interactive cards / Telegram inline keyboards / Discord message
 * components) deliver user actions through platform-specific payloads:
 *
 *   - Slack:    `block_actions` POST with `actions[]`, container.message_ts
 *   - Lark:     `im.interactive_message.action_triggered_v1`
 *   - Telegram: `callback_query` update with opaque `data` string
 *   - Discord:  `INTERACTION_CREATE` dispatch (components / modal_submit)
 *
 * Each adapter parser normalises its native payload into the shape below
 * and hands it to `ConnectorBus.dispatchConnectorCallback`. The bus then:
 *
 *   1. dedupes against `recordAndCheckInbound(triggerId, "callback")`,
 *   2. writes an audit row,
 *   3. routes to the `a2ui-bridge` MCP server's
 *      `a2ui_handle_connector_action` tool, which injects an A2UI
 *      ActionEvent on the matching surface so the assistant's next turn
 *      sees the interaction as if the user had clicked inside the
 *      browser/Tauri renderer.
 *
 * `surfaceId` and `componentId` are recovered by the adapter at parse
 * time — either by reading the action_id we baked in at outbound (the
 * mapper assigns IDs like `a2ui:<surfaceId>:<componentId>:<action>` so
 * round-trip is deterministic), or via the `connectorCallbackBindings`
 * lookup when the platform forces opaque IDs (Telegram limits
 * `callback_data` to 64 bytes).
 *
 * OneBot is intentionally absent: the OneBot v11 / v12 protocols do not
 * define an interactive-message concept. Adapters for OneBot never emit
 * `ConnectorCallbackEvent`.
 */

import type { PlatformKind } from "./platform-kind"
import type { PlatformIdentity } from "./event"

export type ConnectorCallbackActionType =
  // A2UI Button.action — `value` carries the action identifier
  | "button"
  // A2UI Select / RadioGroup — `value` is the chosen option key
  | "select"
  // A2UI Checkbox / Switch — `value` is "true"/"false"
  | "checkbox"
  // A2UI TextField / TextArea inline edit — `value` is the new text
  | "input"
  // A2UI Form / modal submit — `payload` holds the full form values
  | "submit"
  // Slack view_closed, Lark card dismiss, Discord modal cancel — `value` is empty
  | "dismiss"
  // Generic catch-all for platform-specific interactions the bridge
  // should still surface as an event (e.g., Slack `external_select`
  // dynamic option requests). `payload` carries the platform-specific
  // shape; the assistant decides what to do with it.
  | "platform_specific"

export interface ConnectorCallbackEvent {
  platform: PlatformKind
  adapterId: string
  /** Identifier of the bot/app that received the callback. */
  selfId: string
  /**
   * Unique per-callback id. Used by the dedup ledger (namespace
   * `"callback"`) and as the audit row primary key. Must be stable
   * across redeliveries — adapters that don't get a real id from the
   * platform fabricate one from `(adapterId, signature, payloadHash)`.
   */
  triggerId: string
  /**
   * A2UI surface this callback targets. Recovered from the
   * `connectorCallbackBindings` Dexie table or directly parsed out of
   * the action_id when the platform allows long opaque payloads.
   */
  surfaceId: string
  /**
   * The A2UI component id (inside the surface's `components` map) that
   * fired the action. Optional because some platforms emit surface-level
   * actions (e.g., view dismiss) without a component anchor.
   */
  componentId?: string
  actionType: ConnectorCallbackActionType
  /**
   * Primary value for single-value actions (button action id, selected
   * option key, checkbox boolean as string, etc.). Empty for `submit`
   * and `platform_specific`.
   */
  value: string
  /**
   * Full structured payload for multi-value actions (form submissions,
   * platform_specific events). Adapters keep payload keys aligned with
   * the A2UI component's dataModel path so the bridge can patch the
   * surface model directly.
   */
  payload?: Record<string, unknown>
  /**
   * The platform-side message id this callback originated from. Useful
   * for adapters that need to ack the platform (`tg.answerCallbackQuery`,
   * Slack `response_url`, Lark card update) after the assistant responds.
   */
  originatingMessageId?: string
  /**
   * Optional conversation key — populated when the platform surfaces the
   * channel where the click happened. The bridge uses it to scope the
   * assistant's next turn to the right ChatSession.
   */
  conversationKey?: string
  /**
   * User who triggered the callback. The bridge passes this through to
   * the assistant so policies (per-user allowlist / blocklist) can apply.
   */
  user: PlatformIdentity
  /**
   * Platform tenancy of the VERIFIED callback envelope (Lark: header
   * tenant_key / app_id). Consumed by the callback authorization guard to
   * resolve the clicking principal (plan 2026-07-24 Phase 2). Optional:
   * absent on platforms without tenant scoping and on legacy envelopes.
   */
  identityScope?: { tenantKey?: string; appId?: string }
  /** Wall-clock at which the platform fired the event. */
  timestamp: number
  /**
   * Raw platform payload, kept for the audit log and so the adapter's
   * ack-step can look up its own fields without re-parsing. Bus does not
   * inspect.
   */
  raw: unknown
}

/**
 * Discriminator on `ConnectorCallbackBindingRow.kind` — added at schema v41
 * so the binding table can host more than just the v38 callback-query case.
 *
 *   - `"callback_query"` — Slack `block_actions`, Discord `MESSAGE_COMPONENT`
 *                          INTERACTION_CREATE, Lark `action_triggered_v1`,
 *                          Telegram `callback_query`. **Default for rows
 *                          persisted before v41.**
 *   - `"force_reply"`    — Telegram ForceReply correlation: the row is
 *                          created when the assistant sends a message with
 *                          `reply_markup.force_reply`; the parser matches the
 *                          inbound `reply_to_message.message_id` against
 *                          stored bindings to recover the surface + component
 *                          that asked for input.
 *   - `"modal_open"`     — Discord button → modal double-hop: the row is
 *                          created when the assistant sends a button labelled
 *                          "Fill form"; on `MESSAGE_COMPONENT` the parser
 *                          looks up the binding to know which TextInput /
 *                          StringSelect to wrap into a modal response.
 *   - `"block_action"`   — generic platform interaction that's neither a
 *                          callback_query nor a form (e.g., Slack
 *                          `external_select` dynamic option requests).
 *   - `"skill_invoke"`   — A2UI confirm-card → built-in skill invocation
 *                          (ADR-0026). The binding row carries the
 *                          deferred `{skillId, args}` in `payload`; on
 *                          inbound callback the bus reads the payload and
 *                          re-fires the skill with HITL bypass.
 *   - `"wf_approve"`     — A2UI Approve button on a workflow-by-name
 *                          run prompt. Payload carries `{workflowId,
 *                          runParams, triggeredFrom}`; on click the bus
 *                          dispatches into `startWorkflowFromIM` and
 *                          enqueues a "started" outbound — no model turn.
 *   - `"wf_cancel"`      — A2UI Cancel button companion to `"wf_approve"`.
 *                          Payload mirrors `"wf_approve"` so the cancel
 *                          handler can confirm provenance before enqueuing
 *                          the "cancelled" outbound and deleting the
 *                          sibling approve binding.
 *   - `"numeric_action"` — Personal WeChat A2UI fallback. Mirror text
 *                          carries "1) … 2) …" numeric markers; the
 *                          payload stores `{numeric, conversationKey}` so
 *                          the (future) parser-side resolver can route an
 *                          inbound "1" / "2" reply back to the original
 *                          component. Outbound binding-write only in v1;
 *                          inbound dispatch lands later.
 *   - `"wf_fanout_approve"` — A2UI Approve button on the workflow
 *                            fan-out confirmation card. Payload carries
 *                            `{workflowId, workflowName, target:{adapterId,
 *                            conversationKey}, createdBy}`; on click the
 *                            bus writes the `workflowFanoutSubscriptions`
 *                            row + enqueues a "✅ 已订阅" outbound. No
 *                            model turn.
 *   - `"wf_fanout_cancel"`  — A2UI Cancel companion to `wf_fanout_approve`.
 *                            Drops both binding rows + enqueues "⊘
 *                            已取消".
 *   - `"help_quick_command"` — A button on a cross-provider help / welcome
 *                            card that, when clicked, runs a configured IM
 *                            quick command. Payload carries the resolved
 *                            `{action:{type,value}}`; on click the bus
 *                            synthesises a `create` inbound event (with
 *                            `selfMentioned: true` so an explicit click is
 *                            never dropped by the at-gate) and re-enters
 *                            `dispatchInboundFull`, exactly as if the user
 *                            had typed the command or clicked the native
 *                            bot menu. Platform-agnostic — emitted by
 *                            `lib/connectors/help/build-help-surface.ts`.
 */
export type ConnectorCallbackBindingKind =
  | "callback_query"
  | "force_reply"
  | "modal_open"
  | "block_action"
  | "skill_invoke"
  | "wf_approve"
  | "wf_cancel"
  | "numeric_action"
  | "wf_fanout_approve"
  | "wf_fanout_cancel"
  | "help_quick_command"
  // A2UI tool-permission approval card (control-plane HITL). A button press
  // resolves a pending `permission_request` for an ask-tier tool in an IM
  // auto-mode turn. Payload carries `{ sessionId, requestId, toolName }`; the
  // button's `value` / action carries the decision (allow | deny |
  // allow_session). See `lib/connectors/hitl/`.
  | "tool_approve"
  // Issue tracker card (ADR-0132 slice ③). A button on an issue card: move
  // the issue to a legal human-owned status, dispatch it to its assigned
  // engine, or (on the create-issue confirmation card) file it into a
  // project. Payload carries `{ issueId, action, to? }` or, for creation,
  // `{ draft, issueProjectId }`. Move/run buttons stay re-clickable; the
  // creation confirmation is consumed once. See `lib/issues/im/`.
  | "issue_action"

/**
 * Persisted association between an outbound A2UI surface and the
 * platform-specific identifiers we need to route inbound callbacks back
 * to it.
 *
 * Stored in Dexie table `connectorCallbackBindings` added at schema v38;
 * the `kind` discriminator was added at v41.
 * One row per (adapter, surface, component, action) combination written
 * by the A2UI mapper at outbound time; read by the parser at callback
 * arrival.
 *
 *   - Slack:    `actionId` = the Slack `action_id` we generated.
 *   - Lark:     `actionId` = the `value.tag` we baked into the card.
 *   - Telegram: `actionId` = an opaque short id (Telegram caps
 *                 callback_data at 64 bytes, so we keep a lookup row).
 *                 For ForceReply bindings the `actionId` is the platform
 *                 message_id of the sent prompt — that's what the parser
 *                 matches against inbound `reply_to_message.message_id`.
 *   - Discord:  `actionId` = the `custom_id` we generated.
 */
export interface ConnectorCallbackBindingRow {
  /** `${adapterId}:${actionId}` */
  id: string
  adapterId: string
  /** Platform-side callback identifier. */
  actionId: string
  /**
   * Discriminator so the bus can route inbound platform events to the
   * right correlation path (callback button vs. ForceReply vs. modal-open
   * vs. generic block action). Rows persisted before v41 backfill to
   * `"callback_query"`.
   */
  kind: ConnectorCallbackBindingKind
  surfaceId: string
  componentId?: string
  conversationKey?: string
  /** When the binding was written — used by LRU prune to drop old rows. */
  createdAt: number
  /** Optional explicit TTL ms-since-epoch. */
  expiresAt?: number
  /**
   * Free-form structured payload the bus passes to the kind-specific
   * dispatcher. Added at v43 to support `kind: "skill_invoke"` — stores
   * the deferred built-in skill `{skillId, args}` so the inbound callback
   * can re-fire the skill with HITL bypass. Other kinds may use it for
   * platform-specific carryover (e.g., Slack `viewPayload` for the
   * `modal_open` two-hop).
   */
  payload?: Record<string, unknown>
  // ── Callback authorization guard fields (plan 2026-07-24 Phase 2) ────
  // All optional and absent on every pre-existing row: `&id`-keyed table, so
  // no Dexie version is needed. The guard applies deterministic per-kind
  // legacy fallbacks when `actorScope` is missing (see
  // lib/connectors/callback-authorization.ts); legacy rows age out within
  // the 30-day binding TTL.
  /** Cognia account the surface was emitted under. */
  accountId?: string
  /** Who may activate this callback. Absent → per-kind legacy fallback. */
  actorScope?: CallbackActorScope
  /** Action values this binding may perform (e.g. ["approve","cancel"]). */
  allowedActions?: string[]
  /** Set on first successful activation of a consume-once kind. */
  consumedAt?: number
}

/**
 * Actor authorization scope for a callback binding (plan 2026-07-24 P2.1).
 *
 *   - `"initiator"`    — only the users in `allowedUserIds` (typically the
 *                        run/request initiator) plus configured operators.
 *   - `"operators"`    — `allowedUserIds` ∪ the adapter's
 *                        `settings.runOperatorUserIds`.
 *   - `"conversation"` — anyone inside the bound conversation (the platform
 *                        guarantees the click came from that chat).
 *   - `"anyone"`       — no actor restriction (help/welcome surfaces).
 */
export interface CallbackActorScope {
  mode: "initiator" | "operators" | "conversation" | "anyone"
  /** Platform remoteUserIds (Lark open_id). Used by initiator/operators. */
  allowedUserIds?: string[]
}
