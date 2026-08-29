/**
 * Baked-in consent tier for the agent's artifact / canvas tools.
 *
 * Treating them uniformly is wrong in both directions. Prompting for
 * `artifact_create` would put a confirmation in front of "here is the chart you
 * asked for" — the card lands on screen, beside the turn that produced it, and
 * the user can delete it in one click. Allowing `artifact_delete` would let the
 * agent silently destroy work the user has been iterating on, which no other
 * gate would catch.
 *
 * - `artifact_create` / `canvas_create` — additive and visible. Allowed.
 * - `artifact_update` / `canvas_update` — with the user's own
 *   review-before-apply setting on (the default) these stage a diff rather than
 *   overwriting, and versions are kept either way. Allowed.
 * - `artifact_read` / `canvas_read` / `canvas_open` — read or move the user's
 *   viewport. Allowed.
 * - `artifact_delete` — destroys user-visible work. Asks.
 *
 * Precedence: merged as the LOWEST layer of `opts.permissionRuleset`, so an
 * explicit rule in Settings → Agent → Permissions overrides any of it in either
 * direction.
 */
import {
  ARTIFACT_DELETE_TOOL_NAME,
  ARTIFACT_TOOL_NAMES,
  CANVAS_TOOL_NAMES,
} from "@/lib/claude/artifact-builtin-tools"
import type { PermissionVerdict, Ruleset } from "./ruleset"

/**
 * Server segment plugin-contributed tools are namespaced under on the AI-SDK
 * path (`mcp__cognia-plugin-tools__<tool>`); mirrors `PLUGIN_TOOLS_SERVER_NAME`
 * in `sidecar/dispatch/ai-sdk-tools.mjs`.
 */
const PLUGIN_TOOLS_SERVER_NAME = "cognia-plugin-tools"

function verdictFor(tool: string): PermissionVerdict {
  return tool === ARTIFACT_DELETE_TOOL_NAME ? "ask" : "allow"
}

/**
 * Each tool is keyed **twice** — bare and `mcp__`-prefixed — because the two
 * provider paths disagree on which reaches `canUseTool`: the Anthropic path
 * sees the bare name, the AI-SDK path the namespaced one, and
 * `resolveToolVerdict` matches the key exactly with no prefix stripping. Keying
 * one form applies the tier on one provider only.
 */
export function buildArtifactToolRuleset(): Ruleset {
  const rules: Ruleset = {}
  for (const tool of [...ARTIFACT_TOOL_NAMES, ...CANVAS_TOOL_NAMES]) {
    const verdict = verdictFor(tool)
    rules[tool] = verdict
    rules[`mcp__${PLUGIN_TOOLS_SERVER_NAME}__${tool}`] = verdict
  }
  return rules
}
