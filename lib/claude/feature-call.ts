import type {
  EmbeddingModelV3,
  EmbeddingModelV3CallOptions,
  EmbeddingModelV3Result,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import {
  isFeatureCallEvent,
  type ClaudeEvent,
  type FeatureCallCredentials,
  type FeatureCallEvent,
  type FeatureCallRequest,
  type McpServer,
} from "@cognia/agent-config-types"

import { appendMcpAuditLog } from "@/lib/db/mcp-audit-log"
import { resolveMcpSecrets } from "@/lib/mcp/credentials"
import { evaluateMcpPolicy } from "@/lib/mcp/policy"
import { transport } from "@/lib/tauri"

const SIDECAR_EVENT = "claude://message"

interface FeatureCallDependencies {
  call: (command: string, args?: Record<string, unknown>) => Promise<unknown>
  /**
   * Returns the unsubscribe handle, synchronously or not: the real
   * `transport.subscribe` is sync (`() => void`, see `lib/tauri/transport-types.ts`)
   * while the tests inject an async one. `ensureListener` awaits the result
   * either way, so both are correct — the union is what makes the declared
   * contract match reality.
   */
  subscribe: (
    event: string,
    handler: (event: ClaudeEvent) => void
  ) => (() => void) | Promise<() => void>
  randomUUID: () => string
}

export interface SidecarLanguageModelConfig {
  modelId: string
  providerId?: string
  credentials: FeatureCallCredentials
  protocolAdapterSpec?: FeatureCallRequest["protocolAdapterSpec"]
}

type SidecarEmbeddingModelConfig = SidecarLanguageModelConfig

interface PendingResult {
  kind: "result"
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

interface PendingStream {
  kind: "stream"
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>
}

type Pending = PendingResult | PendingStream

function serializableOptions(options: LanguageModelV3CallOptions): Record<string, unknown> {
  const { abortSignal: _abortSignal, ...rest } = options
  return rest as Record<string, unknown>
}

function abortError(): DOMException {
  return new DOMException("Feature call aborted", "AbortError")
}

export function createSidecarFeatureCallClient(deps: FeatureCallDependencies) {
  const pending = new Map<string, Pending>()
  let listener: (() => void) | Promise<() => void> | undefined

  function settle(event: FeatureCallEvent) {
    const entry = pending.get(event.requestId)
    if (!entry) return
    if (event.type === "feature_call_stream" && entry.kind === "stream") {
      entry.controller.enqueue(event.part as LanguageModelV3StreamPart)
      return
    }
    pending.delete(event.requestId)
    if (event.type === "feature_call_result" && entry.kind === "result") {
      entry.resolve(event.result as LanguageModelV3GenerateResult)
      return
    }
    if (entry.kind === "stream") {
      if (event.type === "feature_call_stream_end") entry.controller.close()
      else if (event.type === "feature_call_aborted") entry.controller.error(abortError())
      else if (event.type === "feature_call_error") entry.controller.error(new Error(event.error))
      return
    }
    if (event.type === "feature_call_aborted") entry.reject(abortError())
    else if (event.type === "feature_call_error") entry.reject(new Error(event.error))
  }

  async function ensureListener() {
    listener ??= deps.subscribe(SIDECAR_EVENT, (event) => {
      if (isFeatureCallEvent(event)) settle(event)
    })
    await listener
  }

  async function sendAbort(requestId: string) {
    await deps.call("claude_feature_abort", { requestId })
  }

  async function requestResult(
    request: Omit<FeatureCallRequest, "requestId">,
    abortSignal?: AbortSignal
  ): Promise<unknown> {
    await ensureListener()
    const requestId = deps.randomUUID()
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(requestId, { kind: "result", resolve, reject })
    })
    const onAbort = () => void sendAbort(requestId)
    abortSignal?.addEventListener("abort", onAbort, { once: true })
    try {
      await deps.call("claude_feature_call", { request: { ...request, requestId } })
      return await result
    } catch (error) {
      pending.delete(requestId)
      throw error
    } finally {
      abortSignal?.removeEventListener("abort", onAbort)
    }
  }

  function languageModel(config: SidecarLanguageModelConfig): LanguageModelV3 {
    const base = {
      specificationVersion: "v3" as const,
      provider: "amazon-bedrock.sidecar",
      modelId: config.modelId,
      supportedUrls: {},
    }

    return {
      ...base,
      async doGenerate(options) {
        const request: Omit<FeatureCallRequest, "requestId"> = {
          operation: "language-generate",
          providerId: config.providerId ?? "bedrock",
          model: config.modelId,
          credentials: config.credentials,
          ...(config.protocolAdapterSpec
            ? { protocolAdapterSpec: config.protocolAdapterSpec }
            : {}),
          options: serializableOptions(options),
        }
        return (await requestResult(request, options.abortSignal)) as LanguageModelV3GenerateResult
      },
      async doStream(options) {
        await ensureListener()
        const requestId = deps.randomUUID()
        const stream = new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            pending.set(requestId, { kind: "stream", controller })
          },
          cancel() {
            pending.delete(requestId)
            return sendAbort(requestId)
          },
        })
        const onAbort = () => {
          void sendAbort(requestId)
        }
        options.abortSignal?.addEventListener("abort", onAbort, { once: true })
        const request: FeatureCallRequest = {
          requestId,
          operation: "language-stream",
          providerId: config.providerId ?? "bedrock",
          model: config.modelId,
          credentials: config.credentials,
          ...(config.protocolAdapterSpec
            ? { protocolAdapterSpec: config.protocolAdapterSpec }
            : {}),
          options: serializableOptions(options),
        }
        try {
          await deps.call("claude_feature_call", { request })
        } catch (error) {
          const entry = pending.get(requestId)
          pending.delete(requestId)
          if (entry?.kind === "stream") entry.controller.error(error)
          throw error
        }
        return { stream }
      },
    }
  }

  function embeddingModel(config: SidecarEmbeddingModelConfig): EmbeddingModelV3 {
    return {
      specificationVersion: "v3",
      provider: "amazon-bedrock.sidecar",
      modelId: config.modelId,
      maxEmbeddingsPerCall: undefined,
      supportsParallelCalls: true,
      async doEmbed(options: EmbeddingModelV3CallOptions): Promise<EmbeddingModelV3Result> {
        return (await requestResult(
          {
            operation: "embedding",
            providerId: config.providerId ?? "bedrock",
            model: config.modelId,
            credentials: config.credentials,
            options: options as unknown as Record<string, unknown>,
          },
          options.abortSignal
        )) as EmbeddingModelV3Result
      },
    }
  }

  return { languageModel, embeddingModel, requestResult }
}

