/**
 * `/commit` — generate a Conventional Commit message from the staged diff,
 * confirm, then commit. Pure descriptor: the root and the internal apply /
 * stage-all / cancel verbs route to the `commit` runtime controller. The
 * apply/stage-all/cancel verbs are driven by the confirm overlay's
 * onConfirm/onCancel commands (and are dispatchable by name).
 */
import { rt } from "./runtime-handler"
import type { CommandDescriptor } from "./types"

export const commitCommand: CommandDescriptor = {
  name: "commit",
  description: "write a Conventional Commit message from the staged diff and commit",
  category: "cognia",
  handler: rt("commit", "run"),
  subcommands: [
    {
      name: "apply",
      description: "create the commit from the confirmed message",
      handler: rt("commit", "apply"),
    },
    {
      name: "stage-all",
      description: "stage all changes, then commit",
      handler: rt("commit", "stage-all"),
    },
    {
      name: "cancel",
      description: "discard the pending commit message",
      handler: rt("commit", "cancel"),
    },
  ],
}
