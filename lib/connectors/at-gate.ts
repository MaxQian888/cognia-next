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
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { appendAudit } from "@/lib/connectors/audit"

export type AtResponseStrategy = "always" | "mention_only" | "direct_only"

/** Default for fresh adapters: safer than "always" — only respond when @-mentioned in groups. */
export const DEFAULT_AT_RESPONSE_STRATEGY: AtResponseStrategy = "mention_only"

export type AtGateReason =
  | "chat_blocklist"
  | "chat_allowlist"
  | "at_mention_required"
  | "at_direct_only"

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
  const decision = shouldRespondToMessage(event, row)
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
