/**
 * Cross-platform inbound-message gate (schema v45, im-refactored-crayon).
 *
 * Originally shipped under `lib/connectors/adapters/lark/at-gate.ts`
 * because Lark was the first platform to wire it in; the body is
 * platform-agnostic and is now reused by Discord / Slack / OneBot /
 * Telegram dispatchers via this shared location.
 *
 * Three orthogonal checks, each evaluated against `AdapterInstanceRow`
 * fields the operator configures in the Adapters detail panel:
 *
 *   1. `chatBlocklist` — if the inbound chat id appears here, deny.
 *   2. `chatAllowlist` — if non-empty AND the inbound chat id is missing
 *      from it, deny. An empty / undefined allowlist is "any chat is fine".
 *   3. `atResponseStrategy`:
 *        - `"always"`        — pass.
 *        - `"mention_only"`  — pass only if the bot was @-mentioned
 *                              (DMs always bypass since they have no
 *                              mention surface).
 *        - `"direct_only"`   — pass only in private 1:1 channels.
 *
 * Returns `{ allowed: true }` when the event should continue down the
 * bus, `{ allowed: false, reason }` when the dispatcher should
 * short-circuit (and audit the block via `inbound.policy_blocked`).
 */

import { isReplyToSelf, type NormalizedInboundEvent } from "@/types/connectors/event"
import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { appendAudit } from "@/lib/connectors/audit"
import {
  resolveInboundActivationPolicy,
  type ConversationAdmissionReason,
} from "@/lib/connectors/conversation-admission"

export type AtResponseStrategy = "always" | "mention_only" | "direct_only"

/** Default for fresh adapters: safer than "always" — only respond when @-mentioned in groups. */
export const DEFAULT_AT_RESPONSE_STRATEGY: AtResponseStrategy = "mention_only"

export type AtGateReason =
  | "chat_blocklist"
  | "chat_allowlist"
  | "at_mention_required"
  | "at_direct_only"
  | ConversationAdmissionReason

/**
 * Observe the operator-authorized Lark no-mention probe after the durable
 * inbound job exists. Returns true when the event was consumed as proof and
 * must remain history-only rather than becoming an Agent turn.
 */
export async function observeUnmentionedDeliveryProbe(
  adapterId: string,
  event: NormalizedInboundEvent,
  row: AdapterInstanceRow
): Promise<boolean> {
  const probe = row.settings.unmentionedDeliveryProbe as
    { startedAt?: number; expiresAt?: number; consoleConfirmed?: boolean } | undefined
  const probeActive =
    probe?.consoleConfirmed === true &&
    typeof probe.startedAt === "number" &&
    typeof probe.expiresAt === "number" &&
    probe.expiresAt >= Date.now()
  if (
    event.platform !== "lark" ||
    event.channel.kind === "private" ||
    event.mentions.selfMentioned ||
    row.deliveryReadiness === "all_messages_verified" ||
    !probeActive
  ) {
    return false
  }
  await updateAdapterInstance(adapterId, {
    deliveryReadiness: "all_messages_verified",
    settings: {
      ...row.settings,
      unmentionedDeliveryProbe: {
        ...probe,
        observedAt: Date.now(),
        sourceMessageId: event.messageId,
      },
    },
  })
  await appendAudit({
    adapterId,
    kind: "inbound.policy_blocked",
    at: Date.now(),
    conversationKey: event.conversationKey,
    reason: "delivery_probe_observed",
  }).catch(() => undefined)
  return true
}

export interface AtGateDecision {
  allowed: boolean
  reason?: AtGateReason
}

function pickChatId(event: NormalizedInboundEvent): string {
  // Prefer the platform-native channel id (e.g. Lark `chat_id`, Slack
  // channel id, Discord channel/guild id) because operators paste those
  // verbatim into the allow/blocklist. Falls back to the bus-level id
  // when the adapter doesn't set the platform-native field.
  return event.channel.platformChannelId ?? event.channel.id
}

