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
 *   - re-opening `/mcp` reuses fresh results for the same configuration;
 *   - the per-tool panel reuses the tools captured by the panel probe;
 *   - reconnect, changed configuration, and expiry trigger a new probe.
 *
 * It is deliberately a plain injected object (not a module global) so unit
 * tests get an isolated cache and there is zero cross-test bleed.
 */
import { createHash } from "node:crypto"
import type { McpServer } from "@cognia/agent-config-types"

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
  get(name: string, server?: McpServer): McpProbeCacheEntry | undefined
  set(name: string, entry: McpProbeCacheEntry, server?: McpServer): void
  /** Drop one server's entry, or the whole cache when `name` is omitted. */
  clear(name?: string): void
  has(name: string, server?: McpServer): boolean
}

/** Stable encoding preserves ordered arguments while normalizing object key order. */
function canonicalConfig(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonicalConfig))
  if (value && typeof value === "object") {
    return JSON.stringify(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalConfig(item)])
    )
  }
  return JSON.stringify(value) ?? "null"
}

function probeFingerprint(server: McpServer): string {
  // The review fingerprint intentionally masks SecretRefs. Probe reuse must
  // notice a reference change too; retain only a digest, never raw credentials.
  return createHash("sha256")
    .update(
      canonicalConfig({
        id: server.id,
        transport: server.transport,
        config: server.config,
        enabled: server.enabled,
        revision: server.revision,
        credentialVersion: server.credentialVersion,
      })
    )
    .digest("hex")
}

/** Create an isolated probe cache. One instance is shared per App session. */
export function createMcpProbeCache(
  opts: { now?: () => number; ttlMs?: number } = {}
): McpProbeCache {
  const now = opts.now ?? Date.now
  const ttlMs = opts.ttlMs ?? 60_000
  const map = new Map<
    string,
    {
      entry: McpProbeCacheEntry
      fingerprint?: string
      cachedAt: number
    }
  >()
  const get = (name: string, server?: McpServer): McpProbeCacheEntry | undefined => {
    const cached = map.get(name)
    if (!cached) return undefined
    const age = now() - cached.cachedAt
    if (age < 0 || age >= ttlMs) {
      map.delete(name)
      return undefined
    }
    if (server && cached.fingerprint !== probeFingerprint(server)) return undefined
    return cached.entry
  }
  return {
    get,
    set: (name, entry, server) => {
      map.set(name, {
        entry,
        cachedAt: now(),
        ...(server ? { fingerprint: probeFingerprint(server) } : {}),
      })
    },
    clear: (name) => {
      if (name === undefined) map.clear()
      else map.delete(name)
    },
    has: (name, server) => get(name, server) !== undefined,
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
