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
import {
  clearToolApprovals,
  readToolApprovalEntries,
  removeToolApproval,
  type ToolApprovalEntry,
} from "../../agent/tool-approvals"
import type { ResolvedConfig } from "../../config/schema"
import type { TuiAction } from "../state/types"

/** Strip the gate's `mcp__cognia-tools__` namespace for a readable list. */
function bare(name: string): string {
  return name.replace(/^mcp__cognia-tools__/, "")
}

/** A human suffix describing an approval's scope / expiry, e.g. " (in /proj, expired)". */
function scopeSuffix(entry: ToolApprovalEntry, now: number): string {
  const parts: string[] = []
  if (entry.cwd) parts.push(`in ${entry.cwd}`)
  if (typeof entry.expiresAt === "number") {
    parts.push(
      entry.expiresAt <= now ? "expired" : `expires ${new Date(entry.expiresAt).toISOString()}`
    )
  }
  return parts.length ? ` (${parts.join(", ")})` : ""
}

export function buildPermissionsReport(
  mode: string,
  autoApprovedCount: number,
  entries: ToolApprovalEntry[],
  now = Date.now()
): string {
  const lines = [
    `Permission mode: ${mode}`,
    `Auto-approved (read-only) tools: ${autoApprovedCount}`,
  ]
  if (entries.length === 0) {
    lines.push("Always-allowed: none — risky tools still prompt.")
  } else {
    lines.push(`Always-allowed (${entries.length}):`)
    const sorted = [...entries].sort((a, b) => bare(a.tool).localeCompare(bare(b.tool)))
    for (const e of sorted) lines.push(`  • ${bare(e.tool)}${scopeSuffix(e, now)}`)
    lines.push("Remove one with /permissions remove <tool>, or all with /permissions clear.")
  }
  return lines.join("\n")
}

export interface PermissionsDeps {
  dispatch: (action: TuiAction) => void
  config: ResolvedConfig
  home: string
  readEntries?: (home: string) => ToolApprovalEntry[]
  clearApprovals?: (home: string) => number
  removeApproval?: (home: string, tool: string) => boolean
}

export function permissionsList(deps: PermissionsDeps): void {
  const entries = (deps.readEntries ?? readToolApprovalEntries)(deps.home)
  deps.dispatch({
    type: "NOTICE",
    message: buildPermissionsReport(
      deps.config.permissionMode,
      CLI_AUTO_APPROVED_TOOLS.length,
      entries
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

/** Forget a single always-allowed tool. Accepts the bare or namespaced name. */
export function permissionsRemove(deps: PermissionsDeps, toolName: string): void {
  const trimmed = toolName.trim()
  if (!trimmed) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /permissions remove <tool>" })
    return
  }
  const namespaced = trimmed.startsWith("mcp__") ? trimmed : `mcp__cognia-tools__${trimmed}`
  const removed = (deps.removeApproval ?? removeToolApproval)(deps.home, namespaced)
  deps.dispatch({
    type: "NOTICE",
    message: removed
      ? `Removed always-allow for ${bare(namespaced)} — it will prompt again next turn.`
      : `No always-allow entry for ${bare(namespaced)}.`,
  })
}
