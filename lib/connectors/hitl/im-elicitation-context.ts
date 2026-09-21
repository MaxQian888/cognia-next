/**
 * IM elicitation context registry — the seam that decides WHERE an `ask_user`
 * tool call is answered.
 *
 * For a connector-initiated run there is nobody watching the desktop dialog —
 * the question would never reach a user. The connector runtime registers one
 * context here for the duration of a capture (`lib/connectors/runtime.ts`);
 * `handlePluginToolExec` (`lib/claude/plugin-tool-ipc.ts`) looks it up by the
 * `sessionId` carried on the `plugin_tool_exec` request and, when present,
 * routes the tool call to `runImAskUser`, which projects an interactive A2UI
 * card into the owning IM conversation and suspends on its callback.
 *
 * Desktop-originated turns never register, so the absence of a context is the
 * signal to keep using the renderer dialog (`stores/agent/ask-user-store.ts`).
 *
 * The entry dies with its owning capture: `signal` aborts when the turn ends
 * or is torn down, and `getImElicitationContext` treats an aborted context as
 * absent so a late `plugin_tool_exec` event can never resurrect a dead run's
 * question card. The unregister callback removes only the exact registration
 * it returned for — a newer registration for the same session is never
 * clobbered by a stale cleanup.
 */

import type { ConversationDeliveryTarget, ConversationReference } from "@/types/connectors/event"
import type { CallbackActorScope } from "@/types/connectors/interaction"

/** Everything `runImAskUser` needs to project + suspend on an IM card. */
export interface ImElicitationContext {
  /** ChatSession id — the key `plugin_tool_exec` events carry verbatim. */
  sessionId: string
  adapterId: string
  conversationKey: string
  conversationRef: ConversationReference
  /** Refreshed delivery target (thread anchors, reply hints). */
  deliveryTarget?: ConversationDeliveryTarget
  /**
   * remoteUserId of the human whose message started this turn. Feeds the
   * bindings' actorScope so only the requester (or a configured operator)
   * answers the question — matching the tool-approval guard.
   */
  initiatorUserId?: string
  /**
   * Explicit actor scope for the question card's bindings, overriding the
   * initiator-or-operators default. Digest turns (scheduled / callback-fed)
   * have no single requester, so they register `{mode: "conversation"}`.
   */
  actorScope?: CallbackActorScope
  /** Durable Execution Run that owns this turn (for run interrupts). */
  runId?: string
  /** Per-run override of the answer TTL; falls back to the module default. */
  ttlMs?: number
  /**
   * True while the turn is a draft-prepare generation — no human is watching
   * one, so questions resolve as cancelled instead of posting a live card.
   */
  drafting?: boolean
  /**
   * Aborted when the owning capture ends (adapter teardown / run controller /
   * approval-controller cleanup). An aborted context is invisible to
   * `getImElicitationContext`.
   */
  signal?: AbortSignal
}

const contexts = new Map<string, ImElicitationContext>()

/**
 * Register the elicitation context for a session. Re-registering replaces the
 * prior entry (a session only runs one capture at a time). Returns an
 * unregister callback that removes THIS registration only.
 */
export function registerImElicitationContext(ctx: ImElicitationContext): () => void {
  contexts.set(ctx.sessionId, ctx)
  return () => {
    if (contexts.get(ctx.sessionId) === ctx) contexts.delete(ctx.sessionId)
  }
}

/** Standalone unregister for callers that do not hold the returned callback. */
export function unregisterImElicitationContext(sessionId: string): void {
  contexts.delete(sessionId)
}

/**
 * Look up the live context for a session. Returns `undefined` when none is
 * registered or the registered context's owning run already ended — the
 * caller then falls back to the desktop dialog.
 */
export function getImElicitationContext(sessionId: string): ImElicitationContext | undefined {
  const ctx = contexts.get(sessionId)
  if (!ctx) return undefined
  if (ctx.signal?.aborted) {
    contexts.delete(sessionId)
    return undefined
  }
  return ctx
}

/** Reset all registrations. Test-only. */
export function __resetImElicitationForTesting(): void {
  contexts.clear()
}
