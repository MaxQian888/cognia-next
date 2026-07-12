/**
 * `/bashes` — list and manage live `!command` runs (Claude Code's "bashes"
 * surface). Backgrounded commands (Ctrl+B) used to be unkillable and invisible;
 * this command makes every live run inspectable and controllable:
 *
 *   /bashes              → picker of every running command (fg + background)
 *   /bashes actions <id> → view / kill / foreground actions for one run
 *   /bashes view <id>    → full live output in the document pager
 *   /bashes kill <id>    → abort the run (whole process tree)
 *   /bashes fg <id>      → make it the Ctrl+C / Ctrl+B target again
 *
 * List/view are PURE over `ctx.state.cells` (bash cells mirror run status);
 * kill/fg are effects the App resolves against the live AbortController
 * registry in `use-bash-shellout`.
 */
import type { BashCell, SelectItem } from "../state/types"
import type { CommandContext, CommandDescriptor, CommandEffect } from "./types"

/** Live bash cells, oldest first (transcript order). */
export function runningBashCells(ctx: CommandContext): BashCell[] {
  return ctx.state.cells.filter((c): c is BashCell => c.kind === "bash" && c.status === "running")
}

function findBashCell(ctx: CommandContext, id: string): BashCell | undefined {
  return ctx.state.cells.find((c): c is BashCell => c.kind === "bash" && c.id === id)
}

/** One-line command label, truncated so picker rows stay single-line. */
export function bashRunLabel(cell: BashCell, max = 60): string {
  const cmd = cell.command.replace(/\s+/g, " ").trim()
  return cmd.length > max ? `${cmd.slice(0, max - 1)}…` : cmd
}

/** Build the `/bashes` picker rows from the live bash cells. */
export function buildBashesItems(cells: BashCell[]): SelectItem[] {
  return cells.map((c) => ({
    id: c.id,
    label: `${c.background ? "⧗" : "⏵"} ${bashRunLabel(c)}`,
    hint: c.background ? "background" : "foreground · Ctrl+C kills",
  }))
}

export function bashesListHandler(ctx: CommandContext): CommandEffect {
  const running = runningBashCells(ctx)
  if (running.length === 0) {
    return {
      kind: "notice",
      message: "No running !commands · start one with !<command>, Ctrl+B backgrounds it",
    }
  }
  return {
    kind: "openOverlay",
    overlay: {
      kind: "select",
      title: `Running commands (${running.length})`,
      items: buildBashesItems(running),
      index: 0,
      onSelectCommand: "bashes actions",
    },
  }
}

export function bashesActionsHandler(ctx: CommandContext): CommandEffect {
  const id = ctx.args.trim()
  const cell = id ? findBashCell(ctx, id) : undefined
  if (!cell) return { kind: "notice", message: "Usage: /bashes actions <id> (see /bashes)" }
  if (cell.status !== "running") {
    // The run settled between the picker opening and the choice — only its
    // output is still interesting.
    return bashesViewHandler(ctx)
  }
  const items: SelectItem[] = [
    { id: `view ${id}`, label: "View output", hint: "full live output in the pager" },
    { id: `kill ${id}`, label: "Kill", hint: "abort the whole process tree" },
  ]
  if (cell.background) {
    items.push({
      id: `fg ${id}`,
      label: "Foreground",
      hint: "make it the Ctrl+C / Ctrl+B target",
    })
  }
  return {
    kind: "openOverlay",
    overlay: {
      kind: "select",
      title: `! ${bashRunLabel(cell)}`,
      items,
      index: 0,
      onSelectCommand: "bashes",
    },
  }
}

export function bashesViewHandler(ctx: CommandContext): CommandEffect {
  const id = ctx.args.trim()
  const cell = id ? findBashCell(ctx, id) : undefined
  if (!cell) return { kind: "notice", message: "Usage: /bashes view <id> (see /bashes)" }
  const statusNote =
    cell.status === "running"
      ? cell.background
        ? "(still running in the background)"
        : "(still running in the foreground)"
      : `(${cell.status}${cell.exitCode !== undefined ? ` · exit ${cell.exitCode}` : ""})`
  return {
    kind: "openOverlay",
    overlay: {
      kind: "document",
      title: `! ${bashRunLabel(cell)} ${statusNote}`,
      body: cell.output || "(no output yet)",
      format: "text",
    },
  }
}

export function bashesKillHandler(ctx: CommandContext): CommandEffect {
  const id = ctx.args.trim()
  if (!id) return { kind: "notice", message: "Usage: /bashes kill <id> (see /bashes)" }
  return { kind: "bashKill", id }
}

export function bashesForegroundHandler(ctx: CommandContext): CommandEffect {
  const id = ctx.args.trim()
  if (!id) return { kind: "notice", message: "Usage: /bashes fg <id> (see /bashes)" }
  return { kind: "bashForeground", id }
}

export const BASHES_COMMANDS: CommandDescriptor[] = [
  {
    name: "bashes",
    aliases: ["jobs"],
    description: "list and manage running !commands",
    category: "system",
    argumentHint: "[view|kill|fg <id>]",
    handler: bashesListHandler,
    subcommands: [
      {
        name: "actions",
        description: "pick an action (view / kill / foreground) for one run",
        argumentHint: "<id>",
        handler: bashesActionsHandler,
      },
      {
        name: "view",
        description: "open a run's full output in the pager",
        argumentHint: "<id>",
        handler: bashesViewHandler,
      },
      {
        name: "kill",
        description: "abort a running command (foreground or background)",
        argumentHint: "<id>",
        handler: bashesKillHandler,
      },
      {
        name: "fg",
        description: "bring a backgrounded command back to the foreground",
        argumentHint: "<id>",
        handler: bashesForegroundHandler,
      },
    ],
  },
]
