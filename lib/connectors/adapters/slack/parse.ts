/**
 * Slack Events API event_callback → NormalizedInboundEvent parser.
 *
 * Handles:
 *   - message create (no subtype)
 *   - message_changed → kind="edit" with replacesMessageId
 *   - message_deleted → kind="delete" with replacesMessageId
 *
 * Ignores bot_message and other unsupported subtypes.
 * Returns null for unsupported event types or malformed envelopes.
 */

import type { NormalizedInboundEvent, PlatformIdentity } from "@/types/connectors/event"
import { buildConversationKey } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"
import { segmentsToPlainText } from "@/types/connectors/segment"
import { MentionAccumulator } from "@/lib/connectors/adapters/_shared/mention-extractor"
import type {
  ConnectorCallbackActionType,
  ConnectorCallbackEvent,
} from "@/types/connectors/interaction"

// ---------------------------------------------------------------------------
// Minimal Slack Events API types (only fields we consume)
// ---------------------------------------------------------------------------

export interface SlackFile {
  id: string
  name: string
  mimetype: string
  url_private: string
  size?: number
  original_w?: number
  original_h?: number
}

export interface SlackBlock {
  type: string
  elements?: SlackBlockElement[]
}

export interface SlackBlockElement {
  type: string
  user_id?: string
  elements?: SlackBlockElement[]
}

export interface SlackMessageEvent {
  type: string
  channel: string
  user?: string
  /** Present on messages authored by any bot (including ourselves). */
  bot_id?: string
  text?: string
  ts: string
  thread_ts?: string
  channel_type?: string
  subtype?: string
  files?: SlackFile[]
  blocks?: SlackBlock[]
  /**
   * For subtype === "message_changed": the *updated* message body. Its `ts`
   * is the ORIGINAL message's ts (the one being edited), not the event ts.
   */
  message?: SlackMessageEvent
  /** For subtype === "message_changed" / "message_deleted": prior content. */
  previous_message?: SlackMessageEvent
  /** For subtype === "message_deleted": ts of the message that was removed. */
  deleted_ts?: string
}

export interface SlackEventEnvelope {
  type: string
  event: SlackMessageEvent
  event_id?: string
  event_time?: number
  team_id?: string
  api_app_id?: string
}

// ---------------------------------------------------------------------------
// Parser helpers
// ---------------------------------------------------------------------------

/**
 * Message subtypes that carry real user content. `undefined` (plain message)
 * is handled separately — everything else (channel_join / channel_leave /
 * channel_topic / channel_purpose / channel_name / bot_message / …) is
 * dropped as system noise.
 */
const USER_CONTENT_SUBTYPES: ReadonlySet<string> = new Set([
  "file_share",
  "thread_broadcast",
  "me_message",
])

function buildPlatformIdentity(adapterId: string, userId: string): PlatformIdentity {
  return {
    id: `slack:${userId}`,
    platform: "slack",
    adapterId,
    remoteUserId: userId,
    displayName: undefined,
    avatarUrl: undefined,
  }
}

function detectMentions(
  selfId: string,
  event: SlackMessageEvent
): { selfMentioned: boolean; users: string[] } {
  const acc = new MentionAccumulator(selfId)

  // Plain-text `<@USERID>` matches first.
  const text = event.text ?? ""
  const mentionRegex = /<@([A-Z0-9]+)>/g
  let match: RegExpExecArray | null
  while ((match = mentionRegex.exec(text)) !== null) {
    acc.add(match[1])
  }

  // Walk rich_text blocks for `user` elements — Slack's modern client
  // sends mentions through this path even when the plain text shape
  // also carries them.
  if (event.blocks) {
    const scanElements = (elements: SlackBlockElement[]) => {
      for (const el of elements) {
        if (el.type === "user" && el.user_id) acc.add(el.user_id)
        if (el.elements) scanElements(el.elements)
      }
    }
    for (const block of event.blocks) {
      if (block.elements) scanElements(block.elements)
    }
  }

  return acc.finalize()
}

