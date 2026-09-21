/**
 * In-process registry of pending `ask_user` elicitation prompts (control-plane
 * HITL), sibling to `approval-registry.ts`.
 *
 * When the `ask_user` tool fires during an IM turn, `runImAskUser`
 * (`ask-user-question.ts`) projects an A2UI question card to the conversation
 * and `await`s a Promise registered here, keyed by `${sessionId}:${toolUseId}`.
 * The `plugin_tool_exec` round-trip holds the tool call until that Promise
 * resolves — so the turn suspends without any custom suspend/resume machinery.
 * The IM-side callback (`bus.dispatchConnectorCallback` → `ask_user`
 * short-circuit → `applyAskUserCallback`) resolves it, mutates its `selected`
 * set on multi-select toggles, or the TTL/abort path settles it.
 *
 * A TTL backstop resolves a stale prompt as `expired` so a forgotten card can
 * never wedge a turn open forever. Producer (`runImAskUser`) and resolver
 * (callback) run in the same renderer process, so a module-level singleton is
 * the correct shared channel.
 */

import type { AskUserAnswer, AskUserRequest } from "@/lib/claude/ask-user-tool"
import type { ConversationDeliveryTarget, ConversationReference } from "@/types/connectors/event"
import type { CallbackActorScope } from "@/types/connectors/interaction"

/** Default time a question card waits for an answer before expiring. */
export const DEFAULT_ASK_USER_TTL_MS = 10 * 60 * 1000

export type AskUserSettleReason = "answered" | "cancelled" | "expired" | "aborted"

export interface AskUserSettlement {
  answer: AskUserAnswer
  /**
   * Why the prompt settled. `answered` — a real answer arrived; `cancelled` —
   * the user skipped/dismissed; `expired` — the TTL elapsed; `aborted` — the
   * owning run ended (adapter teardown, stop, turn end).
   */
  reason: AskUserSettleReason
  /**
   * Platform message id of the question card, when the settling callback
   * carried one (`event.originatingMessageId`). Lets the freeze edit skip the
   * outbound-job → message-id wait.
   */
  messageId?: string
}

/**
 * Card/delivery metadata the pending entry carries so the callback dispatcher
 * can re-render (multi-select toggle) and freeze the original card without
 * re-deriving context.
 */
export interface PendingAskUserMeta {
  surfaceId: string
  request: AskUserRequest
  adapterId: string
  conversationKey: string
  conversationRef: ConversationReference
  deliveryTarget?: ConversationDeliveryTarget
  /** Outbound job id of the question card — resolves the platform message id. */
  jobId?: string
  /** Who may answer — enforced by the bus guard via bindings AND re-checked by
   *  the dispatcher for binding-less events (Telegram ForceReply replies). */
  actorScope: CallbackActorScope
  /** remoteUserId of the run initiator (for dispatcher-side scope checks). */
  initiatorUserId?: string
  /** Component id of the free-text input, when the card has one. */
  textComponentId?: string
  /** Binding expiry hint stamped on the components — reused on toggle edits. */
  bindingExpiresAt?: number
}

export interface PendingAskUser {
  sessionId: string
  toolUseId: string
  meta: PendingAskUserMeta
  /**
   * Currently toggled option values (multi-select). Mutated in place by
   * `toggleAskUserValue`; read on `submit` / `submit_text` so a typed answer
   * keeps any options the user already picked.
   */
  selected: string[]
  settle: (settlement: AskUserSettlement) => void
  timer: ReturnType<typeof setTimeout> | null
}

const pending = new Map<string, PendingAskUser>()

function key(sessionId: string, toolUseId: string): string {
  return `${sessionId}:${toolUseId}`
}

export interface AwaitAskUserOptions {
  ttlMs?: number
  /** Close the prompt when its owning run ends. */
  signal?: AbortSignal
  /** Card + delivery context the dispatcher needs for toggle edits. */
  meta: PendingAskUserMeta
}

/**
 * Register a pending prompt and return a Promise that settles when the user
 * answers (or skips) via `resolveAskUser`, the TTL elapses (`expired`), or the
 * owner aborts (`aborted`). A duplicate toolUseId supersedes the prior entry,
 * settling it as `cancelled` — the sidecar never reissues a toolUseId, so a
 * duplicate means a stale registration.
 */
