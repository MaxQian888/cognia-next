/**
 * Post a video job's card into its conversation (ADR-0205): a system message
 * with one `video-job` block, which `VideoJobView` renders from the job's live
 * row. Written to the transcript at once — `/video` and "Try again" send no
 * turn, so nothing else would ever persist the card, and after a reload the
 * job's result would be unreachable from the chat.
 */

import type { UIMessage } from "ai"

import { commitMessageDelta } from "@/lib/db/messages"
import { DIAGNOSTICS_PART_TYPE, type VideoJobBlock } from "@/lib/slash-commands/system-blocks"
import { useChatStore } from "@/stores/chat"

export function buildVideoJobCardMessage(jobId: string, now: number = Date.now()): UIMessage {
  const block: VideoJobBlock = { kind: "video-job", jobId }
  return {
    id: `sys-video-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role: "system",
    parts: [{ type: DIAGNOSTICS_PART_TYPE, data: block }] as UIMessage["parts"],
  }
}

export async function postVideoJobCard(sessionId: string, jobId: string): Promise<void> {
  const message = buildVideoJobCardMessage(jobId)
  // In memory only where that conversation is loaded: appending to a slice that
  // is not would make one holding just this card. On disk as one row.
  const store = useChatStore.getState()
  if (store.sessions[sessionId] || store.activeSessionId === sessionId) {
    store.appendMessageToSession(sessionId, message)
  }
  await commitMessageDelta(sessionId, { upserts: [message] })
}
