// The Claude Agent SDK rail's view of plugin tools: the synthetic
// `cognia-plugin-tools` in-process SDK MCP server over the engine-neutral
// renderer proxy in `tools/plugin/proxy.ts`.

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk/core"
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"

import {
  buildPluginToolDefinitions,
  SERVER_NAME,
  SERVER_VERSION,
  type PluginToolsServerOptions,
} from "../plugin/proxy.ts"
import { toSdkMcpToolDefinition } from "./sdk-mcp.ts"

/**
 * Build the in-process MCP server that proxies plugin tool calls back to the
 * renderer, or `null` when the manifest is empty.
 */
export function buildPluginToolsServer(
  options: PluginToolsServerOptions
): McpSdkServerConfigWithInstance | null {
  const definitions = buildPluginToolDefinitions(options)
  if (!definitions) return null
  return createSdkMcpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    tools: definitions.map(toSdkMcpToolDefinition),
    ...(options.alwaysLoad ? { alwaysLoad: true } : {}),
  })
}
