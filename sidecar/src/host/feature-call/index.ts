import type {
  LanguageModelV2CallOptions,
  LanguageModelV3CallOptions,
  LanguageModelV4CallOptions,
  EmbeddingModelV3CallOptions,
} from "@ai-sdk/provider"
import type { ModelSettings } from "../../providers/protocol-adapters/ai-sdk-adapter.ts"
import type {
  AdapterCredentials,
  NormalizedRequest,
  ProtocolAdapter,
} from "../../providers/protocol-adapters/types.ts"
import type { ProtocolExecChannel } from "../../providers/protocol-adapters/code-adapter.ts"
import type { ToolHostInput, ToolHostOptions } from "../../mcp/servers/tool-host.ts"

type ModelCallOptions =
  LanguageModelV2CallOptions | LanguageModelV3CallOptions | LanguageModelV4CallOptions
export interface FeatureCallMessage {
  type?: string
  requestId?: string
  operation: string
  model?: string
  providerId?: string
  credentials?: AdapterCredentials
  options?: Partial<ModelCallOptions> & Partial<EmbeddingModelV3CallOptions>
  toolHost?: ToolHostInput
  mcpServer?: Parameters<typeof defaultDiscoverMcpServer>[0] & { id?: string; name?: string }
  protocolAdapterSpec?: unknown
}
export interface FeatureModel {
  doGenerate?(options: Partial<ModelCallOptions>): PromiseLike<unknown>
  doStream?(options: Partial<ModelCallOptions>): PromiseLike<{ stream: ReadableStream<unknown> }>
}
interface EmbeddingModel {
  doEmbed(options: Partial<EmbeddingModelV3CallOptions>): PromiseLike<unknown>
}
interface ServiceDescriptor {
  url: string
  [key: string]: unknown
}
export interface ServiceDiscovery {
  Service: {
    discover(options: {
      version: (version: unknown) => boolean
    }): Promise<ServiceDescriptor | null | undefined>
    headers(descriptor: ServiceDescriptor): Record<string, string> | undefined
  }
}
export interface FeatureCallOptions {
  emit: (message: object) => void
  hostRpc?: ToolHostOptions["hostRpc"]
  buildModel?: (settings: ModelSettings) => Promise<FeatureModel | undefined>
  buildEmbeddingModel?: (message: FeatureCallMessage) => Promise<EmbeddingModel>
  discoverOpenCodeV2?: (options: { signal?: AbortSignal }) => Promise<unknown>
  discoverMcpServer?: typeof defaultDiscoverMcpServer
  resolveProtocolAdapter?: typeof defaultResolveProtocolAdapter
}
import { buildModel as defaultBuildModel } from "../../providers/protocol-adapters/ai-sdk-adapter.ts"
import { resolveAdapter as defaultResolveProtocolAdapter } from "../../providers/protocol-adapters/registry.ts"
import { buildBedrockProviderOptions, discoverBedrockModels } from "../../providers/bedrock.ts"
import { discoverMcpServer as defaultDiscoverMcpServer } from "../../mcp/client/discovery.ts"
import { toLanguageModelUsage } from "../../providers/usage-normalize.ts"
import { createToolHostManager } from "../../mcp/servers/tool-host.ts"

function modelInput(message: FeatureCallMessage): ModelSettings {
  const credentials = message.credentials ?? {}
  return {
    protocol: credentials.protocol ?? "bedrock",
    model: message.model!,
    apiKey: credentials.apiKey,
    baseURL: credentials.baseURL,
    headers: credentials.headers,
    apiFlavor: credentials.apiFlavor,
    providerId: message.providerId ?? "bedrock",
    bedrockAuthMode: credentials.bedrockAuthMode,
    region: credentials.region,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    profile: credentials.profile,
    roleArn: credentials.roleArn,
    roleSessionName: credentials.roleSessionName,
  }
}

