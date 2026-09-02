/**
 * Baked-in consent tier for the agent's template / chat-template / squad tools.
 *
 * - `template_list` / `template_get` / `chat_template_list` /
 *   `chat_template_get` / `squad_list` read the user's own catalog, library
 *   and squads. Allowed.
 * - `template_instantiate` / `squad_apply_template` /
 *   `squad_save_as_template` create a resource or a library row. Allowed HERE,
 *   because each one asks the plugin consent broker before it writes, under
 *   the same `templates:instantiate` / `templates:library:write` prompt
 *   `ctx.templates` and `ctx.team.saveAsTemplate` answer to. An `ask` verdict
 *   on top would put two confirmations in front of one write, and the second
 *   one (the tool-permission dialog) knows nothing about which template it is
 *   approving. The consent overlay is the gate that does.
 *
 * Precedence: merged as the LOWEST layer of `opts.permissionRuleset`, so an
 * explicit rule in Settings > Agent > Permissions overrides any of it in
 * either direction, including turning a write tool into `ask` or `deny`.
 */
import { TEMPLATE_TOOL_NAMES } from "@/lib/claude/template-builtin-tools"
import type { PermissionVerdict, Ruleset } from "./ruleset"

/**
 * Server segment plugin-contributed tools are namespaced under on the AI-SDK
 * path (`mcp__cognia-plugin-tools__<tool>`). Mirrors `PLUGIN_TOOLS_SERVER_NAME`
 * in `sidecar/dispatch/ai-sdk-tools.mjs`.
 */
const PLUGIN_TOOLS_SERVER_NAME = "cognia-plugin-tools"

function verdictFor(): PermissionVerdict {
  return "allow"
}

/**
 * Each tool is keyed **twice**, bare and `mcp__`-prefixed, because the two
 * provider paths disagree on which reaches `canUseTool`: the Anthropic path
 * sees the bare name, the AI-SDK path the namespaced one, and
 * `resolveToolVerdict` matches the key exactly with no prefix stripping.
 * Keying one form applies the tier on one provider only.
 */
export function buildTemplateToolRuleset(): Ruleset {
  const rules: Ruleset = {}
  for (const tool of TEMPLATE_TOOL_NAMES) {
    const verdict = verdictFor()
    rules[tool] = verdict
    rules[`mcp__${PLUGIN_TOOLS_SERVER_NAME}__${tool}`] = verdict
  }
  return rules
}