function buildSegments(event: SlackMessageEvent): MessageSegment[] {
  const segments: MessageSegment[] = []

  // Files: discriminate image / audio / video / generic.
  if (event.files) {
    for (const file of event.files) {
      const mime = file.mimetype ?? ""
      if (mime.startsWith("image/")) {
        segments.push({
          type: "image",
          url: file.url_private,
          alt: file.name,
          width: file.original_w,
          height: file.original_h,
          // Slack names the exact type; the model's `media_type` must match
          // the bytes, and the generic fallback downstream is PNG.
          mimeType: mime,
        })
      } else if (mime.startsWith("audio/")) {
        // Slack treats voice messages as audio files with the same shape
        // as regular audio attachments.
        segments.push({
          type: "voice",
          url: file.url_private,
        })
      } else if (mime.startsWith("video/")) {
        segments.push({ type: "video", url: file.url_private })
      } else {
        segments.push({
          type: "file",
          url: file.url_private,
          name: file.name,
          mimeType: mime,
          sizeBytes: file.size ?? 0,
        })
      }
    }
  }

  if (event.text) {
    segments.push({ type: "text", text: event.text })
  }

  return segments
}

/**
 * Parse a Slack Events API event_callback envelope into a NormalizedInboundEvent.
 *
 * Returns null for:
 * - Non-message event types
 * - bot_message subtype
 * - Malformed message_changed / message_deleted envelopes (missing required fields)
 */
export function parseSlackEventCallback(
  adapterId: string,
  selfId: string,
  envelope: SlackEventEnvelope
): NormalizedInboundEvent | null {
  if (envelope.type !== "event_callback") return null

  const event = envelope.event
  if (event.type !== "message") return null

  // Edit: the nested `message` carries the updated content. Its `ts` is the
  // original message's ts (the one being mutated).
  if (event.subtype === "message_changed") {
    const updated = event.message
    if (!updated || !updated.ts) return null
    const userId = updated.user
    if (!userId) return null
    const channel = event.channel
    const threadTs = updated.thread_ts !== updated.ts ? updated.thread_ts : undefined
    const conversationKey = buildConversationKey("slack", adapterId, channel, threadTs)
    const sender = buildPlatformIdentity(adapterId, userId)
    const { selfMentioned, users } = detectMentions(selfId, updated)
    const segments = buildSegments(updated)
    const plainText = segmentsToPlainText(segments)
    const channelType = event.channel_type
    const channelKind: "private" | "group" | "channel" | "thread" =
      threadTs !== undefined
        ? "thread"
        : channelType === "im"
          ? "private"
          : channelType === "group"
            ? "group"
            : "channel"

    return {
      platform: "slack",
      adapterId,
      selfId,
      messageId: updated.ts,
      conversationRef: {
        platform: "slack",
        adapterId,
        teamId: envelope.team_id,
        channelId: channel,
        threadTs,
      },
      conversationKey,
      sender,
      channel: {
        id: conversationKey,
        kind: channelKind,
        platformChannelId: channel,
      },
      segments,
      plainText,
      replyTo: undefined,
      mentions: { selfMentioned, users },
      timestamp: Math.round(parseFloat(event.ts) * 1000),
      raw: envelope,
      kind: "edit",
      replacesMessageId: updated.ts,
    }
  }

  // Delete: pull the deleted ts and recover sender / channel kind from
  // previous_message when available.
  if (event.subtype === "message_deleted") {
    const deletedTs = event.deleted_ts
    if (!deletedTs) return null
    const channel = event.channel
    const previous = event.previous_message
    const userId = previous?.user ?? "unknown"
    const threadTs = previous?.thread_ts !== previous?.ts ? previous?.thread_ts : undefined
    const conversationKey = buildConversationKey("slack", adapterId, channel, threadTs)
    const sender = buildPlatformIdentity(adapterId, userId)
    const channelType = event.channel_type
    const channelKind: "private" | "group" | "channel" | "thread" =
      threadTs !== undefined
        ? "thread"
        : channelType === "im"
          ? "private"
          : channelType === "group"
            ? "group"
            : "channel"

    return {
      platform: "slack",
      adapterId,
      selfId,
      messageId: deletedTs,
      conversationRef: {
        platform: "slack",
        adapterId,
        teamId: envelope.team_id,
        channelId: channel,
        threadTs,
      },
      conversationKey,
      sender,
      channel: {
        id: conversationKey,
        kind: channelKind,
        platformChannelId: channel,
      },
      segments: [],
      plainText: "",
      replyTo: undefined,
      mentions: { selfMentioned: false, users: [] },
      timestamp: Math.round(parseFloat(event.ts) * 1000),
      raw: envelope,
      kind: "delete",
      replacesMessageId: deletedTs,
    }
  }

  // Subtype whitelist: only subtypes that carry real user content become
  // inbound events. System subtypes (channel_join / channel_leave /
  // channel_topic / channel_purpose / channel_name / bot_message / …) are
  // noise for the AI loop and are dropped.
  if (event.subtype !== undefined && !USER_CONTENT_SUBTYPES.has(event.subtype)) return null

  // Self-echo guard: drop anything authored by a bot (`bot_id` is present on
  // every bot-authored message regardless of subtype) and anything authored
  // by our own bot user. `selfId` can be "" when the auth.test probe failed —
  // guard so we don't drop user messages whose `user` is also missing/empty.
  if (event.bot_id) return null
  if (selfId && event.user === selfId) return null

  const userId = event.user
  if (!userId) return null

  const channel = event.channel
  const threadTs = event.thread_ts !== event.ts ? event.thread_ts : undefined

  const conversationKey = buildConversationKey("slack", adapterId, channel, threadTs)
  const sender = buildPlatformIdentity(adapterId, userId)
  const { selfMentioned, users } = detectMentions(selfId, event)
  const segments = buildSegments(event)
  const plainText = segmentsToPlainText(segments)

  const channelType = event.channel_type
  const channelKind: "private" | "group" | "channel" | "thread" =
    threadTs !== undefined
      ? "thread"
      : channelType === "im"
        ? "private"
        : channelType === "group"
          ? "group"
          : "channel"

  return {
    platform: "slack",
    adapterId,
    selfId,
    messageId: event.ts,
    conversationRef: {
      platform: "slack",
      adapterId,
      teamId: envelope.team_id,
      channelId: channel,
      threadTs: threadTs,
    },
    conversationKey,
    sender,
    channel: {
      id: conversationKey,
      kind: channelKind,
      platformChannelId: channel,
    },
    segments,
    plainText,
    // A threaded reply's `thread_ts` IS the parent message id. Slack sends no
    // quoted text, so the snippet is empty by contract; the id is what the
    // reply-aware paths (quote → issue, ADR-0132) need.
    ...(threadTs ? { replyTo: { messageId: threadTs, snippet: "" } } : { replyTo: undefined }),
    mentions: { selfMentioned, users },
    timestamp: Math.round(parseFloat(event.ts) * 1000),
    raw: envelope,
  }
}

