/**
 * First-class `SlashCommand` tool, host-routed like the promoted web tools.
 *
 * Claude Code parity: lets the model invoke a registered slash command. The
 * command runs through the live registry (`lib/slash-commands/registry`), so
 * plugin commands and any command with a real handler execute fully.
 *
 * HONEST LIMITATION: the app's built-in UI commands (e.g. /goal, /model,
 * /limits) register renderer-only stub handlers — invoking them through this
 * tool returns their "run it from the chat composer" guidance rather than
 * performing the UI action. This matches Claude Code's SlashCommand semantics
 * (it triggers the command; whether the command can run headless is the
 * command's concern).
 *
 * Host-routed (renderer + CLI) because the registry and command handlers are
 * TS the pure `.mjs` sidecar can't import. Opt-in via the
 * `selfInvokeTools.slashCommand` setting.
 */

export const SLASH_COMMAND_TOOL_NAME = "SlashCommand"

/** Synthetic plugin id tagging the promoted SlashCommand manifest entry. */
export const SLASH_BUILTIN_PLUGIN_ID = "cognia-slash-builtin"

export interface SlashBuiltinManifestEntry {
  name: string
  description: string
  jsonSchema: Record<string, unknown>
  pluginId: string
}

const SLASH_SCHEMA = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description:
        "The full slash command line to run, e.g. `/status` or `/deploy staging`. The leading slash is optional.",
    },
  },
  required: ["command"],
} as const

/** A listable command, narrowed to what the manifest description needs. */
export interface SlashCommandSummary {
  name: string
  description?: string
}

/**
 * Manifest entry for the SlashCommand tool. When command summaries are
 * supplied, they're embedded in the description so the model can discover what
 * exists; otherwise a generic description is used.
 */
export function buildSlashCommandManifestEntries(
  commands: SlashCommandSummary[] = []
): SlashBuiltinManifestEntry[] {
  const list = commands
    .slice(0, 60)
    .map((c) => `- /${c.name}${c.description ? `: ${c.description}` : ""}`)
    .join("\n")
  const description =
    "Run a registered slash command. Plugin commands and commands with a real handler execute fully; " +
    "the app's built-in UI commands return guidance to run them from the chat composer." +
    (list ? `\nAvailable commands:\n${list}` : "")
  return [
    {
      name: SLASH_COMMAND_TOOL_NAME,
      description,
      jsonSchema: SLASH_SCHEMA as unknown as Record<string, unknown>,
      pluginId: SLASH_BUILTIN_PLUGIN_ID,
    },
  ]
}

/** Is this tool name the promoted SlashCommand built-in? */
export function isSlashCommandBuiltinTool(name: string): boolean {
  return name === SLASH_COMMAND_TOOL_NAME
}

export interface SlashToolRunDeps {
  /** Dispatch a command line through the registry. Returns its result, or null. */
  dispatch?: (
    line: string,
    ctx: { sessionId?: string }
  ) => Promise<{ message?: string; payload?: Record<string, unknown> } | null>
}

/**
 * Execute the SlashCommand tool host-side: normalise the command line and
 * dispatch it through the registry, returning the command's message/payload as
 * text. Returns an error string when the command is unknown or dispatch fails.
 */
export async function runSlashCommandBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  deps: SlashToolRunDeps,
  ctx: { sessionId?: string } = {}
): Promise<unknown> {
  if (name !== SLASH_COMMAND_TOOL_NAME) return `Error: unknown slash tool: ${name}`
  const raw = String(args?.command ?? "").trim()
  if (!raw) return "Error: the SlashCommand tool requires a `command`."
  const line = raw.startsWith("/") ? raw : `/${raw}`
  if (!deps.dispatch) return "Error: slash commands are not available in this environment."

  const result = await deps.dispatch(line, ctx)
  if (result === null) {
    return `Error: unknown slash command: ${line.split(/\s+/)[0]}`
  }
  if (result.message && result.payload) {
    return `${result.message}\n\n${JSON.stringify(result.payload, null, 2)}`
  }
  if (result.message) return result.message
  if (result.payload) return JSON.stringify(result.payload, null, 2)
  return `Command ${line.split(/\s+/)[0]} ran (no output).`
}
