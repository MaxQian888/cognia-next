/**
 * Bubbles read off a chat window → the copilot transcript (ADR-0194 §8).
 *
 * Sides are only kept when they can be trusted:
 *
 * - a single-column app never has them (`single_column`);
 * - an app this table does not know is trusted only when the frame shows
 *   BOTH sides somewhere; all-left could equally be a one-column layout
 *   (`one_sided`);
 * - any bubble the grouper could not place leaves the transcript unsided
 *   (`ambiguous`).
 *
 * An unsided transcript is drafted for and never judged (`runCopilot`), so a
 * layout the copilot cannot read costs rankings, never a confident misread.
 *
 * Group-chat sender names are replaced by neutral "Person A/B" labels: the
 * judge only needs to tell speakers apart, and a raw nickname read off
 * someone's screen has no business in a prompt.
 */

import { COPILOT_WINDOW, type CopilotTranscript, type CopilotTurn } from "../build-state"
import type { ScreenBubble } from "./bubble-grouper"
import type { ChatLayout } from "./chat-apps"

export type UnsidedReason = "single_column" | "one_sided" | "ambiguous"

export interface ScreenTranscript {
  transcript: CopilotTranscript
  /** Why the senders are not all known, or null when they are. */
  unsidedReason: UnsidedReason | null
  /** Bubbles read in the whole frame (the transcript keeps the last window). */
  bubbleCount: number
}

function speakerAlias(index: number): string {
  return `Person ${String.fromCharCode(65 + (index % 26))}${index >= 26 ? Math.floor(index / 26) : ""}`
}

export function buildScreenTranscript(
  bubbles: readonly ScreenBubble[],
  layout: ChatLayout
): ScreenTranscript {
  const window = bubbles.slice(-COPILOT_WINDOW)

  let unsidedReason: UnsidedReason | null = null
  if (layout === "single_column") unsidedReason = "single_column"
  else if (layout === "unknown" && !bubbles.some((bubble) => bubble.side === "me")) {
    unsidedReason = "one_sided"
  } else if (window.some((bubble) => bubble.side === "unknown")) unsidedReason = "ambiguous"

  const forgetSides = unsidedReason === "single_column" || unsidedReason === "one_sided"
  const aliases = new Map<string, string>()
  for (const bubble of window) {
    if (bubble.speaker && !aliases.has(bubble.speaker)) {
      aliases.set(bubble.speaker, speakerAlias(aliases.size))
    }
  }
  const isGroup = aliases.size > 1

  const turns = window.map((bubble): CopilotTurn => {
    const from = forgetSides ? "unknown" : bubble.side
    const alias = bubble.speaker ? aliases.get(bubble.speaker) : undefined
    return { from, text: isGroup && alias ? `${alias}: ${bubble.text}` : bubble.text }
  })

  return {
    transcript: {
      turns,
      latestFrom: turns.at(-1)?.from ?? "other",
      latestOtherSender: null,
      isGroup,
    },
    unsidedReason,
    bubbleCount: bubbles.length,
  }
}
