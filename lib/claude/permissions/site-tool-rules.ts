/**
 * Baked-in consent tier for the Cognia Sites agent tools (ADR-0084).
 *
 * The three are not equally consequential, and treating them uniformly is wrong
 * in both directions.
 *
 * - `list_sites` — a read of rows the user owns. Allowed.
 * - `build_site` — produces an **immutable local version** and publishes
 *   nothing. The console's own gate for this is `edit`, not `deploy`. Gating it
 *   would turn "prepare a release" into a click-through and train the user to
 *   approve everything, which is precisely how the `deploy_site` prompt would
 *   lose its meaning. Allowed.
 * - `deploy_site` — puts a URL other people can load in front of the world,
 *   with no undo: `takeDown` removes the Site, it does not restore the previous
 *   version. Asks, always.
 *
 * Precedence: merged as the LOWEST layer of `opts.permissionRuleset`, so an
 * explicit user or character rule in Settings → Agent → Permissions overrides
 * any of it, in either direction.
 */
import { DEPLOY_SITE_TOOL_NAME, SITES_TOOL_NAMES } from "@/lib/claude/sites-builtin-tools"
import type { PermissionVerdict, Ruleset } from "./ruleset"

/**
 * Server segment plugin-contributed tools are namespaced under on the AI-SDK
 * path; mirrors `PLUGIN_TOOLS_SERVER_NAME` in `sidecar/dispatch/ai-sdk-tools.mjs`.
 */
const PLUGIN_TOOLS_SERVER_NAME = "cognia-plugin-tools"

function verdictFor(tool: string): PermissionVerdict {
  return tool === DEPLOY_SITE_TOOL_NAME ? "ask" : "allow"
}

/**
 * Each tool is keyed **twice** — bare and `mcp__`-prefixed — because the two
 * provider paths disagree on which reaches `canUseTool`: the Anthropic path
 * sees the bare name, the AI-SDK path the namespaced one, and
 * `resolveToolVerdict` matches the key exactly with no prefix stripping. Keying
 * one form would apply the tier on one provider only.
 */
export function buildSiteToolRuleset(): Ruleset {
  const rules: Ruleset = {}
  for (const tool of SITES_TOOL_NAMES) {
    const verdict = verdictFor(tool)
    rules[tool] = verdict
    rules[`mcp__${PLUGIN_TOOLS_SERVER_NAME}__${tool}`] = verdict
  }
  return rules
}
