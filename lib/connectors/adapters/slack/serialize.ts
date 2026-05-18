/**
 * Slack outbound serialiser — Task 71.
 *
 * Wraps block-kit to produce SerializedSlackCall objects that map to
 * Slack Web API method calls (chat.postMessage, chat.update, chat.delete,
 * reactions.add).
 */

import type { OutboundRequest } from "@/types/connectors/outbound"
import { buildSlackA2UIBlocks, segmentsToBlocks, type SlackAnyBlock } from "./block-kit"

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
 * Build a chat.postMessage call (sync path). a2ui segments fall back to
 * `plainTextMirror` via `segmentsToBlocks`; use the async variant for
 * full Block Kit projection.
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
 * Async variant — projects a2ui segments through `buildSlackA2UIBlocks`
 * (Header / Section / Image / Actions / Input + callback bindings). All
 * other segment types delegate to the sync `segmentsToBlocks`.
 *
 * Returns one chat.postMessage call carrying the merged blocks list.
 */
export async function serializePostMessageAsync(
  req: OutboundRequest,
  adapterId: string
): Promise<SerializedSlackCall> {
  const channel = channelIdFromRef(req)
  const threadTs = threadTsFromRef(req)
  const blocks: SlackAnyBlock[] = []

  for (const seg of req.segments) {
    if (seg.type === "a2ui") {
      const a2uiBlocks = await buildSlackA2UIBlocks({
        adapterId,
        surfaceId: seg.surfaceId,
        surface: seg.content,
        conversationKey: buildConversationKeyFromRef(req, channel),
      })
      if (a2uiBlocks.length === 0) {
        // Fall back to the text mirror as a single section.
        const fallback = segmentsToBlocks([seg])
        blocks.push(...fallback)
      } else {
        blocks.push(...a2uiBlocks)
      }
    } else {
      const generic = segmentsToBlocks([seg])
      blocks.push(...generic)
    }
  }

  const payload: Record<string, unknown> = { channel, blocks }
  if (threadTs) payload["thread_ts"] = threadTs

  return {
    method: "POST",
    url: `${SLACK_API_BASE}/chat.postMessage`,
    payload,
  }
}

function buildConversationKeyFromRef(req: OutboundRequest, channelId: string): string | undefined {
  const ref = req.conversationRef as Record<string, unknown>
  const adapterId = typeof ref["adapterId"] === "string" ? ref["adapterId"] : ""
  if (!adapterId || !channelId) return undefined
  const threadTs = typeof ref["threadTs"] === "string" ? ref["threadTs"] : undefined
  return threadTs
    ? `slack:${adapterId}:${channelId}:${threadTs}`
    : `slack:${adapterId}:${channelId}`
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
 * Typing indicator via `assistant.threads.setStatus`.
 *
 * Slack's assistants API only honours this on threads spawned from an
 * assistant-enabled app — calling it on a regular channel returns
 * `not_supported`. The runtime gate is `AdapterInstanceRow.settings.
 * assistantAppEnabled`; the adapter's `setTyping` skips this serializer
 * entirely when the gate is false, so callers can rely on the call being
 * issued only against threads where Slack will accept it.
 *
 * `status` is the typing-indicator caption Slack shows under the
 * assistant's name (e.g., "is typing…"). An empty string clears the
 * indicator — pass `""` when typing stops.
 */
export function serializeAssistantStatus(
  channel: string,
  threadTs: string,
  status: string
): SerializedSlackCall {
  return {
    method: "POST",
    url: `${SLACK_API_BASE}/assistant.threads.setStatus`,
    payload: { channel_id: channel, thread_ts: threadTs, status },
  }
}

/**
 * Set the suggested prompts shown above an assistant thread's input box
 * via `assistant.threads.setSuggestedPrompts`. Same gating as
 * {@link serializeAssistantStatus} — only valid on assistant-app
 * threads. `prompts` is capped at 4 by Slack; we trim defensively so the
 * caller never gets a 4xx for over-supplying.
 */
export function serializeAssistantSuggestedPrompts(
  channel: string,
  threadTs: string,
  prompts: Array<{ title: string; message: string }>,
  title?: string
): SerializedSlackCall {
  const trimmed = prompts.slice(0, 4)
  return {
    method: "POST",
    url: `${SLACK_API_BASE}/assistant.threads.setSuggestedPrompts`,
    payload: {
      channel_id: channel,
      thread_ts: threadTs,
      prompts: trimmed,
      ...(title ? { title } : {}),
    },
  }
}

/**
 * @deprecated Phase 1 alias — returns null. Use
 * {@link serializeAssistantStatus} guarded by
 * `settings.assistantAppEnabled` for assistant-app threads.
 */
export function serializeTyping(_channel: string, _threadTs?: string): SerializedSlackCall | null {
  return null
}

/**
 * Project an OutboundRequest into a chat.postMessage SerializedSlackCall.
 */
export function serializeOutbound(req: OutboundRequest): SerializedSlackCall {
  return serializePostMessage(req)
}

/**
 * Async outbound serializer used by the production adapter `send()`.
 * Routes a2ui segments through `buildSlackA2UIBlocks`.
 */
export async function serializeOutboundAsync(
  req: OutboundRequest,
  adapterId: string
): Promise<SerializedSlackCall> {
  return serializePostMessageAsync(req, adapterId)
}
