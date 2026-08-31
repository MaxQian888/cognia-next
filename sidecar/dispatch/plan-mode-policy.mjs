// Shared plan-mode tool policy for both dispatch rails.
//
// Plan mode means "read-only until the user approves a plan". The two rails
// reach that guarantee from opposite directions:
//
//   - ai-sdk: there is no provider-side notion of plan mode, so this policy IS
//     the enforcement for every tool.
//   - anthropic: the Claude Agent SDK enforces plan mode over its OWN native
//     tools (Read/Write/Edit/Bash/…) and we must not second-guess it — but the
//     SDK knows nothing about what `mcp__cognia-tools__*` or
//     `mcp__cognia-plugin-tools__*` do. Left ungoverned, `perform_action`,
//     `browser_evaluate`, `terminal_dock_write` and every other mutating plugin
//     tool ran inside a mode the UI labels read-only. This policy covers
//     exactly those two servers there, and defers everything else to the SDK.
//
// Keeping the allowlist in one module is the point: it previously existed as
// two hand-maintained copies (`PLAN_ALLOWED_PLUGIN_TOOLS` here and
// `PLAN_ALLOWED_HOST_TOOLS` in `cli/src/agent/tool-host/policy.ts`) that had
// already drifted by one entry.

/**
 * Host/plugin tools permitted in plan mode.
 *
 * Permitting the dispatch CALL does not widen the read-only guarantee: the
 * dispatched child inherits `permissionMode: "plan"` (its own gate stays
 * read-only) and the built-in Explore/Plan agents additionally carry a
 * read-only tool allowlist. The Skill loaders only read scoped instructions and
 * resources.
 */
export const PLAN_ALLOWED_PLUGIN_TOOLS = new Set([
  "dispatch_agent",
  "Task",
  "load_skill",
  "load_skill_resource",
])

/** Split `mcp__<server>__<tool>` into its parts; bare names pass through. */
export function splitToolName(toolName) {
  const parts = String(toolName).split("__")
  return {
    server: parts.length >= 3 ? parts[1] : null,
    bare: parts.length >= 3 ? parts.slice(2).join("__") : String(toolName),
  }
}

/**
 * Plan-mode verdict for a single tool call.
 *
 * @param {string} toolName
 * @param {{
 *   builtinServerName: string,
 *   pluginServerName: string,
 *   readOnlyBuiltins: Set<string>,
 *   extraAllowedBare?: Set<string>,
 *   governOnlyCogniaServers?: boolean,
 * }} opts
 * @returns {"allow" | "deny" | "not-governed"}
 *   `not-governed` means this policy has no opinion — the caller should fall
 *   through to its own handling (on the Anthropic rail, that is the SDK).
 */
export function classifyPlanMode(toolName, opts) {
  const {
    builtinServerName,
    pluginServerName,
    readOnlyBuiltins,
    extraAllowedBare,
    governOnlyCogniaServers = false,
  } = opts
  const { server, bare } = splitToolName(toolName)

  if (extraAllowedBare && extraAllowedBare.has(bare)) return "allow"

  if (server === builtinServerName) {
    return readOnlyBuiltins.has(bare) ? "allow" : "deny"
  }
  if (server === pluginServerName) {
    return PLAN_ALLOWED_PLUGIN_TOOLS.has(bare) ? "allow" : "deny"
  }
  // Anything else: on the Anthropic rail the SDK owns it; on the ai-sdk rail
  // nothing else owns it, so the caller denies.
  return governOnlyCogniaServers ? "not-governed" : "deny"
}
