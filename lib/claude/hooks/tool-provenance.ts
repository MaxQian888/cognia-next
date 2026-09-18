/**
 * Tool-provenance resolver for lifecycle-hook payloads.
 *
 * `tool_provenance` tells a hook script which surface declared the tool being
 * invoked — Cognia's built-in set, a plugin manifest, an external MCP server,
 * or an external agent's own surface — so policy can be written against the
 * tool's origin ("deny every tool from MCP server X") rather than only its
 * name. The value is metadata only: never arguments, secrets, or manifest
 * bodies. It is omitted entirely when the tool name is absent or
 * unresolvable, so hook scripts must tolerate its absence.
 *
 * The sidecar mirrors this module in `sidecar/dispatch/tool-provenance.mjs`
 * (the sidecar is not in the pnpm workspace and cannot import `@/`). Keep the
 * two resolvers semantically identical — both are pinned by shape tests.
 */

/** Qualified-name prefix for the built-in Cognia tool server. */
const BUILTIN_TOOLS_PREFIX = "mcp__cognia-tools__"
/** Qualified-name prefix for the synthetic plugin-tools MCP server. */
const PLUGIN_TOOLS_PREFIX = "mcp__cognia-plugin-tools__"
/** Qualified-name prefix for every MCP-namespaced tool. */
const MCP_PREFIX = "mcp__"

export type ToolProvenanceKind = "builtin" | "plugin" | "mcp" | "agent"

export interface ToolProvenance {
  /** Which class of surface declared the tool. */
  kind: ToolProvenanceKind
  /**
   * The declaring surface's identity: `"cognia"` for built-in tools, the MCP
   * server name for `mcp`, the plugin id for `plugin`, the external agent id
   * for `agent`. `"unknown"` when a plugin tool's manifest entry is missing.
   */
  source: string
  /**
   * The artifact that declares the tool: `"builtin-tools-data.json"` for the
   * built-in set, the plugin's `plugin.json` path for plugin tools, the MCP
   * config file / `"settings"` / `"plugin:<id>"` locator for MCP servers.
   * Absent when the declaring artifact can't be named — an external agent's
   * own surface declares its tools in config Cognia never sees, so `agent`
   * provenance carries no `declared_by`. Hooks must tolerate it missing.
   */
  declared_by?: string
}

/** Minimal shape of a plugin-tools manifest entry needed for id resolution. */
export interface ToolProvenanceManifestEntry {
  name?: unknown
  pluginId?: unknown
  /** Absolute path of the manifest that declared the tool, when known. */
  manifestPath?: unknown
}

export interface ResolveToolProvenanceOpts {
  /**
   * Plugin-tools manifest entries for the session (`sendOptions.pluginTools`).
   * Used to map `mcp__cognia-plugin-tools__<name>` back to its `pluginId`.
   */
  pluginTools?: readonly ToolProvenanceManifestEntry[]
  /**
   * When set, bare (non-namespaced) tool names are attributed to this
   * external agent's own surface instead of Cognia's built-in set. Only the
   * external-agent bridge passes this; the sidecar path always serves the
   * built-in surface.
   */
  externalAgentId?: string
  /**
   * Per-server `declared_by` locators for `mcp` provenance, keyed by the same
   * server name the `mcpServers` wire map uses (`sendOptions.mcpDeclaredBy`).
   * A server absent from the map simply omits `declared_by`.
   */
  mcpDeclaredBy?: Record<string, string>
}

function pluginEntry(
  bare: string,
  pluginTools: readonly ToolProvenanceManifestEntry[] | undefined
): ToolProvenanceManifestEntry | undefined {
  return Array.isArray(pluginTools) ? pluginTools.find((t) => t && t.name === bare) : undefined
}

function pluginSource(entry: ToolProvenanceManifestEntry | undefined): string {
  const id = entry?.pluginId
  return typeof id === "string" && id ? id : "unknown"
}

function declaredBy(entry: ToolProvenanceManifestEntry | undefined): string | undefined {
  const path = entry?.manifestPath
  return typeof path === "string" && path ? path : undefined
}

/**
 * Resolve the provenance of a tool by its invocation name. Returns `null`
 * when the name is absent or not a non-empty string — the caller then omits
 * `tool_provenance` from the payload rather than emitting a placeholder.
 */
export function resolveToolProvenance(
  toolName: unknown,
  opts?: ResolveToolProvenanceOpts
): ToolProvenance | null {
  if (typeof toolName !== "string" || !toolName) return null

  const pluginBare = toolName.startsWith(PLUGIN_TOOLS_PREFIX)
    ? toolName.slice(PLUGIN_TOOLS_PREFIX.length)
    : null
  if (pluginBare !== null && pluginBare) {
    const entry = pluginEntry(pluginBare, opts?.pluginTools)
    return {
      kind: "plugin",
      source: pluginSource(entry),
      ...(declaredBy(entry) ? { declared_by: declaredBy(entry) } : {}),
    }
  }

  const builtinBare = toolName.startsWith(BUILTIN_TOOLS_PREFIX)
    ? toolName.slice(BUILTIN_TOOLS_PREFIX.length)
    : null
  if (builtinBare !== null && builtinBare) {
    return { kind: "builtin", source: "cognia", declared_by: "builtin-tools-data.json" }
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
