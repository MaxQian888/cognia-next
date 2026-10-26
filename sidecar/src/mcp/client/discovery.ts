import type { MCPClientConfig } from "@ai-sdk/mcp"
import type { EgressGuard } from "../../platform/net/egress-guard.ts"
import type { McpServerEntry, StdioTransportConstructor } from "./types.ts"
interface ListParams {
  params?: { cursor?: string }
  options: object
}
interface DiscoveredTool {
  name: string
  description?: string
  inputSchema?: unknown
  outputSchema?: unknown
  _meta?: Record<string, unknown>
}
interface DiscoveredResource {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}
interface DiscoveredPrompt {
  name: string
  description?: string
  arguments?: unknown[]
}
interface DiscoveryClient {
  /** Negotiated server capabilities; absent on test doubles and older clients. */
  readonly initializeResult?: { capabilities?: Record<string, unknown> }
  listTools(options: ListParams): Promise<{ tools: DiscoveredTool[]; nextCursor?: string }>
  listResources(
    options: ListParams
  ): Promise<{ resources: DiscoveredResource[]; nextCursor?: string }>
  experimental_listPrompts(
    options: ListParams
  ): Promise<{ prompts: DiscoveredPrompt[]; nextCursor?: string }>
  close(): Promise<unknown>
}
interface DiscoveryOptions {
  signal?: AbortSignal
  timeoutMs?: number
  createClient?: (config: MCPClientConfig) => Promise<DiscoveryClient>
  createEgressGuard?: (options: { allowPrivateNetwork: boolean }) => EgressGuard
  StdioTransport?: StdioTransportConstructor
}
interface DiscoveryServer {
  transport: string
  config: McpServerEntry
}
import { createMCPClient } from "@ai-sdk/mcp"

import { createEgressGuard as createDefaultEgressGuard } from "../../platform/net/egress-guard.ts"
import { toMcpTransport } from "./tools.ts"

const DEFAULT_TIMEOUT_MS = 15_000
/** Upper bound on pages per list; a server that keeps paging past it is broken. */
const MAX_LIST_PAGES = 100

type Capability = "tools" | "resources" | "prompts"

function isMethodNotFound(error: unknown) {
  if (!error || typeof error !== "object") return false
  const failure = error as { code?: unknown; data?: { code?: unknown }; message?: string }
  return (
    failure.code === -32601 ||
    failure.data?.code === -32601 ||
    /method not found/i.test(failure.message ?? "")
  )
}

/** The AI SDK client rejects locally, before sending, for undeclared capabilities. */
function isUndeclaredCapability(error: unknown, capability: Capability) {
  if (!error || typeof error !== "object") return false
  const message = (error as { message?: unknown }).message
  return typeof message === "string" && message === `Server does not support ${capability}`
}

/**
 * Whether the server declared `capability` during initialization. `undefined`
 * means the client did not expose the negotiated capabilities, so the list is
 * attempted and an unsupported answer is treated as an empty capability.
 */
function declaredCapability(client: DiscoveryClient, capability: Capability): boolean | undefined {
  const capabilities = client.initializeResult?.capabilities
  if (!capabilities || typeof capabilities !== "object") return undefined
  const value = capabilities[capability]
  return value !== undefined && value !== null && value !== false
}

/**
 * Lists one capability to exhaustion, following `nextCursor` (MCP pagination)
 * with a bounded loop. A capability the server never declared is an empty
 * list, not a failure: tools, resources and prompts are each optional.
 */
async function listAll<T>(
  client: DiscoveryClient,
  capability: Capability,
  page: (params: ListParams["params"]) => Promise<{ items: T[]; nextCursor?: string }>
): Promise<T[]> {
  if (declaredCapability(client, capability) === false) return []
  const items: T[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let index = 0; index < MAX_LIST_PAGES; index += 1) {
    let result: { items: T[]; nextCursor?: string }
    try {
      result = await page(cursor === undefined ? undefined : { cursor })
    } catch (error) {
      if (index === 0 && (isMethodNotFound(error) || isUndeclaredCapability(error, capability))) {
        return []
      }
      throw error
    }
    items.push(...result.items)
    const next = result.nextCursor
    if (typeof next !== "string") return items
    if (seen.has(next)) {
      throw new Error(`MCP ${capability} pagination repeated cursor ${JSON.stringify(next)}`)
    }
    seen.add(next)
    cursor = next
  }
  throw new Error(`MCP ${capability} pagination exceeded ${MAX_LIST_PAGES} pages`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizePromptArguments(value: unknown) {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((argument) => {
    if (!isRecord(argument) || typeof argument.name !== "string") return []
    return [
      {
        name: argument.name,
        ...(typeof argument.description === "string" ? { description: argument.description } : {}),
        ...(typeof argument.required === "boolean" ? { required: argument.required } : {}),
      },
    ]
  })
}

function normalizeServer(server: DiscoveryServer): McpServerEntry {
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
  server: DiscoveryServer,
  {
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    createClient = createMCPClient,
    createEgressGuard = createDefaultEgressGuard,
    StdioTransport,
  }: DiscoveryOptions = {}
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

  let client: DiscoveryClient | undefined
  try {
    client = await createClient({
      transport,
      initializationOptions: { timeout: timeoutMs, ...(signal ? { signal } : {}) },
      maxRetries: 0,
      clientName: "cognia-runtime-gateway",
      version: "1.0.0",
    })
    const connected = client
    const options = { timeout: timeoutMs, ...(signal ? { signal } : {}) }
    const [rawTools, rawResources, rawPrompts] = await Promise.all([
      listAll(connected, "tools", async (params) => {
        const result = await connected.listTools({ ...(params ? { params } : {}), options })
        return { items: result?.tools ?? [], nextCursor: result?.nextCursor }
      }),
      listAll(connected, "resources", async (params) => {
        const result = await connected.listResources({ ...(params ? { params } : {}), options })
        return { items: result?.resources ?? [], nextCursor: result?.nextCursor }
      }),
      listAll(connected, "prompts", async (params) => {
        const result = await connected.experimental_listPrompts({
          ...(params ? { params } : {}),
          options,
        })
        return { items: result?.prompts ?? [], nextCursor: result?.nextCursor }
      }),
    ])
    // Keep what downstream consumers read from the capability cache: `_meta`
    // links a tool to its MCP App (`_meta.ui.resourceUri`), `outputSchema`
    // describes structured results, and prompt `arguments` drive prompt forms.
    const tools = rawTools.map((tool) => ({
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      ...(isRecord(tool.outputSchema) ? { outputSchema: tool.outputSchema } : {}),
      ...(isRecord(tool._meta) ? { _meta: tool._meta } : {}),
    }))
    const resources = rawResources.map((resource) => ({
      uri: resource.uri,
      ...(typeof resource.name === "string" ? { name: resource.name } : {}),
      ...(typeof resource.description === "string" ? { description: resource.description } : {}),
      ...(typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}),
    }))
    const prompts = rawPrompts.map((prompt) => {
      const promptArguments = normalizePromptArguments(prompt.arguments)
      return {
        name: prompt.name,
        ...(typeof prompt.description === "string" ? { description: prompt.description } : {}),
        ...(promptArguments ? { arguments: promptArguments } : {}),
      }
    })
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