function bedrockSettings(credentials: Partial<ModelSettings> = {}) {
  return {
    authMode: credentials.bedrockAuthMode ?? (credentials.apiKey ? "api-key" : "default-chain"),
    region: credentials.region,
    apiKey: credentials.apiKey,
    baseURL: credentials.baseURL,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    profile: credentials.profile,
    roleArn: credentials.roleArn,
    roleSessionName: credentials.roleSessionName,
  }
}

async function defaultBuildEmbeddingModel(message: FeatureCallMessage) {
  const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock")
  const provider = createAmazonBedrock(
    await buildBedrockProviderOptions(bedrockSettings(message.credentials))
  )
  return provider.embedding(message.model!)
}

async function loadOpenCodeService() {
  return import("@opencode/client/service")
}

function isOpenCodeV2Version(version: unknown) {
  return typeof version === "string" && /^2\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(version)
}

export async function discoverOpenCodeV2Service({
  loadService = loadOpenCodeService,
  fetchImpl = fetch,
  signal,
}: {
  loadService?: () => Promise<ServiceDiscovery>
  fetchImpl?: (
    input: string | URL | Request,
    init: RequestInit
  ) => Promise<Pick<Response, "ok" | "json">>
  signal?: AbortSignal
} = {}) {
  signal?.throwIfAborted()
  const { Service } = await loadService()
  signal?.throwIfAborted()
  // The current service API has no signal option; it bounds its own health probe.
  const discovered = await Service.discover({ version: isOpenCodeV2Version })
  signal?.throwIfAborted()
  if (!discovered) {
    throw new Error(
      "No compatible OpenCode V2 service was discovered. Start one with `opencode service start`."
    )
  }
  const endpoint = new URL(discovered.url)
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("OpenCode V2 discovery returned a non-HTTP endpoint")
  }
  const rawHeaders = Service.headers(discovered)
  const headers = Object.fromEntries(
    Object.entries(rawHeaders ?? {}).filter(
      ([name, value]) => name.trim() && typeof value === "string"
    )
  )
  const statusResponse = await fetchImpl(new URL("/api/info", endpoint), {
    headers,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(2_000)])
      : AbortSignal.timeout(2_000),
  })
  const rawStatus: unknown = await statusResponse.json().catch(() => undefined)
  const status =
    rawStatus && typeof rawStatus === "object" ? (rawStatus as Record<string, unknown>) : {}
  signal?.throwIfAborted()
  if (!statusResponse.ok) {
    throw new Error("OpenCode V2 discovery health probe failed")
  }
  if (
    !isOpenCodeV2Version(status?.version) ||
    typeof status.pid !== "number" ||
    !Number.isInteger(status.pid) ||
    status.pid <= 0
  ) {
    throw new Error("OpenCode V2 discovery returned an incompatible health contract")
  }
  return {
    endpoint: endpoint.toString().replace(/\/$/, ""),
    version: status.version,
    headers,
  }
}

function scrubError(error: unknown, credentials: Partial<ModelSettings> = {}) {
  let message = error instanceof Error ? error.message : String(error)
  for (const key of ["apiKey", "accessKeyId", "secretAccessKey", "sessionToken"]) {
    const secret = credentials[key as keyof ModelSettings]
    if (typeof secret === "string" && secret.length > 0) {
      message = message.split(secret).join("[REDACTED]")
    }
  }
  return message
}

// The alias table this used to carry inline now lives in
// `../../providers/usage-normalize.ts` alongside the snake_case normalizer, so
// a new provider spelling is understood by both dispatch paths instead of only
// one.
const adapterUsageToLanguageModelUsage = toLanguageModelUsage

function languageModelFinishReason(value: unknown) {
  const raw = typeof value === "string" && value ? value : "stop"
  const unified =
    raw === "length" || raw === "content-filter" || raw === "tool-calls" || raw === "error"
      ? raw
      : "stop"
  return { unified, raw }
}

function adapterRequest(
  message: FeatureCallMessage,
  controller: AbortController
): NormalizedRequest {
  const { prompt = [], ...modelParams } = message.options ?? {}
  return {
    model: message.model!,
    providerId: message.providerId,
    messages: prompt as NormalizedRequest["messages"],
    modelParams,
    credentials: message.credentials ?? {},
    abortSignal: controller.signal,
  }
}

