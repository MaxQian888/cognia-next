/**
 * Turn a platform-bound session's transcript into the copilot's chat state
 * (ADR-0194): the last turns as `{ from: "me" | "other", text }`, in the wire
 * shape the judge questions were calibrated on.
 *
 * Who is "me" in an IM conversation is not `role === "user"`: the operator's
 * sends land as user rows stamped `outboundJobId` (local inbox write) or
 * `relayIdempotencyKey` (relayed), the agent's replies are assistant rows, and
 * some adapters echo the bot's own sends back as inbound rows whose sender is
 * the bot account. Everything else carrying `platformMessage` is "other".
 */

import { resolveMessageSpeaker } from "@/lib/chat/speaker"
import type { PlatformIdentity } from "@/types/connectors/event"

/** The judge's window, as calibrated (Jarvis `buildState`: last 10). */
export const COPILOT_WINDOW = 10

export type CopilotSide = "me" | "other"

export interface CopilotTurn {
  from: CopilotSide
  text: string
}

export interface CopilotTranscript {
  turns: CopilotTurn[]
  latestFrom: CopilotSide
  /** Sender of the latest "other" turn — the contact the copilot reads for. */
  latestOtherSender: PlatformIdentity | null
  /** More than one distinct "other" speaker in the window. */
  isGroup: boolean
}

/** The message fields this module reads (UIMessage and StoredMessage both fit). */
export interface TranscriptRow {
  role: string
  parts?: ReadonlyArray<{ type: string; text?: unknown }>
  metadata?: Record<string, unknown>
}

interface PlatformMessageMeta {
  sender?: PlatformIdentity
}

function textOf(row: TranscriptRow): string {
  return (row.parts ?? [])
    .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n")
    .trim()
}

function platformMessage(row: TranscriptRow): PlatformMessageMeta | null {
  const value = row.metadata?.platformMessage
  return typeof value === "object" && value !== null ? (value as PlatformMessageMeta) : null
}

export function sideOf(row: TranscriptRow, selfPlatformIds: ReadonlySet<string>): CopilotSide {
  if (row.role === "assistant") return "me"
  const meta = row.metadata ?? {}
  if (typeof meta.outboundJobId === "string" || typeof meta.relayIdempotencyKey === "string") {
    return "me"
  }
  const inbound = platformMessage(row)
  if (!inbound) return "me" // operator-authored row with no platform provenance
  const sender = inbound.sender
  if (sender && selfPlatformIds.has(sender.remoteUserId)) return "me"
  return "other"
}

/**
 * @param rows ascending by time (as `listRecentMessages` returns them)
 * @param selfPlatformIds the adapter's own account / bot ids, when known
 */
export function buildCopilotTranscript(
  rows: readonly TranscriptRow[],
  selfPlatformIds: ReadonlySet<string> = new Set()
): CopilotTranscript {
  const usable = rows.filter(
    (row) => row.role !== "system" && row.metadata?.deletedAt === undefined && textOf(row)
  )
  const window = usable.slice(-COPILOT_WINDOW)
  const otherSpeakers = new Set<string>()
  for (const row of window) {
    if (sideOf(row, selfPlatformIds) !== "other") continue
    const sender = platformMessage(row)?.sender
    otherSpeakers.add(sender ? `${sender.platform}:${sender.remoteUserId}` : "unknown")
  }
  const isGroup = otherSpeakers.size > 1

  let latestOtherSender: PlatformIdentity | null = null
  const turns = window.map((row): CopilotTurn => {
    const from = sideOf(row, selfPlatformIds)
    let text = textOf(row)
    if (from === "other") {
      latestOtherSender = platformMessage(row)?.sender ?? latestOtherSender
      if (isGroup) {
        // A group has several "other" people; name them with the prompt-safe
        // label so the judge can tell them apart without raw nicknames.
        const speaker = resolveMessageSpeaker(row)
        if (speaker) text = `${speaker.label}: ${text}`
      }
    }
    return { from, text }
  })
  return {
    turns,
    latestFrom: turns.at(-1)?.from ?? "other",
    latestOtherSender,
    isGroup,
  }
}

/** The calibrated wire state: `{ chat: { relationship, messages, latest_from }, background? }`. */
export function toCopilotState(
  transcript: CopilotTranscript,
  relationship: string,
  background?: string
): Record<string, unknown> {
  return {
    chat: {
      relationship,
      messages: transcript.turns.map((turn) => ({ from: turn.from, text: turn.text })),
      latest_from: transcript.latestFrom,
    },
    ...(background?.trim() ? { background: background.trim() } : {}),
  }
}

/** `stateTrim` path for the state above — drop oldest turns first. */
export const COPILOT_STATE_TRIM = ["chat", "messages"]
