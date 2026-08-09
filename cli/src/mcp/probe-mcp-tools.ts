/**
 * Live MCP tool discovery for the CLI `/mcp tools <name>` command. Mirrors
 * Claude Code: connect to the configured server, run `tools/list`, tear down.
 *
 * The connection pattern is the same one the desktop workflow runtime uses
 * (`lib/workflow/nodes/built-ins.ts` → `action.mcp.invokeTool`): the official
 * `@modelcontextprotocol/sdk` Client over a stdio child process or a
 * Streamable-HTTP endpoint. The CLI owns this client-managed scope directly,
 * while desktop settings discovery uses the trusted sidecar Runtime Gateway.
 *
 * A wall-clock timeout guards the interactive TUI: a misconfigured server that
 * never completes its handshake aborts the client (killing the child / socket)
 * instead of hanging the session.
 */
import type { McpServer } from "@cognia/agent-config-types"

import { openMcpClient } from "./mcp-client"

export interface McpToolInfo {
  name: string
  description?: string
  /** The tool's JSON-Schema input shape (advertised by `tools/list`). */
  inputSchema?: unknown
}

export interface ProbeMcpDeps {
  /** Override the live connection (tests). */
  connect?: (server: McpServer, signal: AbortSignal) => Promise<McpToolInfo[]>
  /** Probe timeout in ms (default 15s). */
  timeoutMs?: number
}

/** Open the shared SDK client, list tools, and always close the transport. */
async function liveConnect(server: McpServer, signal: AbortSignal): Promise<McpToolInfo[]> {
  const opened = await openMcpClient(server, { signal })
  try {
    const res = await opened.client.listTools()
    return (res.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
  } finally {
    await opened.close()
  }
}

/**
 * Connect to `server`, return its advertised tools, and tear the connection
 * down. Rejects with a descriptive error on connection failure or timeout.
 */
export async function probeMcpTools(
  server: McpServer,
  deps: ProbeMcpDeps = {}
): Promise<McpToolInfo[]> {
  const connect = deps.connect ?? liveConnect
  const timeoutMs = deps.timeoutMs ?? 15_000
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject (winning the race with the timeout message) BEFORE aborting —
      // abort() synchronously rejects the in-flight connect, and Promise.race
      // adopts whichever settles first.
      reject(new Error(`MCP probe timed out after ${timeoutMs}ms`))
      controller.abort()
    }, timeoutMs)
  })
  try {
    return await Promise.race([connect(server, controller.signal), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
