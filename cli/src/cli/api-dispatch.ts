/**
 * The derived resource commands: `cognia-agent plugin list` is
 * `cognia-agent api call plugin_list`.
 *
 * Command names on the wire are already `<group>_<action>`, so the resource
 * surface is a projection of the generated index rather than a second table
 * anyone has to maintain. Adding a command to the host adds it here.
 *
 * The CLI's own 23 commands always win their bare name. Four protocol groups
 * collide with one (`host`, `lark`, `provider`, `sync`), and those stay
 * reachable through `api call`. A test pins the
 * collision list, so a future host command that shadows a CLI verb fails the
 * build rather than quietly changing what a familiar command does.
 */

import { apiCommand, type ApiCommandDeps } from "./api-command"
import type { ParsedArgs } from "./args"
import { commandGroups, findByGroupAction } from "../api/catalog"
import { KNOWN_COMMANDS } from "./known-commands"

/** Names the hand-written commands own, plus the two bare verbs `main` handles. */
export function reservedNames(): Set<string> {
  return new Set([...KNOWN_COMMANDS, "help", "version"])
}

/** Protocol groups that a hand-written command already occupies. */
export function shadowedGroups(): string[] {
  const reserved = reservedNames()
  return commandGroups()
    .map((group) => group.group)
    .filter((group) => reserved.has(group))
}

/** Protocol groups reachable as a bare `cognia-agent <group> <action>`. */
export function derivedGroups(): string[] {
  const reserved = reservedNames()
  return commandGroups()
    .map((group) => group.group)
    .filter((group) => !reserved.has(group))
}

export interface DerivedMatch {
  /** The wire command name this invocation means. */
  command: string
}

/**
 * Does this invocation name a derived command?
 *
 * `undefined` means "not ours", and the caller falls through to its own
 * unknown-command handling. A reserved group is never a match, so this can be
 * consulted only after the hand-written switch has declined.
 */
export function matchDerived(args: ParsedArgs): DerivedMatch | undefined {
  const group = args.command
  if (!group || reservedNames().has(group)) return undefined
  // `args.subcommand` is only populated for GROUPED_COMMANDS, so a derived
  // invocation carries its action as the first positional.
  const action = args.subcommand ?? args.positionals[0] ?? ""
  const entry = findByGroupAction(group, action)
  if (!entry) return undefined
  return { command: entry.name }
}

export interface DerivedDeps extends ApiCommandDeps {
  argv?: string[]
}

/**
 * Run a derived command by rewriting it into the `api` plane.
 *
 * `--help` becomes `api describe`, because the useful help for
 * `cognia-agent plugin list` is that command's own fields, not the generic
 * `api` usage block.
 */
export async function dispatchDerived(
  args: ParsedArgs,
  match: DerivedMatch,
  deps: DerivedDeps = {}
): Promise<number> {
  const trailing = args.subcommand ? args.positionals : args.positionals.slice(1)
  const wantsHelp = args.help

  const rewritten: ParsedArgs = {
    command: "api",
    subcommand: wantsHelp ? "describe" : "call",
    positionals: wantsHelp ? [match.command] : [match.command, ...trailing],
    // `help` would make `apiCommand` print the generic usage block instead of
    // describing this command, so it is dropped from the rewritten flags.
    flags: wantsHelp
      ? Object.fromEntries(Object.entries(args.flags).filter(([name]) => name !== "help"))
      : args.flags,
    rest: args.rest,
    help: false,
    version: false,
  }
  return apiCommand(rewritten, deps)
}