/**
 * Predict whether `event` would reach the AI, given this adapter's guardrails.
 *
 * NOT on the host inbound path. `gateInboundEvent` enforces only the chat
 * allow/blocklist at the transport edge; the mention half belongs to
 * `admitConversationEvent`, which runs in the bus after the durable job exists
 * and after conversation overrides resolve. Its one production caller is
 * `ctx.connectors.previewAtGate` — a plugin asking "would this message be
 * answered?" without sending it.
 *
 * Because it is a PREDICTION, it resolves the admission policy the same way the
 * bus does (`resolveInboundActivationPolicy`, which maps the legacy
 * `atResponseStrategy` too). It used to read `atResponseStrategy` raw, so it
 * predicted from a field the current settings UI no longer writes and disagreed
 * with the host for every adapter configured since.
 *
 * Every other branch `admitConversationEvent` decides is reproduced here,
 * including the Lark `delivery_unverified` gate that `always` and
 * `mention_activates` both pass through — a prediction that answered "allowed"
 * where the host answers "delivery_unverified" is worse than no prediction.
 *
 * One branch it cannot fully reproduce: `mention_activates` in a thread also
 * admits a follow-up inside an ALREADY-ACTIVE window, which lives in stored
 * activation state this pure function has no access to. It predicts the
 * first-contact answer there (`topic_activation_required`), which is the
 * conservative one and names the state that would decide.
 *
 * Only `kind === "create"` events are gated — edit / delete / system events
 * pass through unchanged because admission is about responding to fresh
 * messages.
 */
export function shouldRespondToMessage(
  event: NormalizedInboundEvent,
  adapter: AdapterInstanceRow,
  override?: Pick<ConversationOverrideRow, "inboundActivationPolicy"> | null
): AtGateDecision {
  if (event.kind && event.kind !== "create") {
    return { allowed: true }
  }

  const chatId = pickChatId(event)

  if (adapter.chatBlocklist && adapter.chatBlocklist.includes(chatId)) {
    return { allowed: false, reason: "chat_blocklist" }
  }

  if (
    adapter.chatAllowlist &&
    adapter.chatAllowlist.length > 0 &&
    !adapter.chatAllowlist.includes(chatId)
  ) {
    return { allowed: false, reason: "chat_allowlist" }
  }

  const policy = resolveInboundActivationPolicy(adapter, override ?? undefined)
  const isDm = event.channel.kind === "private"
  // Private chats are admitted before the policy is consulted at all, matching
  // `admitConversationEvent`'s first line — `direct_only` included, since a DM
  // is exactly what that policy is for.
  if (isDm) return { allowed: true }

  // A reply to one of OUR messages is as direct an address as a mention, and
  // `defaultGroupChatPolicy()` gates on both — so this gate has to accept it or
  // the `reply-to-bot` trigger rule never reaches the bus. Strict
  // `parentSenderId` matching keeps it from over-matching; the parent is filled
  // by the adapter parser here, and by `gateInboundEvent` from the
  // delivered-message ledger for the wire shapes that omit it.
  const addressesUs = event.mentions.selfMentioned || isReplyToSelf(event)
  // `delivery_unverified` tests `selfMentioned` ALONE, matching the host: that
  // gate is about whether the platform will push unmentioned group events to
  // us at all, which a reply says nothing about.
  const deliveryVerified = adapter.deliveryReadiness === "all_messages_verified"

  switch (policy) {
    case "always":
      // Lark only delivers unmentioned group messages once the operator has
      // proven it — until then `always` still needs a mention, exactly as
      // `admitConversationEvent` decides it.
      if (adapter.type !== "lark" || deliveryVerified) return { allowed: true }
      return event.mentions.selfMentioned
        ? { allowed: true }
        : { allowed: false, reason: "delivery_unverified" }
    case "direct_only":
      return { allowed: false, reason: "at_direct_only" }
    case "mention_each":
      return addressesUs ? { allowed: true } : { allowed: false, reason: "at_mention_required" }
    case "mention_activates":
      // Activation is limited to explicit thread scopes; a parent group keeps
      // requiring a mention every time.
      if (event.channel.kind !== "thread") {
        return addressesUs ? { allowed: true } : { allowed: false, reason: "at_mention_required" }
      }
      if (!deliveryVerified) {
        return event.mentions.selfMentioned
          ? { allowed: true }
          : { allowed: false, reason: "delivery_unverified" }
      }
      if (addressesUs) return { allowed: true }
      // The one branch a pure function cannot reproduce: an already-open
      // activation window would admit this. Predicting first contact is the
      // conservative answer, and it names the state that decides.
      return { allowed: false, reason: "topic_activation_required" }
  }
}

