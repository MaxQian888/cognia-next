// External MCP-server bridge for the non-Anthropic dispatch path.
//
// The Anthropic dispatcher hands user-configured `mcpServers` straight to the
// Claude Agent SDK, which spawns/connects them and exposes their tools to the
// model. `streamText` has no such concept, so the AI-SDK path previously
// IGNORED `sendOptions.mcpServers` entirely — external MCP servers were
// unreachable for every non-Anthropic provider (the single biggest silent
// capability drop for power users).
//
// This module closes that gap: for each configured server it opens an AI SDK
// MCP client (stdio / sse / http), fetches its tool set, namespaces each tool
// as `mcp__<server>__<tool>` (matching the Anthropic path + the permission
// ruleset conventions), runs execution through the SAME permission gate, and
// honours the allow/deny tool filters. Connections are opened once per session
// and closed via the returned `close()`.

import { createMCPClient } from "@ai-sdk/mcp"
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio"

import { resolveForToolCall } from "./permission-resolver.mjs"

/**
 * Build an AI SDK MCP transport (instance or config) from a Claude-Agent-SDK-
 * shaped server entry: `{ type: "stdio"|"sse"|"http", ...config }`. stdio
 * carries `command`/`args`/`env`/`cwd`; sse/http carry `url`/`headers`.
 * Returns null for an unsupported or incompletely-specified entry.
 */
export function toMcpTransport(entry, { StdioTransport = Experimental_StdioMCPTransport } = {}) {
  const type = entry?.type
  if (type === "stdio") {
    if (typeof entry.command !== "string" || !entry.command) return null
    return new StdioTransport({
      command: entry.command,
      ...(Array.isArray(entry.args) ? { args: entry.args } : {}),
      ...(entry.env && typeof entry.env === "object" ? { env: entry.env } : {}),
      ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
    })
  }
  if (type === "sse" || type === "http") {
    if (typeof entry.url !== "string" || !entry.url) return null
    return {
      type,
      url: entry.url,
      ...(entry.headers && typeof entry.headers === "object" ? { headers: entry.headers } : {}),
    }
  }
  return null
}

/**
 * Decide whether a namespaced MCP tool (`mcp__<server>__<tool>`) is exposed,
 * given the allow/deny lists. Deny wins. An empty allow list means "no
 * restriction". A whole-server allow (`mcp__<server>`) admits all of its tools.
 */
function isMcpToolPermitted(namespaced, server, allowSet, disallowedSet) {
  if (disallowedSet.has(namespaced) || disallowedSet.has(`mcp__${server}`)) return false
  if (!allowSet || allowSet.size === 0) return true
  return allowSet.has(namespaced) || allowSet.has(`mcp__${server}`)
}

/**
 * Open every configured external MCP server, collect its tools, and return a
 * namespaced + gated AI SDK tools map plus a `close()` that disconnects all
 * clients. A server that can't be built/connected, or whose `tools()` rejects,
 * is logged and skipped — one bad server never breaks the turn.
 *
 * @param {{
 *   mcpServers: Record<string, Record<string, any>> | undefined,
 *   gate?: (toolName: string, input: any) => Promise<any>,
 *   allowedTools?: string[],
 *   disallowedTools?: string[],
 *   log?: (level: "info"|"warn"|"error", message: string) => void,
 *   createClient?: (config: any) => Promise<any>,   // injected in tests
 *   StdioTransport?: any,                            // injected in tests
 * }} params
 * @returns {Promise<{ tools: Record<string, any>, close: () => Promise<void> }>}
 */
export async function buildAiSdkMcpTools({
  mcpServers,
  gate,
  allowedTools,
  disallowedTools,
  log,
  createClient,
  StdioTransport,
}) {
  /** @type {Record<string, any>} */
  const tools = {}
  /** @type {Array<{ close: () => Promise<void> }>} */
  const clients = []
  const close = async () => {
    for (const c of clients) {
      try {
        await c.close()
      } catch {
        // best-effort teardown — a failed close shouldn't crash session end.
      }
    }
  }
  if (!mcpServers || typeof mcpServers !== "object") return { tools, close }

  const make = createClient ?? createMCPClient
  const allowSet =
    Array.isArray(allowedTools) && allowedTools.length > 0 ? new Set(allowedTools) : null
  const disallowedSet = new Set(Array.isArray(disallowedTools) ? disallowedTools : [])

  for (const [server, entry] of Object.entries(mcpServers)) {
    const transport = toMcpTransport(entry, StdioTransport ? { StdioTransport } : undefined)
    if (!transport) {
      log?.("warn", `mcp "${server}": unsupported or incomplete transport config, skipped`)
      continue
    }
    let client
    try {
      client = await make({ transport })
    } catch (err) {
      log?.("warn", `mcp "${server}" failed to connect: ${err?.message ?? err}`)
      continue
    }
    clients.push(client)
    let serverTools
    try {
      serverTools = await client.tools()
    } catch (err) {
      log?.("warn", `mcp "${server}" tools() failed: ${err?.message ?? err}`)
      continue
    }
    for (const [toolName, toolDef] of Object.entries(serverTools ?? {})) {
      const namespaced = `mcp__${server}__${toolName}`
      if (!isMcpToolPermitted(namespaced, server, allowSet, disallowedSet)) continue
      tools[namespaced] = wrapMcpToolWithGate(toolDef, namespaced, gate)
    }
  }

  return { tools, close }
}

/**
 * Wrap an AI SDK MCP tool so its `execute` first passes the permission gate
 * (mirroring the built-in / plugin tool gating). The gate throws on deny and
 * may rewrite the input; all other tool fields (description / inputSchema) are
 * preserved. When no gate is supplied the tool is returned unchanged.
 */
export function wrapMcpToolWithGate(toolDef, namespaced, gate) {
  if (!gate || !toolDef || typeof toolDef.execute !== "function") return toolDef
  const originalExecute = toolDef.execute.bind(toolDef)
  return {
    ...toolDef,
    execute: async (args, options) => {
      const effective = await gate(namespaced, args ?? {})
      return originalExecute(effective, options)
    },
  }
}

export const __testing__ = { isMcpToolPermitted, resolveForToolCall }
