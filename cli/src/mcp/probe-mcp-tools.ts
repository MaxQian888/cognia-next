/**
 * Live MCP tool discovery for the CLI `/mcp tools <name>` command. Mirrors
 * Claude Code: connect to the configured server, run `tools/list`, tear down.
 *
 * The connection pattern is the same one the desktop workflow runtime uses
 * (`lib/workflow/nodes/built-ins.ts` → `action.mcp.invokeTool`): the official
 * `@modelcontextprotocol/sdk` Client over a stdio child process or a
 * Streamable-HTTP endpoint. The Rust `test_mcp_server` probe is Tauri-only, so
 * the pure-Node CLI cannot reach it — this is the Node equivalent.
 *
 * A wall-clock timeout guards the interactive TUI: a misconfigured server that
 * never completes its handshake aborts the client (killing the child / socket)
 * instead of hanging the session.
 */
import type { McpServer } from "@/lib/claude/types"

import { VERSION } from "../version"

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

/** Open a real SDK client, list tools, and always close the transport. */
async function liveConnect(server: McpServer, signal: AbortSignal): Promise<McpToolInfo[]> {
  const [{ Client }, { StdioClientTransport }, { StreamableHTTPClientTransport }] =
    await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/stdio.js"),
      import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    ])

  const client = new Client({ name: "cognia-cli", version: VERSION }, { capabilities: {} })
  const transport =
    server.transport === "stdio"
      ? new StdioClientTransport({
          command: String(server.config.command ?? ""),
          args: Array.isArray(server.config.args) ? (server.config.args as string[]) : [],
          env: (server.config.env as Record<string, string>) ?? undefined,
        })
      : new StreamableHTTPClientTransport(new URL(String(server.config.url ?? "")))

  // On timeout, close the client so the stdio child / HTTP socket is released.
  const onAbort = () => void client.close().catch(() => undefined)
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    await client.connect(transport)
    const res = await client.listTools()
    return (res.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
  } finally {
    signal.removeEventListener("abort", onAbort)
    await client.close().catch(() => undefined)
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
