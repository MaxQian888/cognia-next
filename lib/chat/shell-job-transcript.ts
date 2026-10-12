/**
 * Transcript writes for a `!` job (`lib/shell-intelligence/shell-job-run.ts`):
 * its card, then the result or the "moved to the background" note that
 * replaces it. Every write is an upsert, because the run rewrites the card
 * message in place and a re-attaching client may write the same row again.
 *
 * Same shape as `video-job-card.ts`: in memory only where the conversation is
 * loaded — writing into a slice that is not would create one holding just
 * this message — and on disk as one row either way, since a `!` line sends no
 * turn that would otherwise persist it.
 */

import type { UIMessage } from "ai"

import { commitMessageDelta } from "@/lib/db/messages"
import type { ShellJobTranscript } from "@/lib/shell-intelligence/shell-job-run"
import { useChatStore } from "@/stores/chat"

export async function upsertShellJobMessage(sessionId: string, message: UIMessage): Promise<void> {
  const store = useChatStore.getState()
  if (store.sessions[sessionId] || store.activeSessionId === sessionId) {
    store.upsertSessionMessages(sessionId, [message])
  }
  await commitMessageDelta(sessionId, { upserts: [message] })
}

export const shellJobTranscript: ShellJobTranscript = { upsert: upsertShellJobMessage }