async function streamProtocolAdapter(
  adapter: ProtocolAdapter,
  request: NormalizedRequest,
  emitPart: (part: Record<string, unknown>) => void
) {
  const result = await adapter.start(request)
  let textStarted = false
  let reasoningStarted = false
  for await (const value of result.fullStream) {
    const chunk = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
    request.abortSignal?.throwIfAborted()
    if (chunk?.type === "text-delta") {
      if (!textStarted) {
        emitPart({ type: "text-start", id: "0" })
        textStarted = true
      }
      emitPart({
        type: "text-delta",
        id: "0",
        delta: chunk.text ?? chunk.textDelta ?? chunk.delta ?? "",
      })
      continue
    }
    if (chunk?.type === "reasoning-delta") {
      if (!reasoningStarted) {
        emitPart({ type: "reasoning-start", id: "r0" })
        reasoningStarted = true
      }
      emitPart({
        type: "reasoning-delta",
        id: "r0",
        delta: chunk.text ?? chunk.textDelta ?? chunk.delta ?? "",
      })
      continue
    }
    if (chunk?.type === "error") {
      throw new Error(chunk.error instanceof Error ? chunk.error.message : String(chunk.error))
    }
    if (chunk?.type === "finish") {
      if (reasoningStarted) emitPart({ type: "reasoning-end", id: "r0" })
      if (textStarted) emitPart({ type: "text-end", id: "0" })
      emitPart({
        type: "finish",
        finishReason: languageModelFinishReason(chunk.finishReason),
        usage: adapterUsageToLanguageModelUsage(chunk.usage),
        providerMetadata: chunk.providerMetadata,
      })
    }
  }
  request.abortSignal?.throwIfAborted()
}

