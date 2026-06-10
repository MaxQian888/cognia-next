/**
 * Minimal, dependency-free argv parser for the agent CLI.
 *
 * Grammar: `cognia-agent [command] [subcommand] [positionals…] [--flags]`.
 * Boolean flags (see {@link BOOLEAN_FLAGS}) take no value; every other `--flag`
 * consumes the next token (or uses `--flag=value`). Short aliases: `-h`, `-v`,
 * `-y`. Pure + exported so parsing unit-tests without spawning a process.
 */

export interface ParsedArgs {
  /** First positional — `run` | `auth` | `config` | undefined. */
  command?: string
  /** Second positional for grouped commands (`auth login`, `config set`). */
  subcommand?: string
  /** Remaining positionals (the prompt for `run`; key/value for `config`). */
  positionals: string[]
  /** Parsed flags; boolean flags are `true`, value flags carry their string. */
  flags: Record<string, string | boolean>
  help: boolean
  version: boolean
}

/** Flags that never consume a following token. */
export const BOOLEAN_FLAGS = new Set(["yes", "json", "help", "version", "handoff"])

/** Commands whose first extra positional is a subcommand, not free content. */
export const GROUPED_COMMANDS = new Set(["auth", "config"])

const SHORT_ALIAS: Record<string, string> = { h: "help", v: "version", y: "yes" }

function normalizeFlagName(token: string): { name: string; inlineValue?: string } {
  const body = token.replace(/^--?/, "")
  const eq = body.indexOf("=")
  if (eq >= 0) return { name: body.slice(0, eq), inlineValue: body.slice(eq + 1) }
  return { name: body }
}

export function parseArgv(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {}
  const positionals: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token.startsWith("-") && token !== "-") {
      const isShort = !token.startsWith("--")
      const { name: rawName, inlineValue } = normalizeFlagName(token)
      const name = isShort ? (SHORT_ALIAS[rawName] ?? rawName) : rawName
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true
        continue
      }
      if (inlineValue !== undefined) {
        flags[name] = inlineValue
        continue
      }
      const next = argv[i + 1]
      if (next !== undefined && !(next.startsWith("-") && next !== "-")) {
        flags[name] = next
        i++
      } else {
        // Value flag with no value → treat as boolean true (e.g. trailing).
        flags[name] = true
      }
      continue
    }
    positionals.push(token)
  }

  const command = positionals.shift()
  let subcommand: string | undefined
  if (command && GROUPED_COMMANDS.has(command)) {
    subcommand = positionals.shift()
  }

  return {
    command,
    subcommand,
    positionals,
    flags,
    help: flags.help === true,
    version: flags.version === true,
  }
}

/** Read a string flag (value flags only); returns undefined when absent/boolean. */
export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name]
  return typeof v === "string" ? v : undefined
}

/** Read a boolean flag. */
export function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true
}
