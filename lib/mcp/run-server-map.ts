/**
 * The credential-resolved `mcpServers` map for one agent run.
 *
 * Every run surface that hands MCP servers to an agent (the chat send path,
 * external ACP children) goes through here, so they agree on how a saved
 * server becomes a connectable config: keyring SecretRefs are resolved, and on
 * the desktop each remote server gets its endpoint-scoped OAuth bearer header,
 * refreshed when it is about to expire. Web and CLI have no keyring-backed
 * OAuth store, so they resolve SecretRefs only.
 *
 * Selection (trust, workspace overlay, per-run subsets) is the caller's job;
 * this only turns already-selected servers into wire configs.
 */

import type { McpServer } from "@cognia/agent-config-types"
import type { McpServerWireConfig } from "@cognia/agent-config-types/claude-agent-sdk-options"

export interface RunMcpServerMapDeps {
  isTauri?: () => boolean
}

export async function buildRunMcpServerMap(
  servers: McpServer[],
  deps: RunMcpServerMapDeps = {}
): Promise<Record<string, McpServerWireConfig>> {
  const isTauri = deps.isTauri ?? (await import("@/lib/tauri")).isTauri
  if (!isTauri()) {
    const { buildMcpServerMapResolved } = await import("@/lib/db/mcp-servers")
    return buildMcpServerMapResolved(servers)
  }
  // Inject the endpoint/scope-partitioned token and refresh near-expiry
  // credentials before handing a static header to the runtime. The governed
  // renderer runtime additionally handles explicit 401s through its
  // reconnect-once credential resolver.
  const [{ buildMcpServerMapWithAuth }, { mcpOAuthLoadEntry, mcpOAuthRefresh }] = await Promise.all(
    [import("@/lib/db/mcp-servers"), import("@/lib/mcp/oauth-tauri")]
  )
  return buildMcpServerMapWithAuth(servers, {
    loadEntry: (serverId, legacyName) => {
      const server = servers.find((candidate) => candidate.id === serverId)
      return mcpOAuthLoadEntry(
        serverId,
        legacyName,
        server ? { transport: server.transport, config: server.config } : undefined
      )
    },
    refresh: (serverName) => {
      const server = servers.find((candidate) => candidate.name === serverName)
      return server
        ? mcpOAuthRefresh(server.id, { transport: server.transport, config: server.config })
        : Promise.resolve(undefined)
    },
  })
}
