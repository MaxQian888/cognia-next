/**
 * Derive a **target-scoped** allow rule from a tool-approval, so clicking
 * "Allow always" persists a precise `Bash(git status)` / `Read(/path/x)` rule
 * into `AppSettings.agentPermissions.toolRules` instead of a coarse tool-NAME
 * grant in `alwaysAllowTools`. The rule is consulted directly by the sidecar
 * `canUseTool` gates via the serialized `permissionRuleset`, so a future
 * identical call skips the approval round-trip.
 *
 * **The grant is the action the user actually saw**, not its family. This used
 * to derive `Bash(git *)` from the command's head, which meant approving
 * `git status` also, and permanently, approved `git push --force`,
 * `git reset --hard` and `git clean -fdx`. One click on a read-only command
 * bought write access to the user's history. A family grant is still available
 * — it is just no longer something a user can arrive at by accident: they
 * author it deliberately in Settings → Agent → Permissions.
 *
 * One caveat with teeth: the ruleset's glob matcher has no escape syntax, so
 * `*` and `?` inside an approved command stay wildcards (`ls *.ts` grants
 * `ls <anything>.ts` within one path segment). Still far narrower than the
 * whole command family, but not literally exact — see `globToRegExp` in
 * `ruleset.ts`.
 *
 * Returns `null` when the tool carries no meaningful target — the caller then
 * falls back to the bare-name `alwaysAllowTools` grant.
 */

/** Shell tool spellings whose `command` scopes to a `Bash` rule. */
const BASH_TOOL_NAMES = new Set(["Bash", "bash", "mcp__cognia-tools__bash"])

export interface DerivedAllowRule {
  /** Ruleset tool key (`Bash` for any shell spelling; else the exact tool). */
  tool: string
  /** Pattern to allow: the approved command for shell; the exact path otherwise. */
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

  // Shell tools → scope to the command the user approved, keyed under `Bash`
  // (the sidecar resolver honours `Bash` rules for the core `bash` tool too).
  // Whitespace is collapsed so a re-run that differs only in spacing still
  // matches; nothing else is normalised, because every normalisation here is
  // a way for the grant to cover something the user did not read.
  if (BASH_TOOL_NAMES.has(toolName) && typeof obj.command === "string") {
    const command = obj.command.trim().replace(/\s+/g, " ")
    if (command) return { tool: "Bash", pattern: command }
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