export function awaitAskUser(
  sessionId: string,
  toolUseId: string,
  opts: AwaitAskUserOptions
): Promise<AskUserSettlement> {
  const cancelled: AskUserSettlement = {
    answer: { selected: [], text: "", cancelled: true },
    reason: "aborted",
  }
  if (opts.signal?.aborted) return Promise.resolve(cancelled)

  const k = key(sessionId, toolUseId)
  // Resolve any stale entry for the same key before replacing it.
  const prior = pending.get(k)
  if (prior) {
    if (prior.timer) clearTimeout(prior.timer)
    prior.settle({
      answer: { selected: [], text: "", cancelled: true },
      reason: "cancelled",
    })
    pending.delete(k)
  }

  // Same rationale as approvals: a non-positive TTL would wedge the turn on a
  // forgotten card forever, so the watchdog always exists.
  const ttlMs = opts.ttlMs !== undefined && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_ASK_USER_TTL_MS
  const promise = new Promise<AskUserSettlement>((resolve) => {
    const settle = (settlement: AskUserSettlement) => {
      opts.signal?.removeEventListener("abort", abort)
      resolve(settlement)
    }
    const entry: PendingAskUser = {
      sessionId,
      toolUseId,
      meta: opts.meta,
      selected: [],
      settle,
      timer: null,
    }
    const abort = () => {
      if (!pending.delete(k)) return
      if (entry.timer) clearTimeout(entry.timer)
      settle(cancelled)
    }
    entry.timer = setTimeout(() => {
      if (!pending.delete(k)) return
      settle({ answer: { selected: [], text: "", cancelled: true }, reason: "expired" })
    }, ttlMs)
    pending.set(k, entry)
    opts.signal?.addEventListener("abort", abort, { once: true })
  })
  return promise
}

/**
 * Settle a pending prompt. `reason` defaults to `"answered"`. Returns `true`
 * when a matching pending entry existed, `false` otherwise (already settled /
 * expired / unknown) — callers use that to distinguish a live answer from a
 * stale press.
 */
export function resolveAskUser(
  sessionId: string,
  toolUseId: string,
  answer: AskUserAnswer,
  reason: AskUserSettleReason = "answered",
  messageId?: string
): boolean {
  const k = key(sessionId, toolUseId)
  const entry = pending.get(k)
  if (!entry) return false
  if (entry.timer) clearTimeout(entry.timer)
  pending.delete(k)
  entry.settle({ answer, reason, ...(messageId ? { messageId } : {}) })
  return true
}

/** The pending entry for one tool call, if it is still open. */
export function getPendingAskUser(
  sessionId: string,
  toolUseId: string
): PendingAskUser | undefined {
  return pending.get(key(sessionId, toolUseId))
}

/**
 * The pending entry owning a surface, if any. Used for callbacks that arrive
 * without a resolvable `ask_user` binding — Telegram ForceReply replies carry
 * the surface id inline but resolve no binding row, and Discord modal submits
 * resolve a `modal_open` row instead.
 */
export function getPendingAskUserBySurface(surfaceId: string): PendingAskUser | undefined {
  for (const entry of pending.values()) {
    if (entry.meta.surfaceId === surfaceId) return entry
  }
  return undefined
}

/**
 * Flip one option in a pending multi-select prompt. For single-select cards
 * the value REPLACES the current selection (radio semantics). Returns the new
 * selection, or `undefined` when the prompt is gone.
 */
export function toggleAskUserValue(
  sessionId: string,
  toolUseId: string,
  value: string
): readonly string[] | undefined {
  const entry = pending.get(key(sessionId, toolUseId))
  if (!entry) return undefined
  if (!entry.meta.request.multiSelect) {
    entry.selected = [value]
    return entry.selected
  }
  entry.selected = entry.selected.includes(value)
    ? entry.selected.filter((v) => v !== value)
    : [...entry.selected, value]
  return entry.selected
}

/** Number of prompts currently awaiting an answer (all sessions). */
export function pendingAskUserCount(): number {
  return pending.size
}

/** Reset all registry state. Test-only. */
export function __resetAskUserRegistryForTesting(): void {
  for (const entry of pending.values()) {
    if (entry.timer) clearTimeout(entry.timer)
  }
  pending.clear()
}