// ---------------------------------------------------------------------------
// Slash commands — Socket Mode `slash_commands` envelope payload
// ---------------------------------------------------------------------------

/** Decoded body of a Socket Mode `slash_commands` envelope. */
export interface SlackSlashCommandPayload {
  command: string
  text?: string
  channel_id: string
  user_id: string
  user_name?: string
  team_id?: string
  trigger_id?: string
}

/**
 * Project a slash-command invocation into an ordinary
 * NormalizedInboundEvent text message — no new event kind. `plainText` is
 * "<command> <text>" so the AI loop sees the full invocation, and
 * `selfMentioned` is true because a slash command is by definition an
 * explicit invocation of this bot.
 */
export function parseSlackSlashCommand(
  adapterId: string,
  selfId: string,
  payload: SlackSlashCommandPayload
): NormalizedInboundEvent | null {
  if (!payload.command || !payload.channel_id || !payload.user_id) return null

  const channel = payload.channel_id
  const conversationKey = buildConversationKey("slack", adapterId, channel)
  const sender = buildPlatformIdentity(adapterId, payload.user_id)
  if (payload.user_name) sender.displayName = payload.user_name
  const text = [payload.command, payload.text ?? ""].filter(Boolean).join(" ").trim()
  const now = Date.now()

  return {
    platform: "slack",
    adapterId,
    selfId,
    // Slash commands carry no message ts — the trigger_id is the only
    // stable platform-side id for the invocation.
    messageId: payload.trigger_id ?? `slash-${now}`,
    conversationRef: {
      platform: "slack",
      adapterId,
      teamId: payload.team_id,
      channelId: channel,
    },
    conversationKey,
    sender,
    channel: {
      id: conversationKey,
      kind: "channel",
      platformChannelId: channel,
    },
    segments: [{ type: "text", text }],
    plainText: text,
    replyTo: undefined,
    mentions: { selfMentioned: true, users: selfId ? [selfId] : [] },
    timestamp: now,
    raw: payload,
  }
}

// ---------------------------------------------------------------------------
// Interactive payloads (block_actions / view_submission) — G3.3 callback channel
// ---------------------------------------------------------------------------

export interface SlackInteractiveActionElement {
  action_id?: string
  block_id?: string
  type?: string
  value?: string
  selected_option?: { value?: string; text?: { text?: string } }
  selected_options?: Array<{ value?: string }>
  selected_date?: string
  selected_time?: string
  text?: { text?: string }
}

