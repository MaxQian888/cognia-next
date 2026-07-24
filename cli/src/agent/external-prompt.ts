/**
 * Flatten a resolved turn into the single prompt string an external agent takes.
 *
 * ACP and the Codex app-server both accept one text prompt per turn, while
 * Cognia's attachment pipeline can produce native image/document blocks. Rather
 * than let those blocks vanish — the silent-degradation failure this whole area
 * exists to remove — the external path builds attachments with vision OFF, so
 * `resolveImageRef` / `resolvePdfRef` take their established OCR + text-extraction
 * fallback and everything arrives as text.
 *
 * If a non-text block still reaches here, that fallback did not apply, and the
 * turn fails BEFORE anything is sent rather than quietly dropping the user's
 * attachment.
 */

import type { SendContent } from "@cognia/agent-config-types"

export interface ExternalPromptResult {
  text: string
  /** Block types that could not be represented as text, if any. */
  unsupported: string[]
}

/** Fold `content` into prompt text, reporting anything that could not fit. */
export function externalPromptText(content: SendContent): ExternalPromptResult {
  if (typeof content === "string") return { text: content, unsupported: [] }
  const parts: string[] = []
  const unsupported: string[] = []
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text)
      continue
    }
    unsupported.push(block.type)
  }
  return { text: parts.join("\n\n"), unsupported: [...new Set(unsupported)] }
}

/** The message shown when an attachment cannot cross the external boundary. */
export function unsupportedAttachmentMessage(backend: string, unsupported: string[]): string {
  const kinds = unsupported.join(", ")
  return (
    `The ${backend} backend cannot carry ${kinds} attachments, and Cognia could not ` +
    `extract them to text. Remove the attachment, or switch to the built-in agent for this turn.`
  )
}
