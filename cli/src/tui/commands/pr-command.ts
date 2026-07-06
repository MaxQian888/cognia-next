/**
 * `/pr` — summarize the branch's commits vs the base branch into a PR title +
 * body, confirm, then open a draft PR with `gh`. Pure descriptor: the root and
 * the internal apply / cancel verbs route to the `pr` runtime controller. The
 * apply/cancel verbs are driven by the confirm overlay's onConfirm/onCancel
 * commands (and are dispatchable by name).
 */
import { rt } from "./runtime-handler"
import type { CommandDescriptor } from "./types"

export const prCommand: CommandDescriptor = {
  name: "pr",
  description: "draft a pull request (title + body) from this branch's commits",
  category: "cognia",
  handler: rt("pr", "run"),
  subcommands: [
    { name: "apply", description: "open the draft PR with gh", handler: rt("pr", "apply") },
    { name: "cancel", description: "discard the pending PR draft", handler: rt("pr", "cancel") },
  ],
}
