/**
 * CLI tool-approval suppression + deny helpers.
 *
 * Extracted from `session-runner.ts` so both the persistent chat session and the
 * subagent runner ({@link ./subagent-runner}) can share them without an import
 * cycle (the subagent runner needs the same auto-approve / disallow merging the
 * main session uses). `session-runner.ts` re-exports these so existing
 * `import { … } from "./session-runner"` call sites stay unchanged.
 */

import type { SendOptions } from "@/lib/claude/types"
import { listBuiltinTools, namespaced } from "@/lib/settings/builtin-tools"

/**
 * Built-in tools the CLI auto-approves — DERIVED from the shared risk model
 * (`lib/settings/builtin-tools-data.json`): every tool marked
 * `requiresApproval: false` (riskLevel "low"). That is the full read-only /
 * inspection surface — reads, greps, globs, `git status|log|diff`, process &
 * env listing, LSP queries, `terminal_repl_read`, `TodoWrite`, file_info/hash/
 * diff/search, … — roughly 30 tools, not a hand-kept 4. Deriving from the
 * metadata is the point: a newly added read-only tool is auto-approved
 * automatically, and a tool reclassified as risky starts prompting again — no
 * drift between the gate and the catalogue. Mutating / side-effecting tools
 * (write/edit/multi_edit/bash, file_append/move/copy/rename, directory_create/
 * delete, start/terminate_process, shell_execute_advanced, terminal_repl_spawn/
 * write/kill, …) keep `requiresApproval: true` and still hit the approval gate.
 *
 * Why the CLI needs this: the desktop persists the user's "always allow" choices
 * in a store the CLI has no equivalent of, so without it every safe read tool
 * would pop a mid-stream approval that blocks the whole turn until answered.
 * The doom-loop guard still forces a prompt on a runaway identical repeat.
 * Names are the gate's namespaced form (`mcp__cognia-tools__<name>`).
 */
export const CLI_AUTO_APPROVED_TOOLS: readonly string[] = [
  ...listBuiltinTools()
    .filter((t) => !t.requiresApproval)
    .map((t) => namespaced(t.name)),
  // The plan-ready signal tools never hit the generic approval prompt — the
  // plan-approval overlay drives that decision. `exit_plan_mode` is the
  // cross-provider cognia builtin (not in the metadata, so add it explicitly);
  // `ExitPlanMode` is the SDK-native Anthropic tool (belt-and-suspenders — the
  // SDK likely routes it through its own plan-approval control, not the gate).
  namespaced("exit_plan_mode"),
  "ExitPlanMode",
]

/**
 * Merge the CLI's auto-approve set into the resolved options' approval
 * suppressions, preserving anything the resolver already set. `extraApproved`
 * carries the user's persisted "Allow always" choices so a tool approved-always
 * once never prompts again — including risky tools (bash/write) the user
 * explicitly trusted.
 */
export function withCliAutoApprovedTools(
  options: SendOptions,
  extraApproved: Iterable<string> = []
): SendOptions {
  const existing = Array.isArray(options.suppressApprovalForTools)
    ? options.suppressApprovalForTools
    : []
  const merged = [...new Set([...existing, ...CLI_AUTO_APPROVED_TOOLS, ...extraApproved])]
  return { ...options, suppressApprovalForTools: merged }
}

/**
 * Union the user's per-tool MCP disable overlay (the `/mcp` panel's tool
 * toggles) into the resolved options' `disallowedTools`, so a disabled
 * `mcp__server__tool` never reaches the model — without losing whatever the
 * resolver already disallowed. Empty overlay → options unchanged.
 */
export function withCliDisabledMcpTools(
  options: SendOptions,
  disabledTools: Iterable<string> = []
): SendOptions {
  const extra = [...disabledTools]
  if (extra.length === 0) return options
  const existing = Array.isArray(options.disallowedTools) ? options.disallowedTools : []
  return { ...options, disallowedTools: [...new Set([...existing, ...extra])] }
}
