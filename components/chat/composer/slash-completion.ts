// Does the `/` popover have anything left to complete at the caret?
//
// The composer and the popover both need this answer and MUST agree on it. The
// popover uses it to decide whether to render; the composer uses it to decide
// whether ↑/↓/Tab/Enter belong to the list or to the textarea. When only the
// popover knew, a closed-looking panel still swallowed Enter and "sent" the
// message by overwriting a command instead — the exact failure that made a
// chained line (`/clear /resume ▮`) replace its FIRST command.
//
// Pure and dependency-free so both callers can share it without either owning
// the other.

import type { SlashCommand } from "@/lib/slash-commands/builtin"
import type { ComposerTrigger } from "../composer-trigger"

/**
 * The values this command's FIRST argument may take, when it declares a closed
 * set. Explicit `argumentOptions` win; otherwise the first `enum` param stands
 * in, which is where most commands express their choices.
 */
export function commandArgumentOptions(command: SlashCommand | undefined): readonly string[] {
  if (!command) return []
  if (command.argumentOptions && command.argumentOptions.length > 0) {
    return command.argumentOptions
  }
  return command.params?.find((param) => param.type === "enum")?.options ?? []
}

/**
 * True when the completion panel has something to offer for `trigger`.
 *
 * Non-slash triggers (`@`, `!`, `#`) always do — their panels are the only
 * affordance they have. A slash trigger has nothing in two states:
 *
 *   - `caretPastArgument` — the command word and its first argument are both
 *     behind the caret. Nothing here can be completed, and reopening the panel
 *     anchored on the command would offer to overwrite it.
 *   - the caret is inside a first argument whose command declares no options —
 *     the list would just fuzzy-match every command against the argument text.
 */
export function hasSlashCompletion(
  trigger: ComposerTrigger | null,
  commands: readonly SlashCommand[]
): boolean {
  if (!trigger) return false
  if (trigger.kind !== "slash") return true
  if (trigger.caretPastArgument) return false
  if (trigger.argumentQuery === undefined) return true
  const command = commands.find((candidate) => candidate.name === trigger.query)
  return commandArgumentOptions(command).length > 0
}