// ── Sibling-bot interplay budget (W5 multi-bot same-group) ──────────────────
// When `siblingBotPolicy === "respond"`, each (adapterId, chatId) pair may
// AI-respond to at most `botInterplayBudget` sibling-bot messages per sliding
// hour. In-memory by design: the budget is an anti-loop damper, not an
// accounting ledger — a restart resetting it is acceptable (and safe, since
// the default policy is "ignore").

/** Default sibling-bot responses per chat per hour when the row sets none. */
export const DEFAULT_BOT_INTERPLAY_BUDGET = 4

const INTERPLAY_WINDOW_MS = 60 * 60 * 1000

/** Epoch-ms timestamps of consumed responses, keyed `${adapterId} ${chatId}`. */
const interplayLedger = new Map<string, number[]>()

/** Test-only: wipe the sliding-hour ledger between cases. */
export function __resetSiblingInterplayBudgetForTesting(): void {
  interplayLedger.clear()
}

/**
 * Try to consume one sibling-response slot for (adapterId, chatId). Returns
 * `true` (and records the spend) while under `budget` in the trailing hour,
 * `false` once the budget is exhausted. `now` is injectable for tests.
 */
export function consumeSiblingInterplayBudget(
  adapterId: string,
  chatId: string,
  budget: number,
  now: number = Date.now()
): boolean {
  const key = `${adapterId} ${chatId}`
  const cutoff = now - INTERPLAY_WINDOW_MS
  const spent = (interplayLedger.get(key) ?? []).filter((t) => t > cutoff)
  if (spent.length >= budget) {
    interplayLedger.set(key, spent)
    return false
  }
  spent.push(now)
  interplayLedger.set(key, spent)
  return true
}

/**
 * Runtime wrapper used by every adapter dispatcher (Telegram / Discord /
 * Slack / Lark / OneBot) immediately before `ctx.emit()`.
 *
 *   - looks up the adapter row (best-effort; fails OPEN on Dexie miss so a
 *     transient read failure doesn't silently drop every message)
 *   - calls `shouldRespondToMessage`
 *   - on deny, audits `inbound.policy_blocked` with the gate's reason
 *   - returns `false` to tell the caller to skip emitting
 *
 * Callers typically write:
 *
 *     if (event) {
 *       if (!(await gateInboundEvent(adapterId, event))) return
 *       await ctx.emit(event)
 *     }
 */
export async function gateInboundEvent(
  adapterId: string,
  event: NormalizedInboundEvent
): Promise<boolean> {
  const row = await getAdapterInstance(adapterId).catch(() => undefined)
  if (!row) return true

  // The sibling-bot guard used to live here, ahead of the chat allow/blocklist
  // below. That was wrong twice over. It ran before the durable inbound job
  // existed, so a suppressed sibling message left no history at all; and it
  // spent a slot of the per-chat interplay budget before anything had decided
  // the message would even be answered — a sibling posting into a BLOCKED chat
  // still burned budget, and so did one whose trigger matched no rule.
  //
  // It now runs in the bus (`bus.ts` step 9.6), after the job is persisted and
  // after the route is decided, so the budget is only ever spent on a response
  // that is actually about to be enqueued. See `sibling-bots.ts`.

  // Chat allow/block lists are transport guardrails and remain ahead of the
  // conversation-aware policy. Do not run the legacy mention branch here:
  // `admitConversationEvent` explicitly maps legacy values and also resolves
  // topic activation state + per-conversation overrides.
  const chatId = pickChatId(event)
  let decision: AtGateDecision
  if (row.chatBlocklist?.includes(chatId)) {
    decision = { allowed: false, reason: "chat_blocklist" }
  } else if (row.chatAllowlist?.length && !row.chatAllowlist.includes(chatId)) {
    decision = { allowed: false, reason: "chat_allowlist" }
  } else {
    // Admission belongs to the bus, after durable job creation and override
    // resolution. Transport adapters only enforce chat/sibling guardrails.
    decision = { allowed: true }
  }
  if (decision.allowed) return true
  await appendAudit({
    adapterId,
    kind: "inbound.policy_blocked",
    at: Date.now(),
    conversationKey: event.conversationKey,
    reason: decision.reason,
  }).catch(() => undefined)
  return false
}