export function createFeatureCallHandler({
  emit,
  hostRpc,
  buildModel = defaultBuildModel,
  buildEmbeddingModel = defaultBuildEmbeddingModel,
  discoverOpenCodeV2 = discoverOpenCodeV2Service,
  discoverMcpServer = defaultDiscoverMcpServer,
  resolveProtocolAdapter = defaultResolveProtocolAdapter,
}: FeatureCallOptions) {
  const active = new Map<
    string,
    {
      controller: AbortController
      pendingProtocolExecs: Map<string, ProtocolExecChannel>
      sessionId: string
    }
  >()
  const toolHosts = createToolHostManager({ emit, hostRpc })

  async function call(message: FeatureCallMessage) {
    const { requestId, operation } = message
    if (!requestId || active.has(requestId)) {
      emit({
        type: "feature_call_error",
        requestId: requestId ?? "",
        error: requestId ? "duplicate feature call request id" : "missing feature call request id",
      })
      return
    }
    const controller = new AbortController()
    const pendingProtocolExecs = new Map<string, ProtocolExecChannel>()
    const sessionId = `feature:${requestId}`
    active.set(requestId, { controller, pendingProtocolExecs, sessionId })
    try {
      if (operation.startsWith("tool-host-")) {
        const actions: Record<string, "start" | "stop" | "reply" | undefined> = {
          "tool-host-start": "start",
          "tool-host-stop": "stop",
          "tool-host-reply": "reply",
        }
        const action = actions[operation]
        if (!action) throw new Error(`unsupported feature call operation: ${operation}`)
        const onAbort = () => void toolHosts.stop(message.toolHost!)
        controller.signal.addEventListener("abort", onAbort, { once: true })
        try {
          const result = await toolHosts[action](message.toolHost!)
          controller.signal.throwIfAborted()
          emit({ type: "feature_call_result", requestId, result })
        } finally {
          controller.signal.removeEventListener("abort", onAbort)
        }
        return
      }
      if (operation === "bedrock-discover") {
        const models = await discoverBedrockModels(bedrockSettings(message.credentials))
        emit({ type: "feature_call_result", requestId, result: { models } })
        return
      }

      if (operation === "opencode-v2-discover") {
        const result = await discoverOpenCodeV2({ signal: controller.signal })
        controller.signal.throwIfAborted()
        emit({ type: "feature_call_result", requestId, result })
        return
      }

      if (operation === "mcp-discover") {
        const result = await discoverMcpServer(message.mcpServer!, {
          signal: controller.signal,
        })
        emit({ type: "feature_call_result", requestId, result })
        return
      }

      if (operation === "embedding") {
        const model = await buildEmbeddingModel(message)
        const result = await model.doEmbed({
          ...(message.options ?? {}),
          abortSignal: controller.signal,
        })
        emit({ type: "feature_call_result", requestId, result })
        return
      }

      if (operation === "language-stream") {
        if (message.protocolAdapterSpec) {
          const adapter = resolveProtocolAdapter(
            message.credentials?.protocol,
            message.protocolAdapterSpec,
            {
              emit,
              sessionId,
              pendingProtocolExecs,
              onCancel: (execId, reason) =>
                emit({ type: "protocol_adapter_cancel", sessionId, execId, reason }),
            }
          )
          if (!adapter) {
            throw new Error(
              `no resolvable protocol adapter for ${message.credentials?.protocol ?? "unknown"}`
            )
          }
          await streamProtocolAdapter(adapter, adapterRequest(message, controller), (part) => {
            emit({ type: "feature_call_stream", requestId, part })
          })
          emit({ type: "feature_call_stream_end", requestId })
          return
        }
      }

      const model = await buildModel(modelInput(message))
      controller.signal.throwIfAborted()
      const options = {
        ...(message.options ?? {}),
        abortSignal: controller.signal,
      }
      if (operation === "language-generate") {
        const result = await model!.doGenerate!(options)
        emit({ type: "feature_call_result", requestId, result })
        return
      }
      if (operation === "language-stream") {
        const result = await model!.doStream!(options)
        const reader = result.stream.getReader()
        try {
          while (true) {
            const next = await reader.read()
            if (next.done) break
            emit({ type: "feature_call_stream", requestId, part: next.value })
          }
        } finally {
          reader.releaseLock()
        }
        emit({ type: "feature_call_stream_end", requestId })
        return
      }
      throw new Error(`unsupported feature call operation: ${operation}`)
    } catch (error) {
      if (controller.signal.aborted) {
        emit({ type: "feature_call_aborted", requestId })
      } else {
        emit({
          type: "feature_call_error",
          requestId,
          error: scrubError(error, message.credentials),
        })
      }
    } finally {
      active.delete(requestId)
    }
  }

  function abort(requestId?: string) {
    const entry = active.get(requestId!)
    if (!entry) return false
    entry.controller.abort(new DOMException("Feature call aborted", "AbortError"))
    for (const [execId, channel] of entry.pendingProtocolExecs) {
      entry.pendingProtocolExecs.delete(execId)
      channel.cancel("aborted")
    }
    return true
  }

  function handleProtocolAdapterMessage(message: {
    type?: string
    sessionId?: unknown
    execId?: string
    chunk?: unknown
    usage?: unknown
    error?: unknown
  }) {
    if (typeof message?.sessionId !== "string" || !message.sessionId.startsWith("feature:")) {
      return false
    }
    const requestId = message.sessionId.slice("feature:".length)
    const entry = active.get(requestId!)
    const channel = entry?.pendingProtocolExecs.get(message.execId!)
    if (!channel) return false
    if (message.type === "protocol_adapter_chunk") {
      channel.push(message.chunk)
    } else if (message.type === "protocol_adapter_done") {
      channel.finish(message.usage)
      entry!.pendingProtocolExecs.delete(message.execId!)
    } else if (message.type === "protocol_adapter_error") {
      channel.fail(message.error ?? "protocol adapter error")
      entry!.pendingProtocolExecs.delete(message.execId!)
    } else {
      return false
    }
    return true
  }

  return {
    call,
    abort,
    handleProtocolAdapterMessage,
    activeCount: () => active.size,
    close: () => toolHosts.close(),
  }
}
