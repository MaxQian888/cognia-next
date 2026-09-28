import type { ToolExecutionOptions } from "ai"
import type { MCPClientConfig, MCPTransport } from "@ai-sdk/mcp"
import type { StdioConfig } from "@ai-sdk/mcp/mcp-stdio"
import type { EgressGuard } from "../../platform/net/egress-guard.ts"
import type { McpLogEntry } from "./log.ts"

export interface McpServerEntry {
  type?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  allowPrivateNetwork?: boolean
  timeout?: number
  alwaysLoad?: boolean
  [key: string]: unknown
}
export type StdioTransportConstructor = new (config: StdioConfig) => MCPTransport
export type McpExecutionOptions = ToolExecutionOptions<unknown>
export interface McpTool {
  execute?(args: Record<string, unknown>, options: McpExecutionOptions): unknown
  [key: string]: unknown
}
export type McpTools = Record<string, McpTool>
export interface McpToolClient {
  tools(): Promise<McpTools>
  close(): Promise<unknown>
}
export type McpClientFactory = (config: MCPClientConfig) => Promise<McpToolClient>
export type McpPermissionGate = (
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal
) => Promise<Record<string, unknown>>
export type McpOutputReviewer = (
  name: string,
  id: string | undefined,
  output: unknown,
  isError: boolean
) => Promise<unknown>
export interface McpToolsOptions {
  mcpServers?: Record<string, McpServerEntry> | undefined
  gate?: McpPermissionGate
  reviewToolOutput?: McpOutputReviewer
  allowedTools?: string[]
  disallowedTools?: string[]
  log?: (level: "info" | "warn" | "error", message: string) => void
  emitMcpLog?: (entry: McpLogEntry) => void
  createClient?: McpClientFactory
  StdioTransport?: StdioTransportConstructor
  retryDelayMs?: number
  maxAttempts?: number
  connectTimeoutMs?: number
  createEgressGuard?: (options: { allowPrivateNetwork: boolean }) => EgressGuard
}
