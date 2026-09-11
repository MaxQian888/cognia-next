/**
 * `/bashes` — list and manage live `!command` runs (Claude Code's "bashes"
 * surface). Backgrounded commands (Ctrl+B) used to be unkillable and invisible;
 * this command makes every live run inspectable and controllable:
 *
 *   /bashes              → picker of every running command (fg + background)
 *   /bashes history      → picker including finished command output
 *   /bashes actions <id> → view / kill / foreground actions for one run
 *   /bashes view <id>    → full live output in the document pager
 *   /bashes kill <id>    → abort the run (whole process tree)
 *   /bashes fg <id>      → make it the Ctrl+C / Ctrl+B target again
 *
 * List/view are PURE over `ctx.state.cells` (bash cells mirror run status);
 * kill/fg are effects the App resolves against the live AbortController
 * registry in `use-bash-shellout`.
 */
import { createCliTranslator, type CliLocale } from "../i18n"
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
export function buildBashesItems(cells: BashCell[], locale?: CliLocale): SelectItem[] {
  const t = createCliTranslator(locale, "cliUiCommands")
  return cells.map((c) => ({
    id: c.id,
    label: `${c.background ? "⧗" : "⏵"} ${bashRunLabel(c)}`,
    hint:
      c.status !== "running"
        ? `${t(`bashStatus_${c.status}`)}${c.exitCode !== undefined ? ` · ${t("bashExit", { code: c.exitCode })}` : ""}`
        : t(c.background ? "bashBackground" : "bashForeground"),
  }))
}

export function bashesListHandler(ctx: CommandContext): CommandEffect {
  const t = createCliTranslator(ctx.config.locale, "cliUiCommands")
  const running = runningBashCells(ctx)
  if (running.length === 0) {
    return {
      kind: "notice",
      message: t("bashEmpty", { command: "!<command>" }),
    }
  }
  return {
    kind: "openOverlay",
    overlay: {
      kind: "select",
      title: t("bashRunning", { count: running.length }),
      items: buildBashesItems(running, ctx.config.locale),
      index: 0,
      onSelectCommand: "bashes actions",
    },
  }
}

export function bashesActionsHandler(ctx: CommandContext): CommandEffect {
  const t = createCliTranslator(ctx.config.locale, "cliUiCommands")
  const id = ctx.args.trim()
  const cell = id ? findBashCell(ctx, id) : undefined
  if (!id) return bashesListHandler(ctx)
  if (!cell) return { kind: "notice", message: t("bashMissing", { id }) }
  if (cell.status !== "running") {
    // The run settled between the picker opening and the choice — only its
    // output is still interesting.
    return bashesViewHandler(ctx)
  }
  const items: SelectItem[] = [
    { id: `view ${id}`, label: t("bashView"), hint: t("bashViewHint") },
    { id: `kill ${id}`, label: t("bashKill"), hint: t("bashKillHint") },
  ]
  if (cell.background) {
    items.push({
      id: `fg ${id}`,
      label: t("bashFg"),
      hint: t("bashFgHint"),
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

/** The same document shape is rebuilt from current cells while the viewer is open. */
export function bashOutputDocument(cell: BashCell, locale?: CliLocale) {
  const t = createCliTranslator(locale, "cliUiCommands")
  const status =
    cell.status === "running"
      ? t(cell.background ? "bashBackground" : "bashForeground")
      : t(`bashStatus_${cell.status}`)
  return {
    kind: "document" as const,
    sourceBashId: cell.id,
    title: `! ${bashRunLabel(cell)} (${status}${cell.exitCode !== undefined ? ` · ${t("bashExit", { code: cell.exitCode })}` : ""})`,
    body: cell.output || t("bashNoOutput"),
    format: "text" as const,
  }
}

function pickBash(ctx: CommandContext, action: "view" | "kill" | "fg"): CommandEffect {
  const t = createCliTranslator(ctx.config.locale, "cliUiCommands")
  const cells = ctx.state.cells.filter(
    (cell): cell is BashCell =>
      cell.kind === "bash" &&
      (action === "view" ||
        (cell.status === "running" && (action !== "fg" || cell.background === true)))
  )
  if (!cells.length) return { kind: "notice", message: t("bashNoTargets") }
  return {
    kind: "openOverlay",
    overlay: {
      kind: "select",
      title: t(action === "view" ? "bashView" : action === "kill" ? "bashKill" : "bashFg"),
      items: buildBashesItems(cells, ctx.config.locale),
      index: 0,
      onSelectCommand: `bashes ${action}`,
    },
  }
}

export function bashesViewHandler(ctx: CommandContext): CommandEffect {
  const id = ctx.args.trim()
  if (!id) return pickBash(ctx, "view")
  const cell = findBashCell(ctx, id)
  if (!cell)
    return {
      kind: "notice",
      message: createCliTranslator(ctx.config.locale, "cliUiCommands")("bashMissing", { id }),
    }
  return { kind: "openOverlay", overlay: bashOutputDocument(cell, ctx.config.locale) }
}

export function bashesKillHandler(ctx: CommandContext): CommandEffect {
  const id = ctx.args.trim()
  if (!id) return pickBash(ctx, "kill")
  return { kind: "bashKill", id }
}

export function bashesForegroundHandler(ctx: CommandContext): CommandEffect {
  const id = ctx.args.trim()
  if (!id) return pickBash(ctx, "fg")
  return { kind: "bashForeground", id }
}

export const BASHES_COMMANDS: CommandDescriptor[] = [
  {
    name: "bashes",
    aliases: ["jobs"],
    description: "list and manage running !commands",
    category: "system",
    argumentHint: "[history|view|kill|fg [id]]",
    handler: bashesListHandler,
    subcommands: [
      {
        name: "history",
        description: "browse output from running and finished commands",
        handler: (ctx) => pickBash(ctx, "view"),
      },
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
