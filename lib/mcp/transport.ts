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
 * loads the split MCP v2 client/core packages and connects. The SDK is loaded lazily
 * (`await import`) so the static-exported renderer never bundles it.
 */
import type { McpServer } from "@cognia/agent-config-types"
import { hasMcpSecretRefs, resolveMcpSecrets } from "./credentials"
import {
  createMcpElicitationRequest,
  type McpElicitationHandler,
  type McpElicitationResult,
} from "./elicitation"
import {
  evaluateMcpPolicy,
  validateMcpRemoteEgress,
  type McpExecutionGrant,
  type McpExecutionSurface,
} from "./policy"

/** Identity reported to the MCP server during `initialize`. */
export interface McpClientInfo {
  name: string
  version: string
}

const DEFAULT_CLIENT_INFO: McpClientInfo = { name: "cognia", version: "1.0.0" }

export const COGNIA_MCP_PROTOCOL_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const

interface McpClientOptions {
  capabilities: Record<string, unknown>
  versionNegotiation: { mode: "auto"; probe: { timeoutMs: number; maxRetries: number } }
  supportedProtocolVersions: string[]
  inputRequired: { autoFulfill: true; maxRounds: number }
  listMaxPages: number
  defaultCacheTtlMs: number
  cachePartition: string
  listChanged?: Record<
    "tools" | "resources" | "prompts",
    { autoRefresh: boolean; debounceMs: number; onChanged: (error: Error | null) => void }
  >
}

/** The slice of the SDK `Client` callers use. */
export interface McpClientLike {
  connect(transport: unknown): Promise<void>
  request?<T>(
    request: { method: string; params?: Record<string, unknown> },
    resultSchema: unknown,
    options?: { signal?: AbortSignal; timeout?: number }
  ): Promise<T>
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { signal?: AbortSignal; timeout?: number }
  ): Promise<{
    isError?: boolean
    content?: unknown[]
    structuredContent?: unknown
  }>
  listTools(): Promise<{
    tools?: Array<{
      name: string
      description?: string
      inputSchema?: unknown
      outputSchema?: unknown
      _meta?: Record<string, unknown>
    }>
  }>
  listResources(): Promise<{
    resources?: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>
  }>
  readResource(params: { uri: string }): Promise<{
    contents?: Array<{
      uri: string
      mimeType?: string
      text?: string
      blob?: string
      _meta?: Record<string, unknown>
    }>
  }>
  listPrompts(): Promise<{
    prompts?: Array<{
      name: string
      description?: string
      arguments?: Array<{ name: string; description?: string; required?: boolean }>
    }>
  }>
  getPrompt(params: { name: string; arguments?: Record<string, string> }): Promise<{
    description?: string
    messages?: Array<{
      role: "user" | "assistant"
      content: unknown
    }>
  }>
  setRequestHandler?(
    schema: unknown,
    handler: (request: { params?: Record<string, unknown> }) => Promise<McpElicitationResult>
  ): void
  getNegotiatedProtocolVersion?(): string | undefined
  getProtocolEra?(): "legacy" | "modern" | undefined
  close(): Promise<void>
}

