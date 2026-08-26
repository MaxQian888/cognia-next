/**
 * Git-first, prompt-driven dev-workflow commands: `/review`, `/commit`, `/pr`,
 * `/stack`, `/fix`. Each descriptor is pure — `/review` returns a `send` effect, `/fix`
 * returns a `fixRun` effect, and `/commit` / `/pr` return `runtime` effects the
 * App routes to their controllers. Barrelled here so `index.ts` registers the
 * whole cluster with one import.
 */
import { reviewCommand } from "./review-command"
import { fixCommand } from "./fix-command"
import { commitCommand } from "./commit-command"
import { prCommand } from "./pr-command"
import { stackCommand } from "./stack-command"
import type { CommandDescriptor } from "./types"

export const DEV_WORKFLOW_COMMANDS: CommandDescriptor[] = [
  reviewCommand,
  commitCommand,
  prCommand,
  stackCommand,
  fixCommand,
]
