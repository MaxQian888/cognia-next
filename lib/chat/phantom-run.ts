/**
 * Closing out tool calls a turn left open.
 *
 * A tool part only leaves `input-streaming` / `input-available` when its
 * result arrives. A turn that ends any other way — an ACP prompt that timed
 * out (`Request timeout: session/prompt` clears the client's tool state and
 * emits a bare `error`), a runtime that died, a Host restarted under a run, a
 * renderer reload mid-turn — never delivers those results, so the parts stay
 * open. Every surface that reads them (the tool row's blue "running" dot, the
 * run strip's active-tool line) then reports work that stopped long ago as
 * still running, persisted, across every reload.
 *
 * These helpers rewrite such parts into a terminal `output-error` that says
 * the call was interrupted. Pure: no store, no Dexie. Each returns the SAME
 * array when nothing changed, so a caller can skip its write.
 */

import type { UIMessage } from "ai"

import { turnAdmissionMetaOf } from "@/lib/chat/turn-admission"

/**
 * The `errorText` an interrupted tool part carries. A fixed sentence (the
 * part's `errorText` is transcript data, like any tool's own error output)
 * so every reader can recognise the closure; a known cause is appended.
 */
export const TOOL_INTERRUPTED_ERROR_TEXT =
  "Interrupted: the turn ended before this tool call finished."

/**
 * Tool states that only a still-running turn can move forward: the call is
 * streaming its input, executing, or waiting on an approval nobody can answer
 * once the turn is gone.
 */
const OPEN_TOOL_STATES: ReadonlySet<string> = new Set([
  "input-streaming",
  "input-available",
  "approval-requested",
])

type PartRecord = Record<string, unknown>

function isToolPart(part: PartRecord): boolean {
  const type = part.type
  return typeof type === "string" && (type === "dynamic-tool" || type.startsWith("tool-"))
}

/** Whether `part` is a tool call still waiting on a result. */
export function isOpenToolPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false
  const record = part as PartRecord
  return (
    isToolPart(record) && typeof record.state === "string" && OPEN_TOOL_STATES.has(record.state)
  )
}

/** Whether any message in `messages` carries an open tool call. */
export function hasOpenToolParts(messages: readonly UIMessage[]): boolean {
  return messages.some(
    (message) => message.role === "assistant" && (message.parts ?? []).some(isOpenToolPart)
  )
}

function interruptedErrorText(cause: string | undefined): string {
  const detail = cause?.trim()
  return detail ? `${TOOL_INTERRUPTED_ERROR_TEXT} (${detail})` : TOOL_INTERRUPTED_ERROR_TEXT
}

/** `message` with its open tool parts closed, or the same object when none were open. */
function closeMessage(message: UIMessage, errorText: string): UIMessage {
  if (message.role !== "assistant") return message
  const parts = message.parts ?? []
  if (!parts.some(isOpenToolPart)) return message
  const closed = parts.map((part) => {
    if (!isOpenToolPart(part)) return part
    const { output: _output, approval: _approval, ...rest } = part as PartRecord
    return { ...rest, state: "output-error", errorText }
  })
  return { ...message, parts: closed as UIMessage["parts"] }
}

export interface CloseToolPartsResult {
  /** The full list, with closures applied (the input array when unchanged). */
  messages: UIMessage[]
  /** Only the messages that changed — what a partial transcript write needs. */
  changed: UIMessage[]
}

/**
 * Close every open tool part in `messages`.
 *
 * For a session whose turn is known to be over (it failed, it was stopped, or
 * nothing is running it any more): no part of it can still receive a result.
 * `cause` is the turn's own failure, when known, so the closed row says why.
 */
export function closeOpenToolParts(messages: UIMessage[], cause?: string): CloseToolPartsResult {
  const errorText = interruptedErrorText(cause)
  const changed: UIMessage[] = []
  const next = messages.map((message) => {
    const closed = closeMessage(message, errorText)
    if (closed !== message) changed.push(closed)
    return closed
  })
  return changed.length === 0 ? { messages, changed } : { messages: next, changed }
}

/**
 * Close the open tool parts of turns the transcript itself proves are over,
 * leaving the trailing turn alone unless it is marked failed.
 *
 * Safe on any transcript, including one whose newest turn may still be live
 * somewhere this realm cannot see (a Host turn the client has not been told
 * about yet): a turn followed by a later user message is over, and a turn
 * whose user message carries a `failed` admission mark was settled by the
 * failure path. The trailing, unmarked turn is never touched here — only a
 * caller that has established nothing is running it may close it, through
 * {@link closeOpenToolParts}.
 */
export function closeEndedTurnToolParts(
  messages: UIMessage[],
  options: {
    /**
     * The session is busy in this realm right now: its trailing turn may be a
     * retry still running, so it is left alone whatever its mark says.
     */
    trailingMayBeLive?: boolean
  } = {}
): CloseToolPartsResult {
  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      lastUserIndex = index
      break
    }
  }
  const trailingFailure =
    lastUserIndex >= 0 ? turnAdmissionMetaOf(messages[lastUserIndex].metadata) : null
  const trailingEnded = trailingFailure?.state === "failed" && !options.trailingMayBeLive
  const trailingCause =
    trailingFailure?.state === "failed" ? (trailingFailure.detail ?? undefined) : undefined

  const changed: UIMessage[] = []
  const next = messages.map((message, index) => {
    // Assistant messages before the last user message belong to finished turns.
    const ended = index < lastUserIndex || trailingEnded
    if (!ended) return message
    const closed = closeMessage(
      message,
      interruptedErrorText(index > lastUserIndex ? trailingCause : undefined)
    )
    if (closed !== message) changed.push(closed)
    return closed
  })
  return changed.length === 0 ? { messages, changed } : { messages: next, changed }
}
