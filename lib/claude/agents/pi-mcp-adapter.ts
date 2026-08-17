// Pi's MCP, which Pi itself does not have.
//
// Pi's core ships zero MCP support — `mcpServers` appears nowhere in its
// distribution. MCP arrives only when the user installs the third-party
// `pi-mcp-adapter` package, which is why this adapter's id is
// `pi-mcp-adapter` rather than `pi`: the two ids address two different files
// owned by two different projects, and conflating them would let a user with
// no adapter installed believe Cognia had wired MCP into Pi.
//
// **Layering.** The adapter reads six sources and lets the LAST one win:
//
//   1. ~/.config/mcp/mcp.json      4. <pi agent dir>/mcp.json   ← we write here
//   2. ~/.agents/mcp.json          5. ./.mcp.json
//   3. ~/.agents/mcp/mcp.json      6. ./.pi/mcp.json            ← highest
//
// This is the inverse of every other agent in this registry, where the user
// scope is authoritative and project files are the exception. We still write
// only the user scope — the two project layers are version-controlled repo
// files that are not ours to edit — and surface the inversion through
// `mcp-drift-banner.tsx` so a user whose repo pins a server understands why
// their edit here had no effect.
//
// **Shape.** `ServerEntry` (pi-mcp-adapter's own `types.ts`) has no `type` /
// `transport` discriminator at all: transport is inferred from `command` vs
// `url` vs `socket`. So we omit the type key entirely — stamping one would
// leave a field the adapter never reads. SSE is the one case that needs a
// marker, because a bare `url` is read back as HTTP; `httpTransport: "sse"` is
// the adapter's own field for pinning that, so the round-trip stays lossless.

import type { McpServer } from "@cognia/agent-config-types"
import type { McpImportDraft } from "@/lib/db/mcp-servers"
import type { McpAgentAdapter } from "./index"
import { denormalizeMcpEntry, dropInvalidDrafts, normalizeMcpEntry } from "./shared"

/**
 * The npm identity of the package that provides this file. The UI gates the
 * whole surface on this being installed — without it, writing `mcp.json` would
 * produce a file nothing reads.
 */
export const PI_MCP_ADAPTER_PACKAGE = "pi-mcp-adapter"

/**
 * Both key spellings the adapter accepts (`config.ts` reads
 * `raw.mcpServers ?? raw["mcp-servers"]`). We preserve whichever one the file
 * already uses rather than normalising, exactly as the adapter's own writer
 * does — rewriting the key would look like a hand-edit in a user's diff.
 */
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
  const root: RawPiMcpConfig = asRoot(existing) ?? {}
  const key = serversKeyOf(asRoot(existing))
  const current = serversOf(asRoot(existing)) ?? {}
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name))
  const next: Record<string, unknown> = {}

  for (const [name, value] of Object.entries(current)) {
    if (!managedSet.has(name)) next[name] = value
  }

  for (const server of servers) {
    // `typeKey: null` — `ServerEntry` has no discriminator; transport is read
    // off `command` / `url` / `socket`.
    const entry = denormalizeMcpEntry(server.transport, server.config, { typeKey: null })
    if (server.transport === "sse") entry.httpTransport = "sse"
    next[server.name] = entry
  }

  // Preserve every unmanaged top-level key: this file also carries the
  // adapter's own `settings`, `imports` and per-server `disabled` overrides,
  // none of which Cognia models.
  return { ...root, [key]: next }
}

export const PI_MCP_ADAPTER_AGENT: McpAgentAdapter = {
  id: "pi-mcp-adapter",
  displayName: "Pi (MCP adapter)",
  description: "~/.pi/agent/mcp.json — requires the pi-mcp-adapter package",
  writable: true,
  format: "json",
  parse,
  project,
}
