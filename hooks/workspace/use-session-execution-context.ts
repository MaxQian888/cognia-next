"use client"

/**
 * The focused conversation's durable execution binding, for the panels that
 * follow it.
 *
 * The binding lives on the Dexie session row rather than in the chat store —
 * it is durable state, not turn state — so every panel that wants to follow a
 * conversation had to read it itself, and none of them did. This is the one
 * subscription they share.
 *
 * Live rather than one-shot: a conversation acquires its managed worktree
 * partway through the first turn, so a panel that read the binding once at
 * mount would sit on the source repository for the rest of the session and
 * look correct while being wrong.
 */

import { useClientLiveQuery } from "@/hooks/data"
import type { SessionExecutionContext } from "@/types/execution-context"

/**
 * @param sessionId Conversation to read. `null`/`undefined` resolves to null
 * rather than to the focused conversation — a panel that means "the focused
 * one" should say so, since in split view there are two.
 */
export function useSessionExecutionContext(
  sessionId: string | null | undefined
): SessionExecutionContext | null {
  return (
    useClientLiveQuery(
      async () => {
        if (!sessionId) return null
        try {
          const { getDb } = await import("@/lib/db/schema")
          return (await getDb().sessions.get(sessionId))?.executionContext ?? null
        } catch {
          // A panel that cannot read the binding falls back to the workspace
          // root, which is what it did before any of this existed.
          return null
        }
      },
      [sessionId],
      null
    ) ?? null
  )
}
