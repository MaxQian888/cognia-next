/**
 * Shared MCP probe cache for the interactive TUI.
 *
 * Without it, every `/mcp` panel open (and every "back" from the tools panel,
 * every remove, every startup auth check) re-probed EVERY enabled server with a
 * fresh connect + close — spawning stdio child processes and re-handshaking
 * remote endpoints on each open. That is the "opening /mcp triggers a reload"
 * symptom.
 *
 * A single cache instance is created once at App startup and threaded through
 * `mcpPanelDeps()`, so:
 *   - the startup warm probes all enabled servers ONCE and seeds this cache;
 *   - re-opening `/mcp` renders instantly from the cache (no re-probe);
 *   - the per-tool panel reuses the tools captured by the panel probe;
 *   - only an explicit reconnect (`r`) or an enable/add re-probes a server.
 *
 * It is deliberately a plain injected object (not a module global) so unit
 * tests get an isolated cache and there is zero cross-test bleed.
 */
import type { McpPromptInfo, McpResourceInfo, McpServerStatus } from "../../mcp/probe-mcp-server"
import type { McpToolInfo } from "../../mcp/probe-mcp-tools"

/** One server's last-known probe result. */
export interface McpProbeCacheEntry {
  status: McpServerStatus
  /** Tools advertised by the last successful probe (empty on failure). */
  tools: McpToolInfo[]
  /** Resources/prompts, only populated by a full (non-status-only) probe. */
  resources: McpResourceInfo[]
  prompts: McpPromptInfo[]
  /** Failure detail for a `failed` / `needs_auth` entry. */
  error?: string
  /** `tools.length` — cached so the panel row can show it without the array. */
  toolCount: number
  /** Clock stamp of the probe, for optional staleness checks. */
  probedAt: number
}

export interface McpProbeCache {
  get(name: string): McpProbeCacheEntry | undefined
  set(name: string, entry: McpProbeCacheEntry): void
  /** Drop one server's entry, or the whole cache when `name` is omitted. */
  clear(name?: string): void
  has(name: string): boolean
}

/** Create an isolated probe cache. One instance is shared per App session. */
export function createMcpProbeCache(): McpProbeCache {
  const map = new Map<string, McpProbeCacheEntry>()
  return {
    get: (name) => map.get(name),
    set: (name, entry) => {
      map.set(name, entry)
    },
    clear: (name) => {
      if (name === undefined) map.clear()
      else map.delete(name)
    },
    has: (name) => map.has(name),
  }
}

/** Shape a probe result into a cache entry (shared by every probe call site). */
export function toCacheEntry(
  result: {
    status: McpServerStatus
    tools: McpToolInfo[]
    resources: McpResourceInfo[]
    prompts: McpPromptInfo[]
    error?: string
  },
  probedAt: number
): McpProbeCacheEntry {
  return {
    status: result.status,
    tools: result.tools,
    resources: result.resources,
    prompts: result.prompts,
    ...(result.error !== undefined ? { error: result.error } : {}),
    toolCount: result.tools.length,
    probedAt,
  }
}
