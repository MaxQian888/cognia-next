/**
 * Derive a **target-scoped** allow rule from a tool-approval, so clicking
 * "Allow always" persists a precise `Bash(git *)` / `Read(/path/x)` rule into
 * `AppSettings.agentPermissions.toolRules` instead of a coarse tool-NAME grant
 * in `alwaysAllowTools`. The scoped rule is strictly narrower than the bare
 * name (it allows one command family / one path, not the whole tool) and is
 * consulted directly by the sidecar `canUseTool` gates via the serialized
 * `permissionRuleset`, so future matching calls skip the approval round-trip.
 *
 * Returns `null` when the tool carries no meaningful target — the caller then
 * falls back to the bare-name `alwaysAllowTools` grant.
 */

/** Shell tool spellings whose `command` head scopes to a `Bash` rule. */
const BASH_TOOL_NAMES = new Set(["Bash", "bash", "mcp__cognia-tools__bash"])

/** First bare token of a shell command (strips a leading path + `.exe`). */
function commandHead(command: string): string | null {
  const first = command.trim().split(/\s+/)[0]
  if (!first) return null
  // Drop any directory prefix and a Windows `.exe` suffix.
  const base = first.split(/[\\/]/).pop() ?? first
  const head = base.replace(/\.exe$/i, "")
  return head.length > 0 ? head : null
}

export interface DerivedAllowRule {
  /** Ruleset tool key (`Bash` for any shell spelling; else the exact tool). */
  tool: string
  /** Glob pattern to allow (`git *` for shell; the exact path for file tools). */
  pattern: string
}

/**
 * @param toolName The tool name as reported in the approval (namespaced or bare).
 * @param input    The tool-call input.
 * @returns A scoped allow rule, or `null` when no useful target exists.
 */
export function deriveAllowRuleFromApproval(
  toolName: string,
  input: unknown
): DerivedAllowRule | null {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {}

  // Shell tools → scope to the command family (`git *`), keyed under `Bash`
  // (the sidecar resolver honours `Bash` rules for the core `bash` tool too).
  if (BASH_TOOL_NAMES.has(toolName) && typeof obj.command === "string") {
    const head = commandHead(obj.command)
    if (head) return { tool: "Bash", pattern: `${head} *` }
    return null
  }

  // File tools → scope to the exact path the model touched.
  const target =
    typeof obj.file_path === "string" && obj.file_path
      ? obj.file_path
      : typeof obj.path === "string" && obj.path
        ? obj.path
        : null
  if (target) return { tool: toolName, pattern: target }

  return null
}
