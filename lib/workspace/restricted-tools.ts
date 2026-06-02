/**
 * Tools denied while the active workspace is in Restricted Mode (any root
 * untrusted). Everything that can mutate disk or drive the host. Read-only
 * tools (Read/Glob/Grep/WebFetch/WebSearch/TodoWrite) are intentionally omitted
 * so an untrusted workspace can still be inspected.
 */
export const RESTRICTED_MODE_DENIED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
] as const

/**
 * Computer-Use surfaces (screenshot / mouse / keyboard / shell / file edits)
 * ship as plugin tools under this prefix — all side-effecting.
 */
const COMPUTER_USE_PREFIX = "mcp__cognia-plugin-tools__"

/** True when `tool` must be denied in Restricted Mode. */
export function isRestrictedTool(tool: string): boolean {
  return (
    (RESTRICTED_MODE_DENIED_TOOLS as readonly string[]).includes(tool) ||
    tool.startsWith(COMPUTER_USE_PREFIX)
  )
}
