/**
 * Single MCP client connection seam, shared by tool/resource/prompt discovery
 * (`probe-mcp-server`), the legacy tools probe (`probe-mcp-tools`), and the
 * remote OAuth flow (`oauth-flow`). One place builds the transport so static
 * `headers`, the `sse` vs `http` transport split, and the `authProvider`
 * wiring stay consistent across every caller.
 *
 * The transport construction is a pure, injectable function so it can be unit
 * tested without the real SDK; `openMcpClient` is the thin live wrapper that
 * loads `@modelcontextprotocol/sdk` and connects.
 */
import type { McpServer } from "@/lib/claude/types"

import { VERSION } from "../version"

/** The slice of the SDK `Client` the CLI uses. */
export interface McpClientLike {
  connect(transport: unknown): Promise<void>
  listTools(): Promise<{
    tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>
  }>
  listResources(): Promise<{
    resources?: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>
  }>
  listPrompts(): Promise<{
    prompts?: Array<{
      name: string
      description?: string
      arguments?: Array<{ name: string; description?: string; required?: boolean }>
    }>
  }>
  close(): Promise<void>
}

/** A connected client plus its transport (for `finishAuth`) and teardown. */
export interface OpenedMcp {
  client: McpClientLike
  transport: { finishAuth?(authorizationCode: string): Promise<void> }
  close(): Promise<void>
}

export interface OpenMcpOptions {
  /** Aborts the in-flight connect (closes the child / socket) on fire. */
  signal?: AbortSignal
  /** OAuth client provider for remote (sse/http) servers needing authorization. */
  authProvider?: unknown
}

/** SDK transport constructors — injected in tests, defaulted to the real SDK. */
export interface McpTransportCtors {
  Stdio: new (opts: { command: string; args?: string[]; env?: Record<string, string> }) => unknown
  Http: new (url: URL, opts?: Record<string, unknown>) => unknown
  Sse: new (url: URL, opts?: Record<string, unknown>) => unknown
}

/**
 * Build the transport for a server. Pure given the constructors. stdio carries
 * command/args/env; sse/http carry the URL plus optional static `headers`
 * (as `requestInit.headers`) and an optional OAuth `authProvider`.
 */
export function buildMcpTransport(
  server: McpServer,
  ctors: McpTransportCtors,
  opts: { authProvider?: unknown } = {}
): unknown {
  const cfg = server.config
  if (server.transport === "stdio") {
    return new ctors.Stdio({
      command: String(cfg.command ?? ""),
      args: Array.isArray(cfg.args) ? (cfg.args as string[]) : [],
      env: (cfg.env as Record<string, string>) ?? undefined,
    })
  }
  const url = new URL(String(cfg.url ?? ""))
  const headers =
    cfg.headers && typeof cfg.headers === "object"
      ? (cfg.headers as Record<string, string>)
      : undefined
  const transportOpts: Record<string, unknown> = {}
  if (headers) transportOpts.requestInit = { headers }
  if (opts.authProvider) transportOpts.authProvider = opts.authProvider
  const Ctor = server.transport === "sse" ? ctors.Sse : ctors.Http
  return new Ctor(url, Object.keys(transportOpts).length > 0 ? transportOpts : undefined)
}

/** Lazily load the SDK client + transport classes. */
async function loadSdk(): Promise<{
  Client: new (
    info: { name: string; version: string },
    opts: { capabilities: object }
  ) => McpClientLike
  ctors: McpTransportCtors
}> {
  const [
    { Client },
    { StdioClientTransport },
    { StreamableHTTPClientTransport },
    { SSEClientTransport },
  ] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/client/sse.js"),
  ])
  return {
    Client: Client as never,
    ctors: {
      Stdio: StdioClientTransport as never,
      Http: StreamableHTTPClientTransport as never,
      Sse: SSEClientTransport as never,
    },
  }
}

export interface OpenMcpDeps {
  /** Override the SDK loader (tests). */
  load?: typeof loadSdk
}

/**
 * Build a client + transport for `server` WITHOUT connecting. Used by both
 * `openMcpClient` (which connects once) and the OAuth flow (which connects,
 * runs `finishAuth`, then reconnects on the same transport).
 */
export async function createMcpConnection(
  server: McpServer,
  opts: { authProvider?: unknown } = {},
  deps: OpenMcpDeps = {}
): Promise<{ client: McpClientLike; transport: OpenedMcp["transport"] }> {
  const { Client, ctors } = await (deps.load ?? loadSdk)()
  const client = new Client({ name: "cognia-cli", version: VERSION }, { capabilities: {} })
  const transport = buildMcpTransport(server, ctors, {
    authProvider: opts.authProvider,
  }) as OpenedMcp["transport"]
  return { client, transport }
}

/**
 * Connect to `server` and return the live client. The caller must invoke
 * `close()` (or abort via `opts.signal`) to release the stdio child / socket.
 * Throws on connection failure; for remote servers needing authorization the
 * SDK throws `UnauthorizedError` after calling the provider's
 * `redirectToAuthorization`.
 */
export async function openMcpClient(
  server: McpServer,
  opts: OpenMcpOptions = {},
  deps: OpenMcpDeps = {}
): Promise<OpenedMcp> {
  const { client, transport } = await createMcpConnection(
    server,
    { authProvider: opts.authProvider },
    deps
  )

  const onAbort = () => void client.close().catch(() => undefined)
  if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true })
  try {
    await client.connect(transport)
  } catch (err) {
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort)
    await client.close().catch(() => undefined)
    throw err
  }
  return {
    client,
    transport,
    close: async () => {
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort)
      await client.close().catch(() => undefined)
    },
  }
}
