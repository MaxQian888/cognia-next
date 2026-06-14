/**
 * Pure parser for in-chat control commands (control-plane completion).
 *
 * An inbound IM message like `/model gpt-5` or `/mode auto` is intercepted by
 * the bus (`commands/dispatch.ts`) BEFORE the AI turn and applied as a control
 * action. This module only classifies the text — it has no I/O.
 *
 * Grammar: `^/<name>(\s+<arg>)?$` where `<name>` is `[A-Za-z][A-Za-z-]*`. The
 * leading-slash requirement plus the "whitespace-or-end after the name token"
 * rule means a file path like `/home/user/file` (slash mid-token, no
 * whitespace) is NOT a command — it parses as `not-a-command` and flows to the
 * AI as normal text. Command names are case-insensitive; the argument keeps
 * its original case (model ids / session titles are case-sensitive).
 */

/** Every recognised control command. */
export type ControlCommandName =
  | "help"
  | "commands"
  | "status"
  | "sessions"
  | "dir"
  | "new"
  | "switch"
  | "resume"
  | "mode"
  | "model"
  | "reasoning"
  | "character"
  | "team"
  | "workflow"

/**
 * Commands anyone may run regardless of the permission gate. `help` is here so
 * the dispatcher recognises it (then defers to the existing rich help-card
 * dispatcher), and `commands` lists the control commands as plain text.
 */
export const READONLY_COMMANDS: ReadonlySet<ControlCommandName> = new Set([
  "help",
  "commands",
  "status",
  "sessions",
  "dir",
])

const KNOWN_COMMANDS: ReadonlySet<string> = new Set<ControlCommandName>([
  "help",
  "commands",
  "status",
  "sessions",
  "dir",
  "new",
  "switch",
  "resume",
  "mode",
  "model",
  "reasoning",
  "character",
  "team",
  "workflow",
])

export interface KnownControlCommand {
  kind: "known"
  name: ControlCommandName
  /** Trimmed argument string after the command token; `""` when none. */
  arg: string
}

export type ParsedControlCommand =
  | KnownControlCommand
  | { kind: "unknown"; name: string }
  | { kind: "not-a-command" }

const COMMAND_RE = /^\/([A-Za-z][A-Za-z-]*)(?:\s+([\s\S]*))?$/

/**
 * Classify an inbound message's plain text as a control command. Returns
 * `not-a-command` for anything that isn't a clean `/name [arg]` (including file
 * paths and bare slashes), `unknown` for an unrecognised command name, and
 * `known` with the lowercased name + trimmed arg otherwise.
 */
export function parseControlCommand(plainText: string): ParsedControlCommand {
  const trimmed = plainText.trimStart()
  if (!trimmed.startsWith("/")) return { kind: "not-a-command" }
  const m = trimmed.match(COMMAND_RE)
  if (!m) return { kind: "not-a-command" }
  const name = m[1].toLowerCase()
  const arg = (m[2] ?? "").trim()
  if (!KNOWN_COMMANDS.has(name)) return { kind: "unknown", name }
  return { kind: "known", name: name as ControlCommandName, arg }
}

/** True when the command may run without the state-change permission gate. */
export function isReadonlyCommand(name: ControlCommandName): boolean {
  return READONLY_COMMANDS.has(name)
}
