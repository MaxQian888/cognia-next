/**
 * Slack export importer — turns a single channel's JSON into a markdown
 * transcript for ingest. Slack's `Export your data` feature ships a ZIP
 * with one folder per channel and one JSON file per day inside it; this
 * importer accepts either:
 *
 *   • A single day's array (`[{type:"message", user, text, ts}, …]`).
 *   • A wrapper object with `messages` plus optional `channel` / `users`
 *     metadata (the shape some manual scripts produce).
 *
 * Multi-day ZIPs should be unpacked first; the workbench surfaces the
 * single-file path because it round-trips reliably without a zip layer.
 *
 * Output: one `RawSource` per call (one channel-day usually maps to one
 * source). Threaded replies stay inline; the renderer indents them so the
 * embedder still sees the conversation flow.
 */

import type { RawSource } from "../../ingest/parse"

interface SlackUserProfile {
  real_name?: string
  display_name?: string
}

interface SlackMessage {
  type?: string
  subtype?: string
  user?: string
  username?: string
  bot_id?: string
  text?: string
  ts?: string
  thread_ts?: string
  user_profile?: SlackUserProfile
}

interface SlackEnvelope {
  channel?: string
  channel_name?: string
  users?: Record<string, SlackUserProfile>
  messages?: SlackMessage[]
}

export interface SlackImportOptions {
  twinId: string
  /** Optional human label (e.g. "#engineering 2024-01-15"). */
  source?: string
  /** Optional pre-resolved user-id → display-name map. */
  userMap?: Record<string, string>
}

const DEFAULT_CHANNEL_LABEL = "slack-channel"

function parsePayload(text: string): {
  messages: SlackMessage[]
  channel?: string
  users?: Record<string, SlackUserProfile>
} {
  const trimmed = text.trim()
  if (!trimmed) return { messages: [] }
  const parsed: unknown = JSON.parse(trimmed)
  if (Array.isArray(parsed)) {
    return { messages: parsed as SlackMessage[] }
  }
  if (parsed && typeof parsed === "object") {
    const env = parsed as SlackEnvelope
    return {
      messages: Array.isArray(env.messages) ? env.messages : [],
      channel: env.channel ?? env.channel_name,
      users: env.users,
    }
  }
  return { messages: [] }
}

function resolveDisplayName(
  message: SlackMessage,
  inlineUsers: Record<string, SlackUserProfile> | undefined,
  override: Record<string, string> | undefined
): string {
  if (override && message.user && override[message.user]) return override[message.user]
  const profile: SlackUserProfile | undefined =
    message.user_profile ?? (message.user ? inlineUsers?.[message.user] : undefined)
  if (profile?.real_name) return profile.real_name
  if (profile?.display_name) return profile.display_name
  if (message.username) return message.username
  if (message.user) return `<@${message.user}>`
  if (message.bot_id) return `bot:${message.bot_id}`
  return "(unknown)"
}

function formatTimestamp(ts: string | undefined): string {
  if (!ts) return ""
  const seconds = Number.parseFloat(ts)
  if (!Number.isFinite(seconds)) return ts
  return new Date(seconds * 1000).toISOString()
}

export function parseSlackExport(jsonText: string, options: SlackImportOptions): RawSource[] {
  const { messages, channel: channelFromPayload, users } = parsePayload(jsonText)
  if (messages.length === 0) return []

  const channelLabel = options.source ?? channelFromPayload ?? DEFAULT_CHANNEL_LABEL
  const speakerSet = new Set<string>()
  // Group threaded replies under their parent so the renderer can indent.
  const threads = new Map<string, SlackMessage[]>()
  const roots: SlackMessage[] = []
  for (const m of messages) {
    if (!m.text || m.type !== "message") continue
    if (m.thread_ts && m.ts !== m.thread_ts) {
      const arr = threads.get(m.thread_ts) ?? []
      arr.push(m)
      threads.set(m.thread_ts, arr)
    } else {
      roots.push(m)
    }
  }

  const lines: string[] = [`# Slack — ${channelLabel}`, ""]
  for (const root of roots) {
    const speaker = resolveDisplayName(root, users, options.userMap)
    speakerSet.add(speaker)
    const ts = formatTimestamp(root.ts)
    lines.push(`- **${speaker}** _${ts}_: ${root.text}`)
    const replies = threads.get(root.ts ?? "") ?? []
    for (const reply of replies) {
      const replySpeaker = resolveDisplayName(reply, users, options.userMap)
      speakerSet.add(replySpeaker)
      const replyTs = formatTimestamp(reply.ts)
      lines.push(`    - **${replySpeaker}** _${replyTs}_: ${reply.text}`)
    }
  }

  if (lines.length <= 2) return []

  return [
    {
      id: `tws_slack_${options.twinId}_${Date.now().toString(36)}`,
      filename: `${channelLabel}.md`,
      format: "markdown",
      text: lines.join("\n"),
      baseMetadata: {
        speakers: Array.from(speakerSet),
      },
    },
  ]
}
