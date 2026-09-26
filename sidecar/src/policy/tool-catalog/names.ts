// Tool and MCP server names both dispatch rails key on. The built-in server's
// own name is catalog data (./catalog.ts).

/** The synthetic MCP server that carries plugin-contributed tools. */
export const PLUGIN_TOOLS_SERVER_NAME = "cognia-plugin-tools"

/**
 * The `ask_user` elicitation tool (a plugin tool, namespaced
 * `mcp__cognia-plugin-tools__ask_user`). It only pauses to ask the user a
 * question — no file/exec side effects — so it is permitted in plan mode for
 * parity with the Anthropic SDK, letting the agent clarify before it plans.
 */
export const ASK_USER_TOOL_NAME = "ask_user"

/** The built-in tool the model calls to leave plan mode. */
export const EXIT_PLAN_TOOL_NAME = "exit_plan_mode"

/** `mcp__<server>__<tool>` for one bare tool name. */
export function qualifiedToolName(serverName: string, bareName: string): string {
  return `mcp__${serverName}__${bareName}`
}

/** Split `mcp__<server>__<tool>` into its parts; bare names pass through. */
export function splitToolName(toolName: unknown): { server: string | null; bare: string } {
  const parts = String(toolName).split("__")
  return {
    server: parts.length >= 3 ? (parts[1] ?? null) : null,
    bare: parts.length >= 3 ? parts.slice(2).join("__") : String(toolName),
  }
}