export interface SlackInteractivePayload {
  type: string
  trigger_id?: string
  user?: { id: string; username?: string; team_id?: string }
  team?: { id: string; domain?: string }
  channel?: { id: string; name?: string }
  container?: {
    type?: string
    message_ts?: string
    channel_id?: string
    thread_ts?: string
  }
  actions?: SlackInteractiveActionElement[]
  view?: {
    id: string
    type: string
    callback_id?: string
    state?: {
      values?: Record<
        string,
        Record<
          string,
          {
            type?: string
            value?: string
            selected_option?: { value?: string }
            selected_date?: string
            selected_time?: string
          }
        >
      >
    }
  }
}

/**
 * Project a Slack interactive payload (block_actions / view_submission /
 * view_closed) into a `ConnectorCallbackEvent` for the ConnectorBus
 * callback channel.
 *
 *   - `block_actions`     → actionType="button" or "select" (driven by
 *                           the action element's `type`). triggerId is
 *                           the `action_id`, which the A2UI mapper baked
 *                           with `buildActionId(surfaceId, componentId, action)`
 *                           so the binding row resolves the surface.
 *   - `view_submission`   → actionType="submit" with the full form
 *                           values flattened into `payload`.
 *   - `view_closed`       → actionType="dismiss".
 *
 * Returns null for unsupported payload types or malformed shapes.
 */
export function parseSlackInteractivePayload(
  adapterId: string,
  selfId: string,
  payload: SlackInteractivePayload
): ConnectorCallbackEvent | null {
  if (!payload.user) return null
  const user: PlatformIdentity = {
    id: `slack:${payload.user.id}`,
    platform: "slack",
    adapterId,
    remoteUserId: payload.user.id,
    displayName: payload.user.username,
  }
  const channelId = payload.container?.channel_id ?? payload.channel?.id
  const threadTs = payload.container?.thread_ts
  const conversationKey = channelId
    ? buildConversationKey("slack", adapterId, channelId, threadTs)
    : undefined

  if (payload.type === "block_actions") {
    const action = payload.actions?.[0]
    if (!action || !action.action_id) return null
    const actionType: ConnectorCallbackActionType =
      action.type === "static_select" ||
      action.type === "multi_static_select" ||
      action.type === "external_select" ||
      action.type === "users_select" ||
      action.type === "channels_select"
        ? "select"
        : action.type === "datepicker" || action.type === "timepicker"
          ? "input"
          : action.type === "checkboxes" || action.type === "radio_buttons"
            ? "checkbox"
            : "button"
    let value = ""
    let payloadFields: Record<string, unknown> | undefined
    if (action.type?.endsWith("select")) {
      value = action.selected_option?.value ?? ""
      if (action.selected_options && action.selected_options.length > 1) {
        payloadFields = {
          values: action.selected_options.map((o) => o.value).filter(Boolean),
        }
      }
    } else if (action.type === "datepicker") {
      value = action.selected_date ?? ""
    } else if (action.type === "timepicker") {
      value = action.selected_time ?? ""
    } else if (action.type === "checkboxes" || action.type === "radio_buttons") {
      value = action.selected_option?.value ?? ""
    } else {
      value = action.value ?? ""
    }
    return {
      platform: "slack",
      adapterId,
      selfId,
      triggerId: action.action_id,
      surfaceId: "",
      componentId: undefined,
      actionType,
      value,
      payload: payloadFields,
      originatingMessageId: payload.container?.message_ts,
      conversationKey,
      user,
      timestamp: Date.now(),
      raw: payload,
    }
  }

  if (payload.type === "view_submission" && payload.view) {
    const flat: Record<string, unknown> = {}
    const values = payload.view.state?.values ?? {}
    for (const blockId of Object.keys(values)) {
      for (const actionId of Object.keys(values[blockId])) {
        const v = values[blockId][actionId]
        flat[actionId] =
          v.value ?? v.selected_option?.value ?? v.selected_date ?? v.selected_time ?? ""
      }
    }
    return {
      platform: "slack",
      adapterId,
      selfId,
      triggerId: payload.view.callback_id ?? payload.view.id,
      surfaceId: "",
      componentId: undefined,
      actionType: "submit",
      value: "",
      payload: flat,
      originatingMessageId: payload.container?.message_ts,
      conversationKey,
      user,
      timestamp: Date.now(),
      raw: payload,
    }
  }

  if (payload.type === "view_closed" && payload.view) {
    return {
      platform: "slack",
      adapterId,
      selfId,
      triggerId: payload.view.callback_id ?? payload.view.id,
      surfaceId: "",
      componentId: undefined,
      actionType: "dismiss",
      value: "",
      conversationKey,
      user,
      timestamp: Date.now(),
      raw: payload,
    }
  }

  return null
}
