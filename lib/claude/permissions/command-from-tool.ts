/**
 * Map a tool call (name + input) to the shell command string it would run, so
 * the Auto-mode orchestrator can classify it. Covers the agent's
 * command-execution surface: the SDK `Bash` tool plus the sidecar built-ins
 * `shell_execute_advanced` and `start_process`. Anything else returns `null`
 * (Auto-mode leaves non-shell tools to the normal approval flow).
 *
 * Pure: no I/O. Defensive about the loosely-typed `input` payload coming off
 * the wire.
 */

const COMMAND_TOOLS = new Set(["Bash", "shell_execute_advanced", "start_process"])

export function isCommandTool(toolName: string): boolean {
  return COMMAND_TOOLS.has(toolName)
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function asArgs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((a): a is string => typeof a === "string") : []
}

/**
 * Extract the full command line for a tool call, or `null` when the tool is
 * not a shell tool / the payload has no usable command.
 */
export function extractCommand(toolName: string, input: unknown): string | null {
  if (!isCommandTool(toolName)) return null
  const obj = (input ?? {}) as Record<string, unknown>

  if (toolName === "Bash") {
    const cmd = obj.command
    return typeof cmd === "string" && cmd.trim() ? cmd : null
  }
  if (toolName === "shell_execute_advanced") {
    const head = asString(obj.command)
    if (!head.trim()) return null
    return [head, ...asArgs(obj.args)].join(" ").trim()
  }
  // start_process
  const program = asString(obj.program)
  if (!program.trim()) return null
  return [program, ...asArgs(obj.args)].join(" ").trim()
}
