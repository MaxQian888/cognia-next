/**
 * Folding a finished assistant turn down to its conclusion.
 *
 * Once a turn completes, the reader mostly wants what it concluded, not the
 * route it took there. This module decides, from the parts alone, which parts
 * are the *process* (reasoning, tool calls, the narration between them) and
 * which stay on screen. The renderer folds the process into one
 * "Worked for 13m 8s" row that expands back to the ordinary grouped view.
 *
 * What stays visible:
 * - the conclusion: the last run of prose in the message;
 * - every part that is a deliverable or asks something of the reader
 *   (artifacts, files, sources, approvals gates, questions, dispatch banners).
 *   Hiding those behind a disclosure would hide the result itself.
 *
 * A turn with nothing to fold (no reasoning, no tool call) or with a tool call
 * still waiting on input or approval is not folded at all.
 */

import { isToolPartType, isTransparentPart } from "./agent-flow-grouping"

/** Part types that are process, wherever they sit in the message. */
const PROCESS_PART_TYPES: ReadonlySet<string> = new Set([
  "reasoning",
  "data-tool-summary",
  "data-commentary",
  "hook-notice",
])

/** Tool states that mean the turn still needs something before it is over. */
const PENDING_TOOL_STATES: ReadonlySet<string> = new Set([
  "input-streaming",
  "input-available",
  "approval-requested",
])

export interface TurnFold {
  /** Indices (into the parts array) that render inside the fold. */
  folded: ReadonlySet<number>
  /** Tool calls inside the fold. */
  toolCount: number
  /** Tool calls inside the fold that ended in an error. */
  failedCount: number
  /** Reasoning blocks inside the fold. */
  reasoningCount: number
}

type FoldablePart = { type?: string; state?: string; text?: string }

function isProcessPart(part: FoldablePart): boolean {
  const type = part?.type
  if (!type) return false
  return isToolPartType(type) || PROCESS_PART_TYPES.has(type)
}

function isProseText(part: FoldablePart): boolean {
  return part?.type === "text" && !isTransparentPart(part)
}

/**
 * Split a finished turn into the folded process and what stays visible, or
 * `null` when the turn should render unfolded.
 */
export function foldTurnParts<P extends FoldablePart>(parts: readonly P[]): TurnFold | null {
  let toolCount = 0
  let failedCount = 0
  let reasoningCount = 0
  for (const part of parts) {
    if (!isProcessPart(part)) continue
    if (isToolPartType(part.type)) {
      if (part.state && PENDING_TOOL_STATES.has(part.state)) return null
      toolCount += 1
      if (part.state === "output-error") failedCount += 1
    } else if (part.type === "reasoning") {
      reasoningCount += 1
    }
  }
  if (toolCount === 0 && reasoningCount === 0) return null

  // The conclusion: the last run of prose, walking back over parts that render
  // nothing. A non-prose part ends the run.
  const conclusion = new Set<number>()
  let last = -1
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (isProseText(parts[index])) {
      last = index
      break
    }
  }
  if (last !== -1) {
    for (let index = last; index >= 0; index -= 1) {
      const part = parts[index]
      if (isProseText(part)) conclusion.add(index)
      else if (!isTransparentPart(part)) break
    }
  }

  const folded = new Set<number>()
  parts.forEach((part, index) => {
    if (isProcessPart(part)) folded.add(index)
    else if (isProseText(part) && !conclusion.has(index)) folded.add(index)
  })
  return { folded, toolCount, failedCount, reasoningCount }
}

/**
 * Compact duration for the fold header: `45s`, `13m 8s`, `1h 2m`.
 *
 * Unlike the live run clock (`formatRunElapsed`), nothing here ticks, so the
 * seconds are not zero-padded and an hour drops its seconds.
 */
export function formatWorkedDuration(ms: number): string {
  const totalSec = Math.max(1, Math.round((Number.isFinite(ms) ? ms : 0) / 1000))
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (totalMin < 60) return sec === 0 ? `${totalMin}m` : `${totalMin}m ${sec}s`
  const hours = Math.floor(totalMin / 60)
  const min = totalMin % 60
  return min === 0 ? `${hours}h` : `${hours}h ${min}m`
}
