import { buildModel as defaultBuildModel } from "./protocol-adapters/ai-sdk-adapter.mjs"
import { resolveAdapter as defaultResolveProtocolAdapter } from "./protocol-adapters/registry.mjs"
import { buildBedrockProviderOptions, discoverBedrockModels } from "./bedrock.mjs"
import { discoverMcpServer as defaultDiscoverMcpServer } from "./mcp-runtime-gateway.mjs"

function modelInput(message) {
  const credentials = message.credentials ?? {}
  return {
    protocol: credentials.protocol ?? "bedrock",
    model: message.model,
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

function bedrockSettings(credentials = {}) {
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

async function defaultBuildEmbeddingModel(message) {
  const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock")
  const provider = createAmazonBedrock(
    await buildBedrockProviderOptions(bedrockSettings(message.credentials))
  )
  return provider.embedding(message.model)
}

async function loadOpenCodeService() {
  try {
    return await import("@opencode-ai/client/service")
  } catch (error) {
    if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED" && error?.code !== "ERR_MODULE_NOT_FOUND") {
      throw error
    }
    const clientEntry = import.meta.resolve("@opencode-ai/client")
    return import(new URL("./service.js", clientEntry))
  }
}

export async function discoverOpenCodeV2Service({
  loadService = loadOpenCodeService,
  fetchImpl = fetch,
} = {}) {
  const { Service } = await loadService()
  const discovered = await Service.discover()
  if (!discovered) {
    throw new Error(
      "No compatible OpenCode V2 service was discovered. Start one with `opencode2 service start`."
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
  const healthResponse = await fetchImpl(new URL("/api/health", endpoint), {
    headers,
    signal: AbortSignal.timeout(2_000),
  })
  const health = await healthResponse.json().catch(() => undefined)
  if (!healthResponse.ok) {
    throw new Error("OpenCode V2 discovery health probe failed")
  }
  if (
    typeof health?.version !== "string" ||
    !health.version.trim() ||
    typeof health.pid !== "number"
  ) {
    throw new Error("OpenCode V2 discovery returned an incompatible health contract")
  }
  return {
    endpoint: endpoint.toString().replace(/\/$/, ""),
    version: health.version,
    headers,
  }
}

function scrubError(error, credentials = {}) {
  let message = error instanceof Error ? error.message : String(error)
  for (const key of ["apiKey", "accessKeyId", "secretAccessKey", "sessionToken"]) {
    const secret = credentials[key]
    if (typeof secret === "string" && secret.length > 0) {
      message = message.split(secret).join("[REDACTED]")
    }
  }
  return message
}

function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function adapterUsageToLanguageModelUsage(usage = {}) {
  const input =
    numberOrUndefined(usage.promptTokens) ??
    numberOrUndefined(usage.inputTokens?.total) ??
    numberOrUndefined(usage.inputTokens)
  const output =
    numberOrUndefined(usage.completionTokens) ??
    numberOrUndefined(usage.outputTokens?.total) ??
    numberOrUndefined(usage.outputTokens)
  // `cachedInputTokens` / `cacheCreationInputTokens` / `reasoningTokens` are the
  // AI SDK's deprecated top-level mirrors, removed in v7 — keep them as the
  // first candidate for adapter payloads that still use those names, but fall
  // through to the canonical `*TokenDetails` objects (populated since v6) before
  // the repo's own nested shape.
  const cacheRead =
    numberOrUndefined(usage.cachedInputTokens) ??
    numberOrUndefined(usage.inputTokenDetails?.cacheReadTokens) ??
    numberOrUndefined(usage.inputTokens?.cacheRead)
  const cacheWrite =
    numberOrUndefined(usage.cacheCreationInputTokens) ??
    numberOrUndefined(usage.inputTokenDetails?.cacheWriteTokens) ??
    numberOrUndefined(usage.inputTokens?.cacheWrite)
  const reasoning =
    numberOrUndefined(usage.reasoningTokens) ??
    numberOrUndefined(usage.outputTokenDetails?.reasoningTokens) ??
    numberOrUndefined(usage.outputTokens?.reasoning)
  return {
    inputTokens: {
      total: input,
      noCache: input === undefined ? undefined : Math.max(0, input - (cacheRead ?? 0)),
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: output,
      text: output === undefined ? undefined : Math.max(0, output - (reasoning ?? 0)),
      reasoning,
    },
  }
}

function languageModelFinishReason(value) {
  const raw = typeof value === "string" && value ? value : "stop"
  const unified =
    raw === "length" || raw === "content-filter" || raw === "tool-calls" || raw === "error"
      ? raw
      : "stop"
  return { unified, raw }
}

function adapterRequest(message, controller) {
  const { prompt = [], ...modelParams } = message.options ?? {}
  return {
    model: message.model,
    providerId: message.providerId,
    messages: prompt,
    modelParams,
    credentials: message.credentials ?? {},
    abortSignal: controller.signal,
  }
}

async function streamProtocolAdapter(adapter, request, emitPart) {
  const result = await adapter.start(request)
  let textStarted = false
  let reasoningStarted = false
  for await (const chunk of result.fullStream) {
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
  buildModel = defaultBuildModel,
  buildEmbeddingModel = defaultBuildEmbeddingModel,
  discoverOpenCodeV2 = discoverOpenCodeV2Service,
  discoverMcpServer = defaultDiscoverMcpServer,
  resolveProtocolAdapter = defaultResolveProtocolAdapter,
}) {
  const active = new Map()

  async function call(message) {
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
    const pendingProtocolExecs = new Map()
    const sessionId = `feature:${requestId}`
    active.set(requestId, { controller, pendingProtocolExecs, sessionId })
    try {
      if (operation === "bedrock-discover") {
        const models = await discoverBedrockModels(bedrockSettings(message.credentials))
        emit({ type: "feature_call_result", requestId, result: { models } })
        return
      }

      if (operation === "opencode-v2-discover") {
        const result = await discoverOpenCodeV2()
        emit({ type: "feature_call_result", requestId, result })
        return
      }

      if (operation === "mcp-discover") {
        const result = await discoverMcpServer(message.mcpServer, {
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
        const result = await model.doGenerate(options)
        emit({ type: "feature_call_result", requestId, result })
        return
      }
      if (operation === "language-stream") {
        const result = await model.doStream(options)
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

  function abort(requestId) {
    const entry = active.get(requestId)
    if (!entry) return false
    entry.controller.abort(new DOMException("Feature call aborted", "AbortError"))
    for (const [execId, channel] of entry.pendingProtocolExecs) {
      entry.pendingProtocolExecs.delete(execId)
      channel.cancel("aborted")
    }
    return true
  }

  function handleProtocolAdapterMessage(message) {
    if (typeof message?.sessionId !== "string" || !message.sessionId.startsWith("feature:")) {
      return false
    }
    const requestId = message.sessionId.slice("feature:".length)
    const entry = active.get(requestId)
    const channel = entry?.pendingProtocolExecs.get(message.execId)
    if (!channel) return false
    if (message.type === "protocol_adapter_chunk") {
      channel.push(message.chunk)
    } else if (message.type === "protocol_adapter_done") {
      channel.finish(message.usage)
      entry.pendingProtocolExecs.delete(message.execId)
    } else if (message.type === "protocol_adapter_error") {
      channel.fail(message.error ?? "protocol adapter error")
      entry.pendingProtocolExecs.delete(message.execId)
    } else {
      return false
    }
    return true
  }

  return { call, abort, handleProtocolAdapterMessage, activeCount: () => active.size }
}
