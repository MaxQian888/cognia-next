import { buildModel as defaultBuildModel } from "./protocol-adapters/ai-sdk-adapter.mjs"
import { buildBedrockProviderOptions, discoverBedrockModels } from "./bedrock.mjs"

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

export function createFeatureCallHandler({
  emit,
  buildModel = defaultBuildModel,
  buildEmbeddingModel = defaultBuildEmbeddingModel,
  discoverOpenCodeV2 = discoverOpenCodeV2Service,
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
    active.set(requestId, controller)
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

      if (operation === "embedding") {
        const model = await buildEmbeddingModel(message)
        const result = await model.doEmbed({
          ...(message.options ?? {}),
          abortSignal: controller.signal,
        })
        emit({ type: "feature_call_result", requestId, result })
        return
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
    const controller = active.get(requestId)
    if (!controller) return false
    controller.abort(new DOMException("Feature call aborted", "AbortError"))
    return true
  }

  return { call, abort, activeCount: () => active.size }
}
