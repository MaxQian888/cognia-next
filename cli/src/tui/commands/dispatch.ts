/**
 * The command dispatcher — turns a typed `/line` into a {@link CommandEffect}.
 *
 * Pure: the App interprets the returned effect (the only place side effects
 * happen). Replaces the former monolithic switch in `App.tsx`. Routing rules:
 *   - bare command → root handler (it decides: run / open a form / notice);
 *     else open a form when the root declares args; else list its subcommands.
 *   - first token matches a subcommand → that subcommand's handler (or a form
 *     when it needs args not supplied inline).
 *   - first token is not a subcommand → root handler with the full args; else a
 *     "unknown subcommand" notice.
 */
import { getCommand } from "./registry"
import type { CommandContext, CommandDescriptor, CommandEffect, SubcommandSpec } from "./types"

export interface ParsedCommand {
  name: string
  rest: string
}

/** Split a `/command rest…` line into its name and the remaining argument text. */
export function parseCommandLine(line: string): ParsedCommand | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith("/")) return null
  const [word, ...rest] = trimmed.slice(1).split(/\s+/)
  return { name: word.toLowerCase(), rest: rest.join(" ") }
}

/** Find a subcommand by name (case-insensitive). */
export function resolveSubcommand(
  desc: CommandDescriptor,
  token: string
): SubcommandSpec | undefined {
  const lower = token.toLowerCase()
  return desc.subcommands?.find((s) => s.name.toLowerCase() === lower)
}

function withArgs(ctx: CommandContext, args: string): CommandContext {
  return { ...ctx, args }
}

function subcommandList(desc: CommandDescriptor): string {
  return (desc.subcommands ?? []).map((s) => s.name).join(" | ")
}

function needsForm(specs: CommandArgSpecLike | undefined, args: string): boolean {
  return Boolean(specs && specs.length > 0) && args.trim().length === 0
}

type CommandArgSpecLike = NonNullable<CommandDescriptor["args"]>

export function dispatchCommand(line: string, ctx: CommandContext): CommandEffect {
  const parsed = parseCommandLine(line)
  if (!parsed) return { kind: "none" }

  const desc = getCommand(parsed.name)
  if (!desc) {
    return {
      kind: "notice",
      message: `Unknown command /${parsed.name} — /help for the list`,
    }
  }

  const args = parsed.rest
  const firstToken = args.split(/\s+/)[0] ?? ""

  // ── Bare command ────────────────────────────────────────────────────────────
  if (args.trim().length === 0) {
    if (desc.handler) return desc.handler(withArgs(ctx, ""))
    if (desc.args && desc.args.length > 0) {
      return {
        kind: "openForm",
        form: { title: `/${desc.name}`, commandName: desc.name, specs: desc.args },
      }
    }
    if (desc.subcommands && desc.subcommands.length > 0) {
      return { kind: "notice", message: `/${desc.name} <${subcommandList(desc)}>` }
    }
    return { kind: "notice", message: `/${desc.name} has no action.` }
  }

  // ── With args: try a subcommand first ───────────────────────────────────────
  const sub = resolveSubcommand(desc, firstToken)
  if (sub) {
    const remaining = args.slice(firstToken.length).trim()
    if (needsForm(sub.args, remaining)) {
      return {
        kind: "openForm",
        form: {
          title: `/${desc.name} ${sub.name}`,
          commandName: desc.name,
          subcommand: sub.name,
          specs: sub.args ?? [],
        },
      }
    }
    return sub.handler(withArgs(ctx, remaining))
  }

  // First token is not a subcommand.
  if (desc.handler) return desc.handler(withArgs(ctx, args))
  if (desc.subcommands && desc.subcommands.length > 0) {
    return {
      kind: "notice",
      message: `Unknown subcommand "${firstToken}" — try: ${subcommandList(desc)}`,
    }
  }
  return { kind: "notice", message: `/${desc.name} takes no arguments.` }
}
