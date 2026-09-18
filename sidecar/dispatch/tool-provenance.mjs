/**
 * Tool-provenance resolver for lifecycle-hook payloads — sidecar mirror of
 * `lib/claude/hooks/tool-provenance.ts`.
 *
 * `tool_provenance` tells a hook script which surface declared the tool being
 * invoked (built-in Cognia set, plugin manifest, external MCP server, or an
 * external agent's own surface) so policy can be written against a tool's
 * origin rather than only its name. The value is metadata only — never
 * arguments, secrets, or manifest bodies — and is omitted entirely when the
 * tool name is absent or unresolvable.
 *
 * Self-contained by necessity: the sidecar is not in the pnpm workspace and
 * cannot import `@/`. Keep this semantically identical to the TS resolver —
 * both are pinned by shape tests.
 */

/** Qualified-name prefix for the built-in Cognia tool server. */
const BUILTIN_TOOLS_PREFIX = "mcp__cognia-tools__"
/** Qualified-name prefix for the synthetic plugin-tools MCP server. */
const PLUGIN_TOOLS_PREFIX = "mcp__cognia-plugin-tools__"
/** Qualified-name prefix for every MCP-namespaced tool. */
const MCP_PREFIX = "mcp__"

function pluginEntry(bare, pluginTools) {
  return Array.isArray(pluginTools) ? pluginTools.find((t) => t && t.name === bare) : undefined
}

function pluginSource(entry) {
  const id = entry?.pluginId
  return typeof id === "string" && id ? id : "unknown"
}

function declaredBy(entry) {
  const path = entry?.manifestPath
  return typeof path === "string" && path ? path : undefined
}

/**
 * Resolve the provenance of a tool by its invocation name. Returns `null`
 * when the name is absent or not a non-empty string — the caller then omits
 * `tool_provenance` from the payload rather than emitting a placeholder.
 *
 * @param {unknown} toolName
 * @param {{ pluginTools?: readonly { name?: unknown, pluginId?: unknown, manifestPath?: unknown }[], externalAgentId?: string, mcpDeclaredBy?: Record<string, string> }} [opts]
 * @returns {{ kind: "builtin" | "plugin" | "mcp" | "agent", source: string, declared_by?: string } | null}
 */
export function resolveToolProvenance(toolName, opts) {
  if (typeof toolName !== "string" || !toolName) return null

  if (toolName.startsWith(PLUGIN_TOOLS_PREFIX)) {
    const bare = toolName.slice(PLUGIN_TOOLS_PREFIX.length)
    if (bare) {
      const entry = pluginEntry(bare, opts?.pluginTools)
      return {
        kind: "plugin",
        source: pluginSource(entry),
        ...(declaredBy(entry) ? { declared_by: declaredBy(entry) } : {}),
      }
    }
  }

  if (toolName.startsWith(BUILTIN_TOOLS_PREFIX)) {
    const bare = toolName.slice(BUILTIN_TOOLS_PREFIX.length)
    if (bare) return { kind: "builtin", source: "cognia", declared_by: "builtin-tools-data.json" }
  }

  // Other MCP servers: `mcp__<server>__<tool>`, split on the first `__` after
  // the prefix — tool names may themselves contain `__`.
  if (toolName.startsWith(MCP_PREFIX)) {
    const rest = toolName.slice(MCP_PREFIX.length)
    const sep = rest.indexOf("__")
    if (sep > 0 && sep + 2 < rest.length) {
      const server = rest.slice(0, sep)
      const declared = opts?.mcpDeclaredBy?.[server]
      return {
        kind: "mcp",
        source: server,
        ...(declared ? { declared_by: declared } : {}),
      }
    }
    // `mcp__x` with no tool segment is not a real MCP name — fall through and
    // treat it like any other bare name.
  }

  // Bare name. On an external agent's own surface it belongs to that agent;
  // on the built-in agent it belongs to Cognia's tool set.
  if (opts?.externalAgentId) {
    return { kind: "agent", source: opts.externalAgentId }
  }
  return { kind: "builtin", source: "cognia", declared_by: "builtin-tools-data.json" }
}
