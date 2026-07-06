// Storybook-only fixture builders for the MCP settings panel
// (`components/settings/mcp/**`). Kept dependency-light: it imports only the
// shared domain types so importing it from a story never drags a store/db graph
// into the bundle. Stories pass overrides to shape each scenario.
import type { McpServer } from "@/lib/claude/types"
import type { McpAuditLogRow } from "@/types/wiki"

let seq = 0

/**
 * Build a valid `McpServer` row. Defaults to an enabled stdio server projected
 * into Claude Code; pass `overrides` (incl. a transport-appropriate `config`)
 * to shape http/sse rows, disabled rows, plugin-owned rows, etc.
 */
export function makeMcpServer(overrides: Partial<McpServer> = {}): McpServer {
  seq += 1
  const id = overrides.id ?? `mcp_${seq}`
  const createdAt = overrides.createdAt ?? Date.UTC(2026, 5, 1) + seq * 1000
  return {
    id,
    name: `server-${seq}`,
    transport: "stdio",
    config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    enabled: true,
    appsEnabled: { "claude-code": true },
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  }
}

/** A representative mixed list: enabled/disabled across stdio + remote transports. */
export function makeMcpServerList(): McpServer[] {
  return [
    makeMcpServer({
      id: "mcp_fs",
      name: "filesystem",
      transport: "stdio",
      config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/work"] },
      enabled: true,
      appsEnabled: { "claude-code": true, cursor: true },
    }),
    makeMcpServer({
      id: "mcp_github",
      name: "github",
      transport: "http",
      config: {
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer ghp_••••" },
      },
      enabled: true,
      appsEnabled: { "claude-code": true },
    }),
    makeMcpServer({
      id: "mcp_linear",
      name: "linear",
      transport: "sse",
      config: { url: "https://mcp.linear.app/sse" },
      enabled: false,
      appsEnabled: {},
    }),
    makeMcpServer({
      id: "mcp_postgres",
      name: "postgres",
      transport: "stdio",
      config: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-postgres"],
        env: { DATABASE_URL: "postgres://localhost/app" },
      },
      enabled: false,
      appsEnabled: { "claude-code": true },
    }),
  ]
}

/** Build an MCP bridge audit-log row (for the Health & Logs tab). */
export function makeMcpAuditRow(overrides: Partial<McpAuditLogRow> = {}): McpAuditLogRow {
  seq += 1
  return {
    id: overrides.id ?? `mau_${seq}`,
    ts: overrides.ts ?? Date.UTC(2026, 5, 1, 9, 0, seq),
    tool: "wiki_search",
    scope: "n/a",
    allowed: true,
    latencyMs: 42,
    ...overrides,
  }
}
