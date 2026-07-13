// Codex CLI. ~/.codex/config.toml — TOML, not JSON. Rust handles the
// format-level read/write via `toml_edit` to preserve comments and ordering
// outside the `[mcp_servers.*]` tables; the adapter receives the file as a
// JSON tree where each `[mcp_servers.NAME]` table appears under
// `mcp_servers.NAME` and writes back in the same shape.
//
// Codex tolerantly accepts both `[mcp_servers.NAME]` (canonical) and
// `[mcp.servers.NAME]` (typo); on read we honor either; on write we always
// emit the canonical key.
//
// Transport is inferred from fields: `command` → stdio, `url` → http (Codex
// supports streamable HTTP, not SSE; servers with explicit `type` other
// than `streamable-http` get coerced to http).

import type { McpServer } from "@cognia/agent-config-types"
import type { McpImportDraft } from "@/lib/db/mcp-servers"
import type { McpAgentAdapter } from "./index"
import { denormalizeMcpEntry, dropInvalidDrafts, normalizeMcpEntry } from "./shared"

interface RawCodexConfig {
  mcp_servers?: Record<string, unknown>
  /** Tolerated alternate spelling. */
  "mcp.servers"?: Record<string, unknown>
  [key: string]: unknown
}

function asRoot(value: unknown): RawCodexConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as RawCodexConfig
}

function pickServerMap(root: RawCodexConfig): Record<string, unknown> {
  const a = root.mcp_servers
  if (a && typeof a === "object") return a
  const b = root["mcp.servers"]
  if (b && typeof b === "object") return b
  return {}
}

function parse(value: unknown): McpImportDraft[] {
  const root = asRoot(value)
  if (!root) return []
  const map = pickServerMap(root)
  const out: McpImportDraft[] = []
  for (const [name, raw] of Object.entries(map)) {
    const norm = normalizeMcpEntry(raw)
    if (!norm) continue
    out.push({ name, transport: norm.transport, config: norm.config })
  }
  return dropInvalidDrafts(out)
}

function project(
  existing: unknown | null,
  servers: McpServer[],
  managedNames?: ReadonlySet<string>
): unknown {
  const root: RawCodexConfig = asRoot(existing) ?? {}
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name))

  // Merge whichever map the file used; canonicalize on the way out.
  const merged: Record<string, unknown> = { ...pickServerMap(root) }
  // If the file used the typo'd key, drop it so we don't leave a dupe.
  delete root["mcp.servers"]

  // Drop every name in our managed set (whether it's currently projected to
  // codex or not); we'll re-stamp the active subset below.
  for (const name of managedSet) delete merged[name]

  for (const server of servers) {
    if (server.transport === "sse") {
      // Codex doesn't support SSE; it speaks streamable HTTP. Skip rather
      // than silently rewrite the URL (the server may not support HTTP).
      continue
    }
    merged[server.name] = denormalizeMcpEntry(server.transport, server.config, {
      typeKey: null,
    })
  }

  return { ...root, mcp_servers: merged }
}

export const CODEX_AGENT: McpAgentAdapter = {
  id: "codex",
  displayName: "Codex CLI",
  description: "~/.codex/config.toml — TOML, [mcp_servers.NAME] tables",
  writable: true,
  format: "toml",
  parse,
  project,
}
