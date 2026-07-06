/**
 * Headless ⇄ active-pane bridge.
 *
 * A headless leg (connector auto-reply, scheduled goal, team dispatch, …) runs
 * against a REAL `ChatSession` and persists its messages just like a foreground
 * turn — it simply has no open tab. "Watch / take over" promotes that session to
 * an active, watchable pane: open + focus the session and seed its slice from
 * Dexie. From there `use-claude-chat`'s global `onClaudeMessage` fan-out (which
 * routes events for EVERY sessionId, not just the focused one) streams the live
 * turn straight into the now-visible pane — no extra subscription needed.
 */

import { useChatStore } from "@/stores/chat"
import { listMessages } from "@/lib/db/messages"

export interface PromoteToPaneResult {
  /** False when seeding the slice from Dexie failed (the pane still opened). */
  seeded: boolean
}

/**
 * Promote `sessionId` to an open, focused, watchable pane. Idempotent — opening
 * an already-open session just re-focuses it. Seeds the slice from Dexie so the
 * pane shows history immediately; live events then stream in via the existing
 * chat hook fan-out. Never throws — a Dexie read failure surfaces as a slice
 * load error and `seeded: false`.
 */
export async function promoteLegToPane(sessionId: string): Promise<PromoteToPaneResult> {
  const store = useChatStore.getState()
  // Open + focus first so the pane is visible even while history loads.
  store.openSession(sessionId)
  store.setActiveSession(sessionId)

  try {
    const messages = await listMessages(sessionId)
    // Re-read the store in case focus changed during the async load; seed the
    // target session's slice directly (routes by id, focus-independent).
    useChatStore.getState().setSessionMessages(sessionId, messages)
    return { seeded: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    useChatStore.getState().setSessionMessagesLoadError(sessionId, message)
    return { seeded: false }
  }
}
