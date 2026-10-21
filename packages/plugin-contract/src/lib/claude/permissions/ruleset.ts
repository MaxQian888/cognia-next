/**
 * The plugin contract's share of `lib/claude/permissions/ruleset.ts`, which re-exports these.
 */
export type PermissionVerdict = "allow" | "ask" | "deny"

/** Map of glob → verdict for a single tool (or the `*` wildcard tool). */
export type ToolRules = Record<string, PermissionVerdict>

/**
 * A ruleset keyed by tool name (e.g. `Edit`, `Bash`) or `*` for all
 * tools. The value is either a flat verdict for that tool, or a
 * glob→verdict map matched against the call's target (file path, command,
 * subagent name, …).
 */
export type Ruleset = Record<string, PermissionVerdict | ToolRules>
