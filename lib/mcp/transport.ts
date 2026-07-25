/**
 * Shared MCP client connection seam used across surfaces — the CLI (tool /
 * resource / prompt discovery, remote OAuth), the desktop workflow runtime
 * (`action.mcp.invokeTool`), and the plan step dispatcher (`mcp_tool_call`).
 * One place builds the transport so the static `headers`, the `sse` vs `http`
 * transport split, and the `authProvider` wiring stay consistent across every
 * caller.
 *
 * The transport construction is a pure, injectable function so it can be unit
 * tested without the real SDK; `openMcpClient` is the thin live wrapper that
 * loads `@modelcontextprotocol/sdk` and connects. The SDK is loaded lazily
 * (`await import`) so the static-exported renderer never bundles it.
 */
import type { McpServer } from "@cognia/agent-config-types"

/** Identity reported to the MCP server during `initialize`. */
export interface McpClientInfo {
  name: string
  version: string
}

const DEFAULT_CLIENT_INFO: McpClientInfo = { name: "cognia", version: "1.0.0" }

/** The slice of the SDK `Client` callers use. */
export interface McpClientLike {
  connect(transport: unknown): Promise<void>
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{
    isError?: boolean
    content?: unknown[]
    structuredContent?: unknown
  }>
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

/**
 * Sink for a stdio MCP server's captured stderr. Chunks arrive as decoded text.
 * Omit it to drain-and-discard: the point is that stderr is captured *away from
 * the terminal* either way — never streamed to our stdout, where it would smear
 * an interactive Ink TUI frame. See {@link buildMcpTransport}.
 */
export type McpStderrSink = (chunk: string) => void

export interface OpenMcpOptions {
  /** Aborts the in-flight connect (closes the child / socket) on fire. */
  signal?: AbortSignal
  /** OAuth client provider for remote (sse/http) servers needing authorization. */
  authProvider?: unknown
  /** Identity reported to the server (defaults to a generic cognia identity). */
  clientInfo?: McpClientInfo
  /** Receives the stdio child's captured stderr (diagnostics). No-op for remote
   * servers, which have no stderr stream. Omit to drain and discard. */
  onStderr?: McpStderrSink
}

/** How the spawned stdio child's stderr is wired. Matches the SDK's IOType. */
export type McpStdioStderr = "overlapped" | "pipe" | "ignore" | "inherit"

/** SDK transport constructors — injected in tests, defaulted to the real SDK. */
export interface McpTransportCtors {
  Stdio: new (opts: {
    command: string
    args?: string[]
    env?: Record<string, string>
    stderr?: McpStdioStderr
  }) => unknown
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
      // The SDK spawns the child with `stdio: ["pipe", "pipe", stderr ?? "inherit"]`.
      // Left to default, the server's stderr streams straight to our terminal and
      // smears the Ink TUI frame. Pipe it so `createMcpConnection` can drain (and
      // optionally forward) it instead of letting it reach the screen.
      stderr: "pipe",
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

/** The slice of a Node readable stream the stderr drain touches. */
interface StderrStream {
  on(event: "data", cb: (chunk: unknown) => void): unknown
  on(event: "error", cb: (err: unknown) => void): unknown
}

/**
 * Consume the stdio transport's piped stderr so it (a) never reaches the terminal
 * and (b) never fills its pipe buffer and stalls the child. Attaching a `data`
 * listener switches the stream to flowing mode, so chunks drain whether or not a
 * sink is registered. Decoded text is forwarded to `sink` when supplied.
 *
 * No-op for remote (sse/http) transports, which expose no stderr stream.
 */
function drainStderr(transport: unknown, sink?: McpStderrSink): void {
  const stderr = (transport as { stderr?: StderrStream | null } | null | undefined)?.stderr
  if (!stderr || typeof stderr.on !== "function") return
  const decoder = new TextDecoder("utf-8", { fatal: false })
  stderr.on("data", (chunk: unknown) => {
    if (!sink) return // still drains — the listener alone keeps the stream flowing
    try {
      const text =
        typeof chunk === "string"
          ? chunk
          : chunk instanceof Uint8Array
            ? decoder.decode(chunk, { stream: true })
            : String(chunk)
      if (text) sink(text)
    } catch {
      // A throwing sink must not break the drain (and take the connect down with it).
    }
  })
  // A crashed child makes its stderr emit 'error'; swallow it so it can't surface
  // as an unhandled stream error and tear down the CLI.
  stderr.on("error", () => undefined)
}

/**
 * Build a client + transport for `server` WITHOUT connecting. Used by both
 * `openMcpClient` (which connects once) and the OAuth flow (which connects,
 * runs `finishAuth`, then reconnects on the same transport).
 */
export async function createMcpConnection(
  server: McpServer,
  opts: { authProvider?: unknown; clientInfo?: McpClientInfo; onStderr?: McpStderrSink } = {},
  deps: OpenMcpDeps = {}
): Promise<{ client: McpClientLike; transport: OpenedMcp["transport"] }> {
  const { Client, ctors } = await (deps.load ?? loadSdk)()
  const info = opts.clientInfo ?? DEFAULT_CLIENT_INFO
  const client = new Client({ name: info.name, version: info.version }, { capabilities: {} })
  const transport = buildMcpTransport(server, ctors, {
    authProvider: opts.authProvider,
  }) as OpenedMcp["transport"]
  // Capture the stdio child's stderr away from the terminal. The SDK exposes the
  // piped stream immediately (a PassThrough built in its ctor), so this attaches
  // before connect and never misses the child's startup diagnostics.
  drainStderr(transport, opts.onStderr)
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
    { authProvider: opts.authProvider, clientInfo: opts.clientInfo, onStderr: opts.onStderr },
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
