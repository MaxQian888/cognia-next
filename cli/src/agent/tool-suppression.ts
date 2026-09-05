/**
 * CLI tool-approval suppression + deny helpers.
 *
 * Extracted from `session-runner.ts` so both the persistent chat session and the
 * subagent runner ({@link ./subagent-runner}) can share them without an import
 * cycle (the subagent runner needs the same auto-approve / disallow merging the
 * main session uses). `session-runner.ts` re-exports these so existing
 * `import { … } from "./session-runner"` call sites stay unchanged.
 */

import type { SendOptions } from "@cognia/agent-config-types"
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
/**
 * The read-only built-in tool surface (namespaced), DERIVED from the shared risk
 * model: every tool the catalogue marks `requiresApproval: false` — reads, greps,
 * globs, `git status|log|diff`, LSP/codegraph queries, process & env listing, etc.
 * Shared by two consumers so they never drift: the auto-approve gate
 * ({@link CLI_AUTO_APPROVED_TOOLS}) and the built-in read-only subagents
 * (`Explore` / `Plan`), which pass this as their `allowedTools` whitelist so they
 * physically cannot edit, spawn processes, or mutate the tree.
 */
export const READ_ONLY_BUILTIN_TOOLS: readonly string[] = listBuiltinTools()
  .filter((t) => !t.requiresApproval)
  .map((t) => namespaced(t.name))

export const CLI_AUTO_APPROVED_TOOLS: readonly string[] = [
  ...READ_ONLY_BUILTIN_TOOLS,
  // The plan-ready signal tools never hit the generic approval prompt — the
  // plan-approval overlay drives that decision. `exit_plan_mode` is the
  // cross-provider cognia builtin (not in the metadata, so add it explicitly);
  // `ExitPlanMode` is the SDK-native Anthropic tool (belt-and-suspenders — the
  // SDK likely routes it through its own plan-approval control, not the gate).
  namespaced("exit_plan_mode"),
  "ExitPlanMode",
]

/** Merge static CLI defaults; mutable persisted grants belong to the live gate. */
export function withCliAutoApprovedTools(
  options: SendOptions,
  _extraApproved: Iterable<string> = []
): SendOptions {
  const existing = Array.isArray(options.suppressApprovalForTools)
    ? options.suppressApprovalForTools
    : []
  return {
    ...options,
    suppressApprovalForTools: [...new Set([...existing, ...CLI_AUTO_APPROVED_TOOLS])],
  }
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
