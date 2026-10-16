/**
 * The instruction each quick action sends (ADR-0228 §1).
 *
 * Translated, because the instruction is the person's ask in their language,
 * and the agent answers in the language it is asked in. A `switch` with
 * literal keys so the locale coverage test can see every key.
 */
import type { QuickActionId } from "../capture/capture-request"

export function quickActionInstruction(
  action: QuickActionId,
  message: (key: string) => string
): string {
  switch (action) {
    case "summarize":
      return message("quickPromptSummarize")
    case "explain":
      return message("quickPromptExplain")
    case "translate":
      return message("quickPromptTranslate")
  }
}

export function quickActionLabel(action: QuickActionId, message: (key: string) => string): string {
  switch (action) {
    case "summarize":
      return message("quickActionSummarize")
    case "explain":
      return message("quickActionExplain")
    case "translate":
      return message("quickActionTranslate")
  }
}
