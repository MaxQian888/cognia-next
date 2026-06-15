/**
 * `/inspect` (alias `/cells`) — open the tool-output inspector: a picker of every
 * tool/bash/subagent cell that produced output, newest-first. Enter opens the
 * chosen cell's full, syntax-highlighted output in the document pager. This is
 * the keyboard route the screenshot's "click to expand" maps to (Ink can't catch
 * clicks on scrollback). Pure handler over `ctx.state.cells`.
 */
import { collectInspectables } from "../runtime/inspect"
import type { CommandContext, CommandDescriptor, CommandEffect } from "./types"

export function inspectHandler(ctx: CommandContext): CommandEffect {
  const items = collectInspectables(ctx.state.cells)
  if (items.length === 0) {
    return { kind: "notice", message: "No tool output to inspect yet." }
  }
  return { kind: "openOverlay", overlay: { kind: "inspect", items, index: 0 } }
}

export const INSPECT_COMMANDS: CommandDescriptor[] = [
  {
    name: "inspect",
    aliases: ["cells"],
    description: "browse and expand any tool/file output",
    category: "system",
    handler: inspectHandler,
  },
]
