/**
 * What the transcript's selection mode does with the messages ticked — the parts
 * that need no store, no model and no DOM.
 *
 * Each action reads the messages the way its single-message counterpart already
 * does, so ticking one message and acting on it is never different from the
 * message's own button:
 *
 *  - Summarize reads what `@msg:` reads (`projectMessageBody`: prose, tool output,
 *    a note where a context envelope was), one segment per message, so a long
 *    selection is cut between messages and never inside one it can avoid.
 *  - Copy reads what the message's copy action copies (`buildMessageShareContent`:
 *    the typed words, file and source links), labelled by who said it.
 */

import type { UIMessage } from "ai"
import { projectMessageBody } from "@/lib/chat/mentions/message-reference"
import { buildMessageShareContent } from "@/lib/chat/message-share"

interface MessageLike {
  id: string
  role: string
  parts: unknown
}

/** The ticked messages, in the order the transcript shows them. */
export function selectedInTranscriptOrder<T extends { id: string }>(
  messages: readonly T[],
  selected: ReadonlySet<string>
): T[] {
  return messages.filter((message) => selected.has(message.id))
}

export interface SelectionMaterial {
  /** One entry per message, labelled by role — what a summary is made from. */
  segments: string[]
  /**
   * The same messages without labels, joined — what a staged summary records as
   * its source, so a refresh can check the messages still say it.
   */
  quote: string
  /** The messages that contributed, in order. A message with nothing to read is left out. */
  messageIds: string[]
}

export function selectionMaterial(messages: readonly MessageLike[]): SelectionMaterial {
  const segments: string[] = []
  const bodies: string[] = []
  const messageIds: string[] = []
  for (const message of messages) {
    const body = projectMessageBody(message.parts)
    if (!body) continue
    // English and the raw role, like every other prompt a model reads here.
    segments.push(`${message.role}: ${body}`)
    bodies.push(body)
    messageIds.push(message.id)
  }
  return { segments, quote: bodies.join("\n"), messageIds }
}

export interface SpeakerLabels {
  user: string
  assistant: string
  system: string
}

/**
 * The ticked messages as clipboard text, each under who said it.
 *
 * The label is the caller's, localized: this lands in the user's own notes, not
 * in a prompt. An inline image is named rather than pasted as a data URL, the
 * way native sharing names it — twelve messages of base64 is not a copy anyone
 * wanted.
 */
export function selectionCopyText(messages: readonly UIMessage[], labels: SpeakerLabels): string {
  return messages
    .flatMap((message) => {
      const content = buildMessageShareContent(message)
      if (!content.hasContent) return []
      const label =
        message.role === "user"
          ? labels.user
          : message.role === "assistant"
            ? labels.assistant
            : labels.system
      return [`${label}:\n${content.nativeShareText}`]
    })
    .join("\n\n")
}
