// The Claude Agent SDK rail's view of the A2UI bridge tools: an in-process
// SDK MCP server over the engine-neutral definitions in `tools/a2ui/tools.ts`.

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk/core"

import { buildA2UIToolDefinitions, SERVER_NAME, SERVER_VERSION } from "../a2ui/tools.ts"
import { toSdkMcpToolDefinition } from "./sdk-mcp.ts"

/** Build the in-process A2UI bridge MCP server for one session. */
export function buildA2UIBridgeServer(options: Parameters<typeof buildA2UIToolDefinitions>[0]) {
  const alwaysLoad = options.alwaysLoad ?? true
  return createSdkMcpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    tools: buildA2UIToolDefinitions({ ...options, alwaysLoad }).map(toSdkMcpToolDefinition),
    ...(alwaysLoad ? { alwaysLoad: true } : {}),
  })
}