const defaultClient = createSidecarFeatureCallClient({
  call: (command, args) => transport.call(command, args),
  subscribe: (event, handler) => transport.subscribe(event, handler),
  randomUUID: () => crypto.randomUUID(),
})

export function createBedrockSidecarLanguageModel(
  config: SidecarLanguageModelConfig
): LanguageModelV3 {
  return defaultClient.languageModel(config)
}

/** Generic sidecar-backed model used by provider diagnostics for real streaming. */
export function createSidecarLanguageModel(config: SidecarLanguageModelConfig): LanguageModelV3 {
  return defaultClient.languageModel(config)
}

export function createBedrockSidecarEmbeddingModel(
  config: SidecarEmbeddingModelConfig
): EmbeddingModelV3 {
  return defaultClient.embeddingModel(config)
}

export function createSidecarEmbeddingModel(config: SidecarEmbeddingModelConfig): EmbeddingModelV3 {
  return defaultClient.embeddingModel(config)
}

export interface BedrockDiscoveredModel {
  id: string
  name?: string
  provider?: string
  supportsVision?: boolean
  supportsStreaming?: boolean
}

export async function discoverBedrockModelsViaSidecar(
  credentials: FeatureCallCredentials,
  abortSignal?: AbortSignal
): Promise<BedrockDiscoveredModel[]> {
  const result = (await defaultClient.requestResult(
    {
      operation: "bedrock-discover",
      providerId: "bedrock",
      credentials,
    },
    abortSignal
  )) as { models?: BedrockDiscoveredModel[] }
  return result.models ?? []
}

export interface OpenCodeV2Discovery {
  endpoint: string
  version: string
  headers: Record<string, string>
}

