// Pi native MCP configuration, verified against Pi 1.0.2 (introduced in 0.99).
// The persisted `pi-mcp-adapter` ID remains stable: `pi` addresses settings.json,
// and registering two writable targets for mcp.json would race during syncAll.
// Native Pi and the optional legacy extension read the same user-scope file.
// Native Pi supports stdio and streamable HTTP; project .pi/mcp.json wins after
// project trust. OAuth, exposure and enabled-state fields belong to Pi.

import type { McpServer } from "@cognia/agent-config-types"
import type { McpImportDraft } from "@/lib/db/mcp-servers"
import type { McpAgentAdapter } from "./index"
import { denormalizeMcpEntry, dropInvalidDrafts, normalizeMcpEntry } from "./shared"

/** Optional legacy extension; native Pi no longer requires this package. */
export const PI_MCP_ADAPTER_PACKAGE = "pi-mcp-adapter"

// Accept legacy key spelling on import; always write the native spelling.
const SERVERS_KEY = "mcpServers"
const SERVERS_KEY_ALT = "mcp-servers"

interface RawPiMcpConfig {
  mcpServers?: Record<string, unknown>
  "mcp-servers"?: Record<string, unknown>
  [key: string]: unknown
}

function asRoot(value: unknown): RawPiMcpConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as RawPiMcpConfig
}

/** Which spelling this file uses. Defaults to the canonical one. */
function serversKeyOf(root: RawPiMcpConfig | null): typeof SERVERS_KEY | typeof SERVERS_KEY_ALT {
  if (root && root[SERVERS_KEY] === undefined && root[SERVERS_KEY_ALT] !== undefined) {
    return SERVERS_KEY_ALT
  }
  return SERVERS_KEY
}

function serversOf(root: RawPiMcpConfig | null): Record<string, unknown> | null {
  if (!root) return null
  const raw = root[serversKeyOf(root)]
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

function parse(value: unknown): McpImportDraft[] {
  const servers = serversOf(asRoot(value))
  if (!servers) return []

  const out: McpImportDraft[] = []
  for (const [name, raw] of Object.entries(servers)) {
    const norm = normalizeMcpEntry(raw)
    if (!norm) continue

    // `httpTransport: "sse"` is how this adapter pins SSE; without it a bare
    // `url` is HTTP. Consume the marker so it is re-derived on write rather
    // than surviving as a stale literal if the transport later changes.
    if (norm.config.httpTransport === "sse") norm.transport = "sse"
    else if (norm.config.httpTransport === "streamable-http") norm.transport = "http"
    delete norm.config.httpTransport

    out.push({ name, transport: norm.transport, config: norm.config })
  }
  return dropInvalidDrafts(out)
}

function project(
  existing: unknown | null,
  servers: McpServer[],
  managedNames?: ReadonlySet<string>
): unknown {
  const unsupported = servers.find((server) => server.transport === "sse")
  if (unsupported) {
    throw new TypeError(
      `Native Pi MCP does not support SSE server "${unsupported.name}"; use a streamable HTTP endpoint.`
    )
  }
  const root: RawPiMcpConfig = asRoot(existing) ?? {}
  const current = serversOf(asRoot(existing)) ?? {}
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name))
  const next: Record<string, unknown> = {}

  for (const [name, value] of Object.entries(current)) {
    if (!managedSet.has(name)) next[name] = value
  }

  for (const server of servers) {
    // Both native Pi and the legacy extension infer transport from command/url.
    const entry = denormalizeMcpEntry(server.transport, server.config, { typeKey: null })
    delete entry.httpTransport
    delete entry.type
    delete entry.transport
    next[server.name] = entry
  }

  // Preserve every unmanaged top-level key: this file also carries the
  // adapter's own `settings`, `imports` and per-server `disabled` overrides,
  // none of which Cognia models.
  const result = { ...root, [SERVERS_KEY]: next }
  delete result[SERVERS_KEY_ALT]
  return result
}

export const PI_MCP_ADAPTER_AGENT: McpAgentAdapter = {
  id: "pi-mcp-adapter",
  displayName: "Pi",
  description: "~/.pi/agent/mcp.json — native Pi MCP (0.99+)",
  writable: true,
  format: "json",
  parse,
  project,
}
