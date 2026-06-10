/**
 * `/permissions` controller — view and clear the CLI's tool-approval surface.
 *
 * The CLI auto-approves the read-only built-in tools (`CLI_AUTO_APPROVED_TOOLS`,
 * derived from the shared risk model) and remembers each "Allow always" choice
 * in `tool-approvals.json` (`readToolApprovals`). Until now those persisted
 * choices were write-only — there was no way to see or forget them. This
 * controller lists the active permission mode + the always-allowed tools, and
 * `clear` forgets them (the App then re-resolves options so they prompt again).
 */
import { CLI_AUTO_APPROVED_TOOLS } from "../../agent/session-runner"
import { clearToolApprovals, readToolApprovals } from "../../agent/tool-approvals"
import type { ResolvedConfig } from "../../config/schema"
import type { TuiAction } from "../state/types"

/** Strip the gate's `mcp__cognia-tools__` namespace for a readable list. */
function bare(name: string): string {
  return name.replace(/^mcp__cognia-tools__/, "")
}

export function buildPermissionsReport(
  mode: string,
  autoApprovedCount: number,
  alwaysAllowed: string[]
): string {
  const lines = [
    `Permission mode: ${mode}`,
    `Auto-approved (read-only) tools: ${autoApprovedCount}`,
  ]
  if (alwaysAllowed.length === 0) {
    lines.push("Always-allowed: none — risky tools still prompt.")
  } else {
    lines.push(`Always-allowed (${alwaysAllowed.length}):`)
    for (const name of alwaysAllowed.map(bare).sort()) lines.push(`  • ${name}`)
    lines.push("Clear them with /permissions clear.")
  }
  return lines.join("\n")
}

export interface PermissionsDeps {
  dispatch: (action: TuiAction) => void
  config: ResolvedConfig
  home: string
  readApprovals?: (home: string) => Set<string>
  clearApprovals?: (home: string) => number
}

export function permissionsList(deps: PermissionsDeps): void {
  const allowed = [...(deps.readApprovals ?? readToolApprovals)(deps.home)]
  deps.dispatch({
    type: "NOTICE",
    message: buildPermissionsReport(
      deps.config.permissionMode,
      CLI_AUTO_APPROVED_TOOLS.length,
      allowed
    ),
  })
}

export function permissionsClear(deps: PermissionsDeps): void {
  const n = (deps.clearApprovals ?? clearToolApprovals)(deps.home)
  deps.dispatch({
    type: "NOTICE",
    message:
      n === 0
        ? "No always-allowed tools to clear."
        : `Cleared ${n} always-allowed ${n === 1 ? "tool" : "tools"} — they will prompt again next turn.`,
  })
}
