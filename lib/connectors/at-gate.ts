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

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { appendAudit } from "@/lib/connectors/audit"
import { findSiblingBotSender } from "@/lib/connectors/sibling-bots"
import {
  admitConversationEvent,
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
 * Decide whether `event` should reach `ctx.emit()` given the adapter's
 * configured guardrails. Only `kind === "create"` events are gated —
 * edit / delete / system events pass through unchanged because the
 * at-strategy is about responding to fresh messages.
 */
export function shouldRespondToMessage(
  event: NormalizedInboundEvent,
  adapter: AdapterInstanceRow
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

  const strategy: AtResponseStrategy = adapter.atResponseStrategy ?? DEFAULT_AT_RESPONSE_STRATEGY
  const isDm = event.channel.kind === "private"

  switch (strategy) {
    case "always":
      return { allowed: true }
    case "mention_only":
      if (isDm) return { allowed: true }
      if (event.mentions.selfMentioned) return { allowed: true }
      return { allowed: false, reason: "at_mention_required" }
    case "direct_only":
      if (isDm) return { allowed: true }
      return { allowed: false, reason: "at_direct_only" }
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

  // ── Sibling-bot anti-loop guard (W5) ─────────────────────────────────
  // Only fresh messages can start a bot↔bot loop; edits / deletes / system
  // events pass through like everywhere else in this gate. The check sits
  // in this async wrapper (not the sync `shouldRespondToMessage`) so every
  // adapter dispatcher inherits it without a signature ripple.
  if (!event.kind || event.kind === "create") {
    const sibling = await findSiblingBotSender(event).catch(() => null)
    if (sibling) {
      const policy = row.siblingBotPolicy ?? "ignore"
      if (policy === "ignore") {
        await appendAudit({
          adapterId,
          kind: "inbound.sibling_bot_ignored",
          at: Date.now(),
          conversationKey: event.conversationKey,
          fields: { siblingAdapterId: sibling.id },
        }).catch(() => undefined)
        return false
      }
      const budget = row.botInterplayBudget ?? DEFAULT_BOT_INTERPLAY_BUDGET
      const chatId = event.channel.platformChannelId ?? event.channel.id
      if (!consumeSiblingInterplayBudget(adapterId, chatId, budget)) {
        await appendAudit({
          adapterId,
          kind: "inbound.sibling_bot_budget_exhausted",
          at: Date.now(),
          conversationKey: event.conversationKey,
          fields: { siblingAdapterId: sibling.id, budget },
        }).catch(() => undefined)
        return false
      }
      // Under budget — fall through to the normal mention/allowlist gates.
    }
  }

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
    // Receiving one unmentioned Lark group event is the only authoritative
    // runtime proof that `im:message.group_msg` delivery is active. Persist the
    // proof for future events, but keep evaluating this probe against the
    // previously effective policy so it cannot unexpectedly start a turn.
    if (
      event.platform === "lark" &&
      event.channel.kind !== "private" &&
      !event.mentions.selfMentioned &&
      row.deliveryReadiness !== "all_messages_verified"
    ) {
      await updateAdapterInstance(adapterId, {
        deliveryReadiness: "all_messages_verified",
      }).catch(() => undefined)
    }
    decision = await admitConversationEvent(event, row)
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
