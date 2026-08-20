// Storybook-only fixture builders for the MCP settings panel
// (`components/settings/mcp/**`). Kept dependency-light: it imports only the
// shared domain types so importing it from a story never drags a store/db graph
// into the bundle. Stories pass overrides to shape each scenario.
import type { McpCapabilityCacheRow, McpServer } from "@cognia/agent-config-types"
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
    // Governance fields a real row always carries (`createMcpServer` sets
    // them). Seeding without them makes stories exercise the legacy-row path
    // rather than the one users are on.
    schemaVersion: 1,
    revision: 1,
    credentialVersion: 0,
    origin: "manual",
    trust: { state: "trusted" },
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

/**
 * Discovered capabilities for one server. The panel's per-tool switches read
 * the capability cache rather than talking to the server, so seeding this table
 * is what makes the Tools card render outside the desktop shell.
 */
export function makeMcpCapabilityRow(
  serverId: string,
  toolNames: readonly string[],
  overrides: Partial<McpCapabilityCacheRow> = {}
): McpCapabilityCacheRow {
  const updatedAt = overrides.updatedAt ?? Date.UTC(2026, 5, 1, 10, 0, 0)
  return {
    id: `${serverId}:storybook`,
    serverId,
    fingerprint: "storybook",
    tools: toolNames.map((name) => ({
      name,
      description: `Storybook fixture for ${name}.`,
    })),
    resources: [],
    prompts: [],
    expiresAt: updatedAt + 600_000,
    updatedAt,
    ...overrides,
  }
}

/** Capability rows matching `makeMcpServerList()`. */
export function makeMcpCapabilityList(): McpCapabilityCacheRow[] {
  return [
    makeMcpCapabilityRow("mcp_fs", [
      "read_file",
      "read_multiple_files",
      "write_file",
      "edit_file",
      "create_directory",
      "list_directory",
      "move_file",
      "search_files",
    ]),
    makeMcpCapabilityRow("mcp_github", [
      "search_repositories",
      "get_file_contents",
      "create_issue",
      "create_pull_request",
    ]),
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
