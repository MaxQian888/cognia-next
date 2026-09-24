/**
 * Project ACP-shaped MCP servers into Codex's own `mcp_servers` config table.
 *
 * Codex has no per-session `mcpServers` parameter the way ACP does — it reads
 * MCP servers from `~/.codex/config.toml`. What `thread/start` DOES accept is a
 * `config` object of per-thread overrides in that same TOML shape, which is the
 * only channel a caller has for "give this thread these servers".
 *
 * Without this the adapter silently dropped every server the caller attached:
 * Cognia's tool bridge reported healthy, the session advertised its tools, and
 * Codex answered that `mcp__cognia-tools__*` was unavailable — a hosted agent
 * with none of Cognia's tools and nothing saying so.
 *
 * Pure, so the mapping is testable without an agent.
 */

import type { AcpMcpServerConfig } from "@/types/agent/external-agent"

/** One entry of Codex's `mcp_servers` table. */
export interface CodexMcpServerEntry {
  type: "stdio" | "streamable_http"
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  http_headers?: Record<string, string>
}

/** Codex reads env and headers as tables, while ACP models them as name/value lists. */
function toTable(
  pairs?: Array<{ name: string; value: string }>
): Record<string, string> | undefined {
  if (!pairs || pairs.length === 0) return undefined
  const out: Record<string, string> = {}
  for (const pair of pairs) out[pair.name] = pair.value
  return Object.keys(out).length > 0 ? out : undefined
}

/** Map one ACP server, or null when Codex has no equivalent transport. */
export function toCodexMcpServerEntry(server: AcpMcpServerConfig): CodexMcpServerEntry | null {
  if ("command" in server && server.command) {
    return {
      type: "stdio",
      command: server.command,
      ...(server.args?.length ? { args: [...server.args] } : {}),
      ...(toTable(server.env) ? { env: toTable(server.env) } : {}),
    }
  }
  if ("url" in server && server.url) {
    // Codex models only streamable HTTP; SSE is a deprecated ACP transport with
    // no Codex counterpart, so forwarding it as HTTP would misdescribe it.
    if (server.type === "sse") return null
    return {
      type: "streamable_http",
      url: server.url,
      ...(toTable(server.headers) ? { http_headers: toTable(server.headers) } : {}),
    }
  }
  return null
}

/**
 * Build the `mcp_servers` table for a thread, or undefined when nothing maps.
 *
 * A duplicate name keeps the first, matching the ACP projection — the table is
 * keyed by name, so the alternative is one server silently replacing another.
 */
export function buildCodexMcpServersConfig(
  servers: AcpMcpServerConfig[] | undefined
): Record<string, CodexMcpServerEntry> | undefined {
  if (!servers || servers.length === 0) return undefined
  const table: Record<string, CodexMcpServerEntry> = {}
  for (const server of servers) {
    if (!server.name || table[server.name]) continue
    const entry = toCodexMcpServerEntry(server)
    if (entry) table[server.name] = entry
  }
  return Object.keys(table).length > 0 ? table : undefined
}

/**
 * Merge the projected servers into a thread's `config` overrides.
 *
 * Existing overrides win on every other key; `mcp_servers` is merged rather than
 * replaced so a caller-supplied table and the attached servers can coexist.
 */
export function withCodexMcpServers(
  config: Record<string, unknown> | undefined,
  servers: AcpMcpServerConfig[] | undefined
): Record<string, unknown> | undefined {
  const table = buildCodexMcpServersConfig(servers)
  if (!table) return config
  const existing =
    config && typeof config.mcp_servers === "object" && config.mcp_servers !== null
      ? (config.mcp_servers as Record<string, unknown>)
      : {}
  return { ...(config ?? {}), mcp_servers: { ...table, ...existing } }
}
