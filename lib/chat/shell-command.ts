/**
 * Whether a tool call runs a shell command, and which one: the one reading
 * shared by the approval card and the shared-run projection (ADR-0241), so a
 * runtime's shell tool is recognised the same way everywhere it is shown.
 *
 * The policy engine keeps its own list of registered shell tool ids
 * (`lib/policy/risk/outbound-tools.ts`): that list gates what runs, this one
 * only reads what a call says it runs.
 */

/**
 * Tool names that run a shell command, across the runtimes that reach this
 * surface (Claude `Bash`, Kimi Code `Bash`, Gemini `run_shell_command`, Codex
 * `exec_command`/`shell`, Cursor `run_terminal_cmd`, …). Lower-cased.
 */
export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "shell",
  "local_shell",
  "run_shell_command",
  "exec_command",
  "execute",
  "terminal",
  "run_command",
  "run_terminal_cmd",
])

/**
 * Argument keys a shell call carries besides the command. A tool whose name
 * is not recognised still renders as a command when its arguments are only
 * these — an ACP agent titles the call however it likes ("Running: echo hi").
 */
const SHELL_ARG_KEYS = new Set([
  "command",
  "cmd",
  "description",
  "cwd",
  "workdir",
  "timeout",
  "timeout_ms",
  "run_in_background",
  "is_background",
])

/** POSIX-quote one argv element only when it needs it, so `echo hi` stays readable. */
function quoteArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

/**
 * The command a shell-like call runs, or `undefined` when this is not one.
 * Accepts a string (`command`/`cmd`) or an argv array (Codex `["bash","-lc",…]`).
 */
export function shellCommandOf(
  toolName: string,
  input: Record<string, unknown>
): string | undefined {
  const raw = input.command ?? input.cmd
  const command =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw) && raw.length > 0 && raw.every((part) => typeof part === "string")
        ? (raw as string[]).map(quoteArg).join(" ")
        : undefined
  if (!command || !command.trim()) return undefined
  const named = SHELL_TOOL_NAMES.has(toolName.toLowerCase())
  const shaped = Object.keys(input).every((key) => SHELL_ARG_KEYS.has(key))
  return named || shaped ? command : undefined
}
