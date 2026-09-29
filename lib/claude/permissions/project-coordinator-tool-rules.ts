/**
 * Baked-in consent tier for the project-coordinator tools (ADR-0204).
 *
 * Coordination is something the user switched on for the workspace, and every
 * effect of these tools is bounded elsewhere: a thread's own tool calls go
 * through that thread's permissions, creation is capped per day and pausable,
 * and a thread is an ordinary conversation the user can open, stop or delete.
 * Prompting for each `spawn_thread` would make the coordinator unusable while
 * adding no protection those bounds do not already give.
 *
 * - list / read / propose / report — read or visible-only. Allowed.
 * - spawn / start / message / stop / resolve / remember — the coordinator's
 *   job, bounded as above. Allowed.
 * - `set_project_preference` — changes the limits themselves. Asks.
 *
 * Merged as the LOWEST layer of the ruleset, so an explicit user rule in
 * Settings → Agent → Permissions overrides it either way.
 */
import {
  PROJECT_COORDINATOR_TOOL_NAMES,
  PROJECT_THREAD_TOOL_NAMES,
} from "@/lib/claude/project-coordinator-builtin-tools"
import type { PermissionVerdict, Ruleset } from "./ruleset"

/** Mirrors `PLUGIN_TOOLS_SERVER_NAME` (see artifact-tool-rules.ts for why both keys). */
const PLUGIN_TOOLS_SERVER_NAME = "cognia-plugin-tools"

function verdictFor(tool: string): PermissionVerdict {
  return tool === PROJECT_COORDINATOR_TOOL_NAMES.setProjectPreference ? "ask" : "allow"
}

export function buildProjectCoordinatorToolRuleset(): Ruleset {
  const rules: Ruleset = {}
  for (const tool of [
    ...Object.values(PROJECT_COORDINATOR_TOOL_NAMES),
    ...Object.values(PROJECT_THREAD_TOOL_NAMES),
  ]) {
    const verdict = verdictFor(tool)
    rules[tool] = verdict
    rules[`mcp__${PLUGIN_TOOLS_SERVER_NAME}__${tool}`] = verdict
  }
  return rules
}
