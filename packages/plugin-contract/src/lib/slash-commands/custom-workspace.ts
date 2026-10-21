/**
 * The plugin contract's share of `lib/slash-commands/custom-workspace.ts`, which re-exports these.
 */

import type { SlashCommand } from "./builtin"

export type ProjectCommandDir = (typeof PROJECT_COMMAND_DIRS)[number]

/** A custom command plus the directory it came from. */
export interface WorkspaceCustomCommand extends SlashCommand {
  /** Repo-relative directory the file was found in. */
  originDir: ProjectCommandDir
}

/** The two directories a repository may keep its commands in. */
export const PROJECT_COMMAND_DIRS = [".cognia/commands", ".claude/commands"] as const
