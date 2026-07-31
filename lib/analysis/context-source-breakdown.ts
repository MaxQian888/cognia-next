/**
 * Estimate how the *visible transcript* divides across injection sources, for
 * the context hover card's "context by source" panel. This is the estimate-path
 * companion to the SDK-authoritative `SdkBreakdown` (which reports the true
 * system-prompt / tools / memory occupancy): when the live SDK usage isn't
 * available we can still break the conversation itself down by what produced
 * each chunk.
 *
 * Token figures are char/4 estimates (the same rough heuristic the composer
 * uses when the SDK reports nothing) — directional, not billing-accurate. Pure.
 */

import type { UIMessage } from "ai"

export type ContextSourceId =
  "userMessages" | "mentionedFiles" | "toolOutputs" | "thinking" | "taskCoordination"

/** Tools that are team/task coordination rather than real work. */
const COORDINATION_TOOLS = new Set(["SendMessage", "TaskCreate", "TaskUpdate", "TeamCreate"])

export interface ContextSourceRow {
  id: ContextSourceId
  tokens: number
}

export interface ContextSourceBreakdown {
  rows: ContextSourceRow[]
  totalTokens: number
}

type AnyPart = {
  type?: string
  text?: string
  input?: Record<string, unknown>
  output?: string
  errorText?: string
}

/** Rough token estimate from a character count (≈ 4 chars / token). */
function estTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

function partsOf(message: UIMessage): AnyPart[] {
  return (message.parts ?? []) as unknown as AnyPart[]
}

function toolNameOf(part: AnyPart): string | null {
  if (!part.type || !part.type.startsWith("tool-")) return null
  return part.type.slice("tool-".length)
}

/**
 * Break the transcript into per-source token estimates. `claude-md` /
 * system-prompt is intentionally absent — it isn't visible from the message
 * log (the SDK breakdown covers it on the authoritative path).
 */
export function buildContextSourceBreakdown(messages: UIMessage[]): ContextSourceBreakdown {
  let userMessages = 0
  let mentionedFiles = 0
  let toolOutputs = 0
  let thinking = 0
  let taskCoordination = 0

  for (const message of messages) {
    for (const part of partsOf(message)) {
      if (part.type === "text" && typeof part.text === "string") {
        if (message.role === "user") {
          userMessages += part.text.length
          // @-mentioned paths inflate context with file contents the SDK injects;
          // approximate their weight from the mention tokens in the message.
          for (const m of part.text.match(/@\S+/g) ?? []) mentionedFiles += m.length
        }
        continue
      }
      if (part.type === "reasoning" && typeof part.text === "string") {
        thinking += part.text.length
        continue
      }
      const tool = toolNameOf(part)
      if (!tool) continue
      const inputChars = part.input ? JSON.stringify(part.input).length : 0
      const outputChars = (part.output?.length ?? 0) + (part.errorText?.length ?? 0)
      if (COORDINATION_TOOLS.has(tool)) {
        taskCoordination += inputChars + outputChars
      } else {
        toolOutputs += inputChars + outputChars
      }
    }
  }

  const raw: Record<ContextSourceId, number> = {
    userMessages: estTokens(userMessages),
    mentionedFiles: estTokens(mentionedFiles),
    toolOutputs: estTokens(toolOutputs),
    thinking: estTokens(thinking),
    taskCoordination: estTokens(taskCoordination),
  }

  const rows = (Object.keys(raw) as ContextSourceId[])
    .map((id) => ({ id, tokens: raw[id] }))
    .filter((r) => r.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)

  return { rows, totalTokens: rows.reduce((acc, r) => acc + r.tokens, 0) }
}
