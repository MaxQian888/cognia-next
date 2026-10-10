/**
 * Baked-in consent tier for the `filespace_*` tools (ADR-0222 §9).
 *
 * - `filespace_list` — reads the calling conversation's own files and shares.
 *   Allowed.
 * - `filespace_revoke_share` / `filespace_disable_webdav` — take access away
 *   from this conversation's own shares, the safe direction. Allowed.
 * - `filespace_share` / `filespace_enable_webdav` — give someone else access.
 *   Ask. They are also `requiresApproval` and on the sidecar's per-call list
 *   (`PER_CALL_PLUGIN_TOOL_NAMES`), so no remembered "allow always", grant or
 *   permission mode turns the ask into an allow; an explicit user `allow`
 *   rule here does not either.
 *
 * Merged as the LOWEST layer of the ruleset, so an explicit user rule in
 * Settings → Agent → Permissions overrides the allows (a user may make
 * listing ask, or deny the whole family).
 */
import {
  FILESPACE_SHARING_TOOL_NAMES,
  FILESPACE_TOOL_NAMES,
} from "@/lib/claude/filespace-builtin-tools"
import type { PermissionVerdict, Ruleset } from "./ruleset"

/** Mirrors `PLUGIN_TOOLS_SERVER_NAME` (see artifact-tool-rules.ts for why both keys). */
const PLUGIN_TOOLS_SERVER_NAME = "cognia-plugin-tools"

function verdictFor(tool: string): PermissionVerdict {
  return FILESPACE_SHARING_TOOL_NAMES.has(tool) ? "ask" : "allow"
}

export function buildFilespaceToolRuleset(options: { sharing: boolean }): Ruleset {
  const rules: Ruleset = {}
  for (const tool of Object.values(FILESPACE_TOOL_NAMES)) {
    // A tier entry for a tool the turn never offers is inert payload.
    if (!options.sharing && FILESPACE_SHARING_TOOL_NAMES.has(tool)) continue
    const verdict = verdictFor(tool)
    rules[tool] = verdict
    rules[`mcp__${PLUGIN_TOOLS_SERVER_NAME}__${tool}`] = verdict
  }
  return rules
}
