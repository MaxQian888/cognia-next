/**
 * Slack outbound serialiser — Task 71.
 *
 * Wraps block-kit to produce SerializedSlackCall objects that map to
 * Slack Web API method calls (chat.postMessage, chat.update, chat.delete,
 * reactions.add).
 */

import type { OutboundRequest } from "@/types/connectors/outbound"
import { segmentsToBlocks } from "./block-kit"

const SLACK_API_BASE = "https://slack.com/api"

export interface SerializedSlackCall {
  method: "POST"
  url: string
  payload: Record<string, unknown>
}

/** Extract channelId from the conversation reference. */
function channelIdFromRef(req: OutboundRequest): string {
  const ref = req.conversationRef as Record<string, unknown>
  return String(ref["channelId"] ?? "")
}

/** Extract optional thread_ts from the conversation reference. */
function threadTsFromRef(req: OutboundRequest): string | undefined {
  const ref = req.conversationRef as Record<string, unknown>
  const ts = ref["threadTs"]
  return typeof ts === "string" ? ts : undefined
}

/**
 * Build a chat.postMessage call.
 */
export function serializePostMessage(req: OutboundRequest): SerializedSlackCall {
  const channel = channelIdFromRef(req)
  const threadTs = threadTsFromRef(req)
  const blocks = segmentsToBlocks(req.segments)

  const payload: Record<string, unknown> = { channel, blocks }
  if (threadTs) {
    payload["thread_ts"] = threadTs
  }

  return {
    method: "POST",
    url: `${SLACK_API_BASE}/chat.postMessage`,
    payload,
  }
}

/**
 * Build a chat.update call (edit an existing message).
 */
export function serializeUpdate(
  channel: string,
  ts: string,
  req: OutboundRequest
): SerializedSlackCall {
  const blocks = segmentsToBlocks(req.segments)
  return {
    method: "POST",
    url: `${SLACK_API_BASE}/chat.update`,
    payload: { channel, ts, blocks },
  }
}

/**
 * Build a chat.delete call.
 */
export function serializeDeleteMessage(channel: string, ts: string): SerializedSlackCall {
  return {
    method: "POST",
    url: `${SLACK_API_BASE}/chat.delete`,
    payload: { channel, ts },
  }
}

/**
 * Build a reactions.add call.
 */
export function serializeReaction(channel: string, ts: string, name: string): SerializedSlackCall {
  return {
    method: "POST",
    url: `${SLACK_API_BASE}/reactions.add`,
    payload: { channel, timestamp: ts, name },
  }
}

/**
 * Typing indicator via assistant.threads.setStatus.
 *
 * NOTE: This is only available for assistant apps and is not a standard bot
 * capability. Phase 1 makes this a no-op.
 * TODO (Phase 2): implement for assistant apps when transport mode supports it.
 */
export function serializeTyping(_channel: string, _threadTs?: string): SerializedSlackCall | null {
  // No-op in Phase 1 — assistant.threads.setStatus requires the assistants beta
  return null
}

/**
 * Project an OutboundRequest into a chat.postMessage SerializedSlackCall.
 */
export function serializeOutbound(req: OutboundRequest): SerializedSlackCall {
  return serializePostMessage(req)
}
