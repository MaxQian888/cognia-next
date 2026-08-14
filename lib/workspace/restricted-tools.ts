/**
 * Tools denied while the active workspace is in Restricted Mode (any root
 * untrusted). Everything that can mutate disk or drive the host. Read-only
 * tools (Read/Glob/Grep/WebFetch/WebSearch/TodoWrite) are intentionally omitted
 * so an untrusted workspace can still be inspected.
 *
 * DERIVED, NOT HAND-LISTED. The previous version enumerated five logical tools
 * by hand and therefore missed 23 mutators — `directory_delete`,
 * `shell_execute_advanced`, `terminal_repl_spawn`, `apply_patch`, `Monitor`,
 * every `file-ops` writer, and more — all of which stayed reachable from an
 * untrusted workspace and from an inbound IM message. The list is now computed
 * from the same `requiresApproval` metadata that drives the approval gate, so a
 * newly added mutator is covered automatically.
 */

import { listBuiltinTools, namespaced } from "@/lib/settings/builtin-tools"

/**
 * Claude Agent SDK native mutators. These are the SDK's own tools, not entries
 * in `builtin-tools-data.json`, so they cannot be derived and must be listed.
 */
const SDK_NATIVE_MUTATING_TOOLS = ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"] as const

/**
 * Every approval-gated built-in, in both spellings: the bare name (how the
 * ai-sdk bridge registers it) and the `mcp__cognia-tools__` form (the Anthropic
 * escape-hatch registration).
 */
function derivedMutatingBuiltins(): string[] {
  const bare = listBuiltinTools()
    .filter((t) => t.requiresApproval)
    .map((t) => t.name)
  return [...bare, ...bare.map(namespaced)]
}

/** Tools denied in Restricted Mode. Computed once at module load. */
export const RESTRICTED_MODE_DENIED_TOOLS: readonly string[] = Object.freeze([
  ...SDK_NATIVE_MUTATING_TOOLS,
  ...derivedMutatingBuiltins(),
])

/**
 * Computer-Use surfaces (screenshot / mouse / keyboard / shell / file edits)
 * ship as plugin tools under this prefix — all side-effecting.
 */
const COMPUTER_USE_PREFIX = "mcp__cognia-plugin-tools__"

/** Set form for O(1) membership — the derived list is ~60 entries. */
const DENIED_SET = new Set<string>(RESTRICTED_MODE_DENIED_TOOLS)

/** True when `tool` must be denied in Restricted Mode. */
export function isRestrictedTool(tool: string): boolean {
  return DENIED_SET.has(tool) || tool.startsWith(COMPUTER_USE_PREFIX)
}
