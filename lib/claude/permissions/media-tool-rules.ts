/**
 * Baked-in consent tier for the agent's video tools (ADR-0205, G7).
 *
 * - `video_generate`: asks. Each call starts a paid provider job that runs for
 *   minutes and cannot always be stopped (Veo and xAI have no remote cancel),
 *   so the user sees the prompt before it is spent. "Allow always" in the
 *   approval (or a rule under Settings → Agent → Permissions) lifts it.
 * - `video_status`: reads a job of this conversation back. Allowed — a dialog
 *   in front of a status read is the click-through trap.
 *
 * Precedence: merged as the LOWEST layer of `opts.permissionRuleset`, so an
 * explicit rule in Settings overrides either verdict.
 */
import { MEDIA_TOOL_NAMES, VIDEO_GENERATE_TOOL_NAME } from "@/lib/claude/media-builtin-tools"
import type { PermissionVerdict, Ruleset } from "./ruleset"

/**
 * Server segment plugin-contributed tools are namespaced under on the AI-SDK
 * path, mirroring `PLUGIN_TOOLS_SERVER_NAME` in
 * `sidecar/src/policy/tool-catalog/names.ts`.
 */
const PLUGIN_TOOLS_SERVER_NAME = "cognia-plugin-tools"

function verdictFor(tool: string): PermissionVerdict {
  return tool === VIDEO_GENERATE_TOOL_NAME ? "ask" : "allow"
}

/**
 * Each tool is keyed twice, bare and `mcp__`-prefixed: the Anthropic path
 * reaches `canUseTool` with the bare name, the AI-SDK path with the namespaced
 * one, and `resolveToolVerdict` matches exactly.
 */
export function buildMediaToolRuleset(): Ruleset {
  const rules: Ruleset = {}
  for (const tool of MEDIA_TOOL_NAMES) {
    const verdict = verdictFor(tool)
    rules[tool] = verdict
    rules[`mcp__${PLUGIN_TOOLS_SERVER_NAME}__${tool}`] = verdict
  }
  return rules
}
