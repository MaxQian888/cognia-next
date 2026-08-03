/**
 * Seeds a realtime session with the conversation that came before it.
 *
 * Without this, starting voice mid-thread produces a model that has no idea
 * what "it" refers to. The seed is injected after the socket opens and before
 * the microphone does, so the model is already oriented on the user's first
 * word.
 *
 * Three constraints shape the format:
 *
 * - **V4 only lets the client create `role: "user"` text items.** There is no
 *   way to replay an assistant turn as an assistant item. Rather than
 *   mislabelling past assistant text as something the user said, the history
 *   goes in as a single user message that is explicitly framed as a transcript.
 *   The model treats it as background; the user never sees it.
 *
 * - **Text only.** Images, files, tool calls and audio are dropped. The user
 *   was told their microphone audio goes to the provider; they were not told
 *   their attachments would.
 *
 * - **Fail-closed on PII.** Every line goes through `screenLiveVoiceText`,
 *   which redacts and re-checks, and drops the line if it still does not pass.
 *   Losing a line of context is strictly better than leaking one.
 */

import type { Experimental_RealtimeModelV4ClientEvent as RealtimeClientEvent } from "@ai-sdk/provider"

import { screenLiveVoiceText } from "../realtime-session"

/** Structural view of a stored/UI message — only what the seed needs. */
export interface LiveVoiceContextMessage {
  role: string
  parts?: readonly unknown[]
}

export interface LiveVoiceContextLimits {
  /** Most recent N turns considered. */
  turnLimit: number
  /** Hard ceiling on the rendered transcript. */
  characterLimit: number
}

/**
 * Framing so the model reads what follows as history rather than as an
 * instruction it should act on.
 */
const TRANSCRIPT_HEADER =
  "The following is a transcript of the conversation so far, for context. " +
  "Continue it naturally in speech. Do not read this transcript aloud."

/** Concatenate a message's text parts. Non-text parts are intentionally lost. */
function textOf(message: LiveVoiceContextMessage): string {
  let out = ""
  for (const part of message.parts ?? []) {
    if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
      const text = (part as { text?: unknown }).text
      if (typeof text === "string") out += (out ? " " : "") + text
    }
  }
  return out
}

function speakerLabel(role: string): string | null {
  if (role === "user") return "User"
  if (role === "assistant") return "Assistant"
  // System messages are not conversation, and any other role is not ours.
  return null
}

/**
 * Render the recent conversation as a transcript, or `null` when nothing
 * survives the limits and the PII gate.
 */
export function buildLiveVoiceContext(
  messages: readonly LiveVoiceContextMessage[],
  limits: LiveVoiceContextLimits
): string | null {
  if (limits.turnLimit <= 0 || limits.characterLimit <= 0) return null

  const lines: string[] = []
  // Walk backwards: when the budget runs out it is the OLDEST context that
  // should be dropped, not the most recent.
  for (let i = messages.length - 1; i >= 0 && lines.length < limits.turnLimit; i -= 1) {
    const message = messages[i]
    const label = speakerLabel(message?.role ?? "")
    if (!label) continue

    const screened = screenLiveVoiceText(textOf(message))
    if (!screened) continue

    lines.push(`${label}: ${screened}`)
  }

  if (lines.length === 0) return null
  lines.reverse()

  // Trim whole lines off the front until the transcript fits. Truncating
  // mid-line would hand the model a sentence fragment as if it were complete.
  let body = lines.join("\n")
  while (lines.length > 1 && TRANSCRIPT_HEADER.length + 2 + body.length > limits.characterLimit) {
    lines.shift()
    body = lines.join("\n")
  }

  const rendered = `${TRANSCRIPT_HEADER}\n\n${body}`
  // A single line that still busts the budget is truncated rather than dropped:
  // some context beats none, and there is no earlier line left to shed.
  return rendered.length > limits.characterLimit
    ? rendered.slice(0, limits.characterLimit)
    : rendered
}

/** Wrap a rendered transcript in the client event that injects it. */
export function buildLiveVoiceContextEvent(transcript: string): RealtimeClientEvent {
  return {
    type: "conversation-item-create",
    item: { type: "text-message", role: "user", text: transcript },
  }
}
