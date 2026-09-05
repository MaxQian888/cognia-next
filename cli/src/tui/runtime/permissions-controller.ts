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
import { describeApprovalKey } from "../../agent/command-approval"
import type { ResolvedConfig } from "../../config/schema"
import type { TuiAction } from "../state/types"

/** Strip the gate's namespace for a readable list, keeping a command scope. */
function bare(name: string): string {
  return describeApprovalKey(name)
}

/**
 * Turn what {@link bare} printed back into the key the store holds.
 *
 * Only the TOOL half is namespaced. Namespacing the whole string would produce
 * `mcp__cognia-tools__bash(pnpm build)` from the tool name alone and
 * `mcp__cognia-tools__bash(pnpm build)` never from what `/permissions list`
 * actually printed, so `/permissions remove` could not undo what the list
 * showed.
 */
function restoreApprovalKey(input: string): string {
  const open = input.indexOf("(")
  const tool = open >= 0 ? input.slice(0, open) : input
  const scope = open >= 0 ? input.slice(open) : ""
  const full = tool.startsWith("mcp__") ? tool : `mcp__cognia-tools__${tool}`
  return `${full}${scope}`
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
    // The other half of the answer, and the half people were missing: shell
    // calls are judged one command at a time, so `ls` never reaches a prompt
    // and `rm -rf` always does.
    "Shell commands: judged per command, so read-only ones run without asking.",
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
  const namespaced = restoreApprovalKey(trimmed)
  const removed = (deps.removeApproval ?? removeToolApproval)(deps.home, namespaced)
  deps.dispatch({
    type: "NOTICE",
    message: removed
      ? `Removed always-allow for ${bare(namespaced)} — it will prompt again next turn.`
      : `No always-allow entry for ${bare(namespaced)}.`,
  })
}
