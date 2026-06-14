/**
 * CLI MCP client seam. The connection logic now lives in the shared
 * `@/lib/mcp/transport` module (reused by the desktop workflow runtime and the
 * plan step dispatcher); this file re-exports it so existing CLI import sites
 * (`probe-mcp-server`, `probe-mcp-tools`, `oauth-flow`) stay unchanged.
 */
export {
  buildMcpTransport,
  createMcpConnection,
  openMcpClient,
  type McpClientInfo,
  type McpClientLike,
  type McpTransportCtors,
  type OpenedMcp,
  type OpenMcpDeps,
  type OpenMcpOptions,
} from "@/lib/mcp/transport"