export function validateOpenCodeV2Discovery(result: unknown): OpenCodeV2Discovery {
  const descriptor =
    result && typeof result === "object" ? (result as Partial<OpenCodeV2Discovery>) : {}
  const endpoint = typeof descriptor.endpoint === "string" ? descriptor.endpoint : ""
  const version = typeof descriptor.version === "string" ? descriptor.version : ""
  if (!endpoint || !version) {
    throw new Error("OpenCode V2 discovery returned an invalid service descriptor")
  }
  const url = new URL(endpoint)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OpenCode V2 discovery returned an invalid endpoint")
  }
  const headers = Object.fromEntries(
    Object.entries(descriptor.headers ?? {}).filter(
      ([name, value]) => name.trim() && typeof value === "string"
    )
  )
  return { endpoint: url.toString().replace(/\/$/, ""), version, headers }
}

export async function discoverOpenCodeV2ViaSidecar(
  abortSignal?: AbortSignal
): Promise<OpenCodeV2Discovery> {
  const result = await defaultClient.requestResult(
    {
      operation: "opencode-v2-discover",
      credentials: {},
    },
    abortSignal
  )
  return validateOpenCodeV2Discovery(result)
}

export interface McpDiscoveryResult {
  ok: boolean
  toolCount: number
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>
  resources: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>
  prompts: Array<{ name: string; description?: string }>
  durationMs: number
  error?: string
}

function failedMcpDiscovery(error: unknown, startedAt: number, now = Date.now()): McpDiscoveryResult {
  return {
    ok: false,
    toolCount: 0,
    tools: [],
    resources: [],
    prompts: [],
    durationMs: now - startedAt,
    error: error instanceof Error ? error.message : String(error),
  }
}

function appendMcpAuditSafely(
  draft: Parameters<typeof appendMcpAuditLog>[0],
  append: typeof appendMcpAuditLog
): void {
  void append(draft).catch(() => undefined)
}

export interface McpDiscoveryDependencies {
  requestResult?: typeof defaultClient.requestResult
  resolveSecrets?: typeof resolveMcpSecrets
  appendAudit?: typeof appendMcpAuditLog
  now?: () => number
}

/** Resolve credentials in the host and discover through the sidecar gateway. */
export async function discoverMcpServerViaSidecar(
  server: McpServer,
  abortSignal?: AbortSignal,
  dependencies: McpDiscoveryDependencies = {}
): Promise<McpDiscoveryResult> {
  const now = dependencies.now ?? (() => Date.now())
  const requestResult = dependencies.requestResult ?? defaultClient.requestResult
  const resolveSecrets = dependencies.resolveSecrets ?? resolveMcpSecrets
  const appendAudit = dependencies.appendAudit ?? appendMcpAuditLog
  const startedAt = now()
  const policy = evaluateMcpPolicy({
    server,
    surface: "settings",
    interactive: false,
  })
  if (policy.decision !== "allow") {
    const result = failedMcpDiscovery(new Error(policy.reason), startedAt, now())
    appendMcpAuditSafely({
      ts: startedAt,
      tool: "capabilities/list",
      scope: "n/a",
      allowed: false,
      latencyMs: result.durationMs,
      direction: "outbound",
      phase: "discover",
      serverId: server.id,
      executionSurface: "settings",
      decision: policy.decision,
      durationMs: result.durationMs,
      errorCode: "policy-denied",
    }, appendAudit)
    return result
  }

  try {
    const config = await resolveSecrets(server.config)
    const result = (await requestResult(
      {
        operation: "mcp-discover",
        credentials: {},
        mcpServer: {
          id: server.id,
          name: server.name,
          transport: server.transport,
          config,
        },
      },
      abortSignal
    )) as McpDiscoveryResult
    appendMcpAuditSafely({
      ts: startedAt,
      tool: "capabilities/list",
      scope: "n/a",
      allowed: true,
      latencyMs: result.durationMs,
      direction: "outbound",
      phase: "discover",
      serverId: server.id,
      executionSurface: "settings",
      decision: "allow",
      durationMs: result.durationMs,
    }, appendAudit)
    return result
  } catch (error) {
    const result = failedMcpDiscovery(error, startedAt, now())
    appendMcpAuditSafely({
      ts: startedAt,
      tool: "capabilities/list",
      scope: "n/a",
      allowed: true,
      latencyMs: result.durationMs,
      direction: "outbound",
      phase: "discover",
      serverId: server.id,
      executionSurface: "settings",
      decision: "allow",
      durationMs: result.durationMs,
      errorCode: abortSignal?.aborted ? "aborted" : "discovery-failed",
    }, appendAudit)
    return result
  }
}
