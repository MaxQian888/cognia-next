/**
 * Branch a whole conversation — every visible message into a new, linked one.
 *
 * The session-level entry to the operation the per-message branch button
 * performs, with the last visible message as the cut-off. Two surfaces offer
 * it: the session settings sheet (for the open conversation) and the
 * conversation list's row menu (for any row, opened or not). One helper, so
 * both copy the same thread the same way — `branchSessionAtMessage` reuses the
 * cheap SDK fork when the cut-off is the tail, copies the messages, records
 * the lineage (`parentSessionId`, the row's branch chip) and carries the
 * per-session settings across.
 *
 * Which thread is "visible" comes from the live store when it holds the
 * conversation's messages, and otherwise from the stored rows with the
 * conversation's persisted branch selection applied — a row in the list that
 * was never opened this session still branches exactly what opening it would
 * have shown.
 *
 * Resolves `null` when there is nothing to branch (no messages yet); throws
 * what `branchSessionAtMessage` throws (a missing row, a handoff lock).
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { UIMessage } from "ai"
import { branchSessionAtMessage } from "@/lib/chat/branch-session"
import { listMessages, rowToUIMessage } from "@/lib/db/messages"
import { getSession } from "@/lib/db/sessions"
import { detectHostProfile } from "@/lib/platform/capabilities"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import { transport } from "@/lib/tauri/transport-instance"
import { getSessionHistoryMode, readCompleteSessionHistory } from "@/lib/sync/session-history"
import { useChatStore } from "@/stores/chat"
import { selectVisibleMessages } from "@/stores/chat/chat-store"

async function visibleThread(sessionId: string): Promise<UIMessage[]> {
  const state = useChatStore.getState()
  const slice = state.sessions?.[sessionId]
  if (slice && slice.messages.length > 0) {
    return selectVisibleMessages(slice.messages, slice.activeBranchByGroup)
  }
  if (sessionId === state.activeSessionId && state.messages.length > 0) {
    return selectVisibleMessages(state.messages, state.activeBranchByGroup)
  }
  const [session, messages] = await Promise.all([getSession(sessionId), listMessages(sessionId)])
  return selectVisibleMessages(messages, session?.activeBranchByGroup ?? {})
}

export async function branchWholeConversation(sessionId: string): Promise<ChatSession | null> {
  const profile = detectHostProfile()
  const remote =
    profile === "mobile-companion" || profile === "cloud-companion" || isRemoteHostActive()
  const sourceSnapshot = remote ? await readCompleteSessionHistory(transport, sessionId) : null
  if (
    remote &&
    !sourceSnapshot &&
    ["timeline", "legacy"].includes(getSessionHistoryMode(sessionId) ?? "")
  ) {
    throw new Error("Cannot branch: authoritative session history is unavailable")
  }
  const visible = sourceSnapshot
    ? selectVisibleMessages(
        sourceSnapshot.messages.map(rowToUIMessage),
        sourceSnapshot.session.activeBranchByGroup ?? {}
      )
    : await visibleThread(sessionId)
  const cutoff = visible.at(-1)
  if (!cutoff) return null
  return branchSessionAtMessage({
    sourceId: sessionId,
    ...(sourceSnapshot ? { sourceSnapshot } : {}),
    visibleMessages: visible,
    messageId: cutoff.id,
    mode: "direct",
    // Whole-conversation forks explicitly inherit current domain state, also
    // for legacy transcripts that predate per-message historical snapshots.
    workingSetPolicy: "current",
  })
}
