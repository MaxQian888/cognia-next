import { createMCPClient } from "@ai-sdk/mcp"

import { createEgressGuard as createDefaultEgressGuard } from "../mcp-oauth-helper.mjs"
import { toMcpTransport } from "./ai-sdk-mcp.mjs"

const DEFAULT_TIMEOUT_MS = 15_000

function isMethodNotFound(error) {
  return error?.code === -32601 || error?.data?.code === -32601 || /method not found/i.test(error?.message)
}

async function optionalList(operation) {
  try {
    return await operation()
  } catch (error) {
    if (isMethodNotFound(error)) return undefined
    throw error
  }
}

function normalizeServer(server) {
  if (!server || typeof server !== "object") throw new Error("missing MCP server definition")
  if (!server.config || typeof server.config !== "object") {
    throw new Error("missing MCP server configuration")
  }
  return { type: server.transport, ...server.config }
}

/**
 * Ephemeral, client-managed capability discovery used by settings and editor
 * surfaces. It shares the guarded AI SDK transport seam and always tears down
 * the client/dispatcher before returning.
 */
export async function discoverMcpServer(
  server,
  {
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    createClient = createMCPClient,
    createEgressGuard = createDefaultEgressGuard,
    StdioTransport,
  } = {}
) {
  const startedAt = Date.now()
  const entry = normalizeServer(server)
  const remote = entry.type === "http" || entry.type === "sse"
  const guard = remote
    ? createEgressGuard({ allowPrivateNetwork: entry.allowPrivateNetwork === true })
    : undefined
  const transport = toMcpTransport(entry, {
    ...(StdioTransport ? { StdioTransport } : {}),
    ...(guard ? { fetch: guard.fetch } : {}),
  })
  if (!transport) {
    await guard?.close?.()
    throw new Error("invalid or blocked MCP transport configuration")
  }

  let client
  try {
    client = await createClient({
      transport,
      initializationOptions: { timeout: timeoutMs, ...(signal ? { signal } : {}) },
      maxRetries: 0,
      clientName: "cognia-runtime-gateway",
      version: "1.0.0",
    })
    const options = { options: { timeout: timeoutMs, ...(signal ? { signal } : {}) } }
    const [toolResult, resourceResult, promptResult] = await Promise.all([
      client.listTools(options),
      optionalList(() => client.listResources(options)),
      optionalList(() => client.experimental_listPrompts(options)),
    ])
    const tools = (toolResult?.tools ?? []).map((tool) => ({
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
    }))
    const resources = (resourceResult?.resources ?? []).map((resource) => ({
      uri: resource.uri,
      ...(typeof resource.name === "string" ? { name: resource.name } : {}),
      ...(typeof resource.description === "string" ? { description: resource.description } : {}),
      ...(typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}),
    }))
    const prompts = (promptResult?.prompts ?? []).map((prompt) => ({
      name: prompt.name,
      ...(typeof prompt.description === "string" ? { description: prompt.description } : {}),
    }))
    return {
      ok: true,
      toolCount: tools.length,
      tools,
      resources,
      prompts,
      durationMs: Date.now() - startedAt,
    }
  } finally {
    try {
      await client?.close?.()
    } finally {
      await guard?.close?.()
    }
  }
}

