/**
 * Trigger policy evaluator — Task 26.
 *
 * Pure function: no side-effects, no I/O. State is injected so the caller
 * (the bus dispatch pipeline) owns the mutable buckets and can update them
 * after a decision is made.
 */

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { TriggerBlocker, TriggerPolicy, TriggerRule } from "@/types/connectors/policy"

/**
 * Snapshot of the rate-limit / cooldown counters at dispatch time.
 * The evaluator NEVER mutates this object — mutation happens externally
 * after `evaluatePolicy` returns.
 */
export interface PolicyEvalState {
  /** Last bot reply timestamp per conversationKey. */
  recentBotReplyAtByConversation: Record<string, number>
  /**
   * Recent inbound timestamps per `rateBucketKey(event)`.
   * Used by the `rate-limit` blocker.
   */
  recentByUserAndChannel: Record<string, number[]>
}

/**
 * Bucket key for the inbound rate limiter: `${tenant}|${userId}:${channelId}`.
 *
 * The tenant prefix is what makes a per-workspace ceiling expressible at all —
 * the per-user and per-channel buckets bound one person and one room, and
 * neither bounds a tenant. Exported so the bus writes the same key the
 * evaluator reads; two spellings of this would silently disable the limiter.
 */
export function rateBucketKey(event: NormalizedInboundEvent): string {
  return `${rateTenantScope(event)}|${event.sender.id}:${event.channel.id}`
}

/** Tenant discriminator, or `-` when the platform does not report one. */
export function rateTenantScope(event: NormalizedInboundEvent): string {
  const scope = event.channelData?.identityScope
  if (scope && typeof scope === "object") {
    const tenantKey = (scope as Record<string, unknown>).tenantKey
    if (typeof tenantKey === "string" && tenantKey) return tenantKey
  }
  return "-"
}

export interface PolicyEvalResult {
  matched: boolean
  blocked: boolean
  reason?: string
}

// ── rule helpers ──────────────────────────────────────────────────────────────

function matchRule(rule: TriggerRule, event: NormalizedInboundEvent): boolean {
  switch (rule.kind) {
    case "private-default":
      return event.channel.kind === "private"

    case "self-mention":
      return event.mentions.selfMentioned

    case "reply-to-bot": {
      // Exact match: the replied-to message must have been authored by this
      // bot. `parentSenderId` is filled either by the adapter parser (when the
      // wire shape carries the parent author) or by the bus from the
      // delivered-message ledger before evaluation. Unknown parent ⇒ NOT a
      // reply to the bot (strict, never over-matches).
      const parent = event.replyTo?.parentSenderId
      return parent !== undefined && parent !== "" && parent === event.selfId
    }

    case "slash-command": {
      const text = event.plainText.trimStart()
      return rule.prefixes.some((p) => text.startsWith(p))
    }

    case "keyword": {
      const haystack = rule.caseInsensitive ? event.plainText.toLowerCase() : event.plainText
      return rule.words.some((w) => {
        const needle = rule.caseInsensitive ? w.toLowerCase() : w
        return haystack.includes(needle)
      })
    }

    case "user-allowlist":
      return rule.userIds.includes(event.sender.id)

    case "channel-allowlist":
      return rule.channelIds.includes(event.channel.id)
  }
}

// ── blocker helpers ───────────────────────────────────────────────────────────

function checkBlocker(
  blocker: TriggerBlocker,
  event: NormalizedInboundEvent,
  state: PolicyEvalState,
  now: number
): string | null {
  switch (blocker.kind) {
    case "user-blocklist":
      if (blocker.userIds.includes(event.sender.id)) return "user-blocklist"
      return null

    case "channel-blocklist":
      if (blocker.channelIds.includes(event.channel.id)) return "channel-blocklist"
      return null

    case "keyword-blocklist": {
      const text = event.plainText
      if (blocker.words.some((w) => text.includes(w))) return "keyword-blocklist"
      return null
    }

    case "rate-limit": {
      const bucketKey = rateBucketKey(event)
      const window = now - 60_000
      const recent = (state.recentByUserAndChannel[bucketKey] ?? []).filter((t) => t > window)
      if (recent.length >= blocker.perUserPerMin) return "rate-limit (user bucket)"
      // Channel bucket: sum across all users for this channel
      const channelTotal = Object.entries(state.recentByUserAndChannel)
        .filter(([key]) => key.endsWith(`:${event.channel.id}`))
        .flatMap(([, ts]) => ts)
        .filter((t) => t > window).length
      if (channelTotal >= blocker.perChannelPerMin) return "rate-limit (channel bucket)"
      // Tenant bucket: every sender and chat under one workspace. Opt-in, so
      // single-tenant installs keep exactly today's behavior.
      if (blocker.perTenantPerMin !== undefined) {
        const prefix = `${rateTenantScope(event)}|`
        const tenantTotal = Object.entries(state.recentByUserAndChannel)
          .filter(([key]) => key.startsWith(prefix))
          .flatMap(([, ts]) => ts)
          .filter((t) => t > window).length
        if (tenantTotal >= blocker.perTenantPerMin) return "rate-limit (tenant bucket)"
      }
      return null
    }

    case "cooldown-after-bot-reply": {
      const lastReplyAt = state.recentBotReplyAtByConversation[event.conversationKey]
      if (lastReplyAt !== undefined && now - lastReplyAt < blocker.secs * 1000) {
        return `cooldown-after-bot-reply (${blocker.secs}s)`
      }
      return null
    }
  }
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Evaluate a `TriggerPolicy` against a normalised inbound event.
 *
 * @param policy  - The resolved trigger policy (from `policy-resolve.ts`).
 * @param event   - The normalised inbound event.
 * @param state   - Current rate-limit / cooldown counters (NOT mutated).
 * @param now     - Current timestamp in ms; defaults to `Date.now()`.
 * @returns       - `{ matched, blocked, reason? }`.
 *                  Rules are OR — any match → `matched = true`.
 *                  Blockers are AND-NOT — any match → `blocked = true`.
 *                  Matched and blocked are evaluated independently.
 */
export function evaluatePolicy(
  policy: TriggerPolicy,
  event: NormalizedInboundEvent,
  state: PolicyEvalState,
  now: number = Date.now()
): PolicyEvalResult {
  // Rules — OR semantics
  const matched = policy.rules.length > 0 && policy.rules.some((r) => matchRule(r, event))

  // Blockers — first match short-circuits
  for (const blocker of policy.blockers) {
    const reason = checkBlocker(blocker, event, state, now)
    if (reason !== null) {
      return { matched, blocked: true, reason }
    }
  }

  return { matched, blocked: false }
}