/** A connected client plus its transport (for `finishAuth`) and teardown. */
export interface OpenedMcp {
  client: McpClientLike
  transport: { finishAuth?(authorizationCode: string): Promise<void> }
  negotiatedProtocolVersion?: string
  protocolEra?: "legacy" | "modern"
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
  /** Execution context used by the common trust policy. Defaults to non-interactive CLI. */
  surface?: McpExecutionSurface
  interactive?: boolean
  grant?: McpExecutionGrant
  toolName?: string
  fingerprint?: string
  /** Capability cache invalidation hook for notifications/tools/list_changed. */
  onToolsChanged?: () => void | Promise<void>
  /** Invalidate tools/resources/prompts after any list_changed notification. */
  onCapabilitiesChanged?: () => void | Promise<void>
  /** Presents a provenance-labelled form or URL confirmation to the user. */
  onElicitation?: McpElicitationHandler
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

type McpRemoteFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

interface McpEgressGuard {
  fetch: McpRemoteFetch
  close(): Promise<void>
}

/**
 * Build the transport for a server. Pure given the constructors. stdio carries
 * command/args/env; sse/http carry the URL plus optional static `headers`
 * (as `requestInit.headers`) and an optional OAuth `authProvider`.
 */
export function buildMcpTransport(
  server: McpServer,
  ctors: McpTransportCtors,
  opts: { authProvider?: unknown; fetch?: McpRemoteFetch } = {}
): unknown {
  const cfg = server.config as unknown as Record<string, unknown>
  if (server.transport === "stdio") {
    return new ctors.Stdio({
      command: String(cfg.command ?? ""),
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
      env: (cfg.env as Record<string, string>) ?? undefined,
      // The SDK spawns the child with `stdio: ["pipe", "pipe", stderr ?? "inherit"]`.
      // Left to default, the server's stderr streams straight to our terminal and
      // smears the Ink TUI frame. Pipe it so `createMcpConnection` can drain (and
      // optionally forward) it instead of letting it reach the screen.
      stderr: "pipe",
    })
  }
  const url = validateMcpRemoteEgress(String(cfg.url ?? ""), cfg.allowPrivateNetwork === true)
  const headers =
    cfg.headers && typeof cfg.headers === "object"
      ? (cfg.headers as Record<string, string>)
      : undefined
  const transportOpts: Record<string, unknown> = {}
  // Redirects are denied so Authorization cannot be forwarded to an unreviewed host.
  transportOpts.requestInit = { ...(headers ? { headers } : {}), redirect: "error" }
  if (opts.authProvider) transportOpts.authProvider = opts.authProvider
  if (opts.fetch) {
    transportOpts.fetch = opts.fetch
    if (server.transport === "sse") transportOpts.eventSourceInit = { fetch: opts.fetch }
  }
  const Ctor = server.transport === "sse" ? ctors.Sse : ctors.Http
  return new Ctor(url, transportOpts)
}

/** Lazily load the SDK client + transport classes. */
async function loadSdk(): Promise<{
  Client: new (info: { name: string; version: string }, opts: McpClientOptions) => McpClientLike
  ctors: McpTransportCtors
  elicitRequestSchema: unknown
}> {
  const [
    { Client, StreamableHTTPClientTransport, SSEClientTransport },
    { StdioClientTransport },
    core,
  ] = await Promise.all([
    import("@modelcontextprotocol/client"),
    import("@modelcontextprotocol/client/stdio"),
    import("@modelcontextprotocol/core"),
  ])
  return {
    Client: Client as never,
    ctors: {
      Stdio: StdioClientTransport as never,
      Http: StreamableHTTPClientTransport as never,
      Sse: SSEClientTransport as never,
    },
    elicitRequestSchema: core.ElicitRequestSchema,
  }
}

export interface OpenMcpDeps {
  /** Override the SDK loader (tests). */
  load?: typeof loadSdk
  resolveConfig?: typeof resolveMcpSecrets
  createEgressGuard?: (allowPrivateNetwork: boolean) => Promise<McpEgressGuard>
}

async function createDefaultEgressGuard(allowPrivateNetwork: boolean): Promise<McpEgressGuard> {
  const { createEgressGuard } = await import("../../sidecar/mcp-oauth-helper.mjs")
  return createEgressGuard({ allowPrivateNetwork }) as McpEgressGuard
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
  opts: OpenMcpOptions = {},
  deps: OpenMcpDeps = {}
): Promise<{
  client: McpClientLike
  transport: OpenedMcp["transport"]
  closeEgressGuard?: () => Promise<void>
}> {
  const policy = evaluateMcpPolicy({
    server,
    surface: opts.surface ?? "cli",
    interactive: opts.interactive ?? false,
    grant: opts.grant,
    toolName: opts.toolName,
    fingerprint: opts.fingerprint,
  })
  if (policy.decision !== "allow") {
    throw new Error(`MCP execution ${policy.decision}: ${policy.reason}`)
  }
  const effectiveServer = hasMcpSecretRefs(server.config)
    ? {
        ...server,
        config: (await (deps.resolveConfig ?? resolveMcpSecrets)(server.config)) as never,
      }
    : server
  const { Client, ctors, elicitRequestSchema } = await (deps.load ?? loadSdk)()
  const info = opts.clientInfo ?? DEFAULT_CLIENT_INFO
  const onCapabilitiesChanged = opts.onCapabilitiesChanged ?? opts.onToolsChanged
  const listChanged = onCapabilitiesChanged
    ? Object.fromEntries(
        ["tools", "resources", "prompts"].map((kind) => [
          kind,
          {
            autoRefresh: true,
            debounceMs: 100,
            onChanged: (error: Error | null) => {
              if (!error) void onCapabilitiesChanged()
            },
          },
        ])
      )
    : undefined
  const client = new Client(
    { name: info.name, version: info.version },
    {
      capabilities: opts.onElicitation ? { elicitation: { form: {}, url: {} } } : {},
      versionNegotiation: { mode: "auto", probe: { timeoutMs: 3_000, maxRetries: 0 } },
      supportedProtocolVersions: [...COGNIA_MCP_PROTOCOL_VERSIONS],
      inputRequired: { autoFulfill: true, maxRounds: 8 },
      listMaxPages: 64,
      defaultCacheTtlMs: 0,
      cachePartition: opts.fingerprint ?? server.id,
      ...(listChanged ? { listChanged: listChanged as McpClientOptions["listChanged"] } : {}),
    }
  )
  if (opts.onElicitation && client.setRequestHandler) {
    const endpoint =
      server.transport === "stdio"
        ? undefined
        : String((server.config as unknown as Record<string, unknown>).url ?? "")
    client.setRequestHandler(elicitRequestSchema, async (request) =>
      opts.onElicitation!(
        createMcpElicitationRequest(request, {
          serverId: server.id,
          serverName: server.name,
          ...(endpoint ? { endpoint } : {}),
        })
      )
    )
  }
  const remote = effectiveServer.transport !== "stdio"
  const allowPrivateNetwork =
    remote &&
    (effectiveServer.config as unknown as Record<string, unknown>).allowPrivateNetwork === true
  const egressGuard = remote
    ? await (deps.createEgressGuard ?? createDefaultEgressGuard)(allowPrivateNetwork)
    : undefined
  let transport: OpenedMcp["transport"]
  try {
    transport = buildMcpTransport(effectiveServer, ctors, {
      authProvider: opts.authProvider,
      fetch: egressGuard?.fetch,
    }) as OpenedMcp["transport"]
  } catch (error) {
    await egressGuard?.close().catch(() => undefined)
    throw error
  }
  // Capture the stdio child's stderr away from the terminal. The SDK exposes the
  // piped stream immediately (a PassThrough built in its ctor), so this attaches
  // before connect and never misses the child's startup diagnostics.
  drainStderr(transport, opts.onStderr)
  return {
    client,
    transport,
    closeEgressGuard: egressGuard ? () => egressGuard.close() : undefined,
  }
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
  const { client, transport, closeEgressGuard } = await createMcpConnection(server, opts, deps)

  let closed = false
  const closeResources = async () => {
    if (closed) return
    closed = true
    await client.close().catch(() => undefined)
    await closeEgressGuard?.().catch(() => undefined)
  }
  const onAbort = () => void closeResources()
  if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true })
  try {
    await client.connect(transport)
  } catch (err) {
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort)
    await closeResources()
    throw err
  }
  return {
    client,
    transport,
    negotiatedProtocolVersion: client.getNegotiatedProtocolVersion?.(),
    protocolEra: client.getProtocolEra?.(),
    close: async () => {
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort)
      await closeResources()
    },
  }
}
