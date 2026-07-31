/**
 * Ollama API client.
 *
 * Every call goes over HTTP through `proxyFetch`. There is deliberately no
 * `invoke("ollama_*")` path: those commands never existed on the Rust side
 * (a search for "ollama" across all 543 `.rs` files returns nothing), so the
 * branches that called them threw "Command not found" on every desktop run.
 * They were invisible because the tests never simulated a Tauri host, so the
 * suite only ever exercised the browser fallback.
 *
 * `proxyFetch` is what makes the HTTP path work in the packaged shell: the
 * renderer's CSP (`connect-src 'self' ipc: http://ipc.localhost ws: wss:`)
 * has no `http:` scheme, so a bare `fetch` to `http://localhost:11434` is
 * blocked before it leaves the WebView — loopback is not `'self'`. The host
 * installs a `proxyFetch` that tunnels through the Rust `proxy_http_request`
 * command, where reqwest is bound by neither CSP nor CORS. Adding eight Rust
 * commands to re-enable `invoke` would buy nothing `proxy_http_request`
 * already does, at eight commands' worth of upkeep.
 *
 * The one thing the proxy genuinely cannot carry is a stream: it returns a
 * buffered `body: String`. `/api/pull` is NDJSON, so it has its own transport
 * — see `pullOllamaModel`.
 */

import type {
  OllamaModel,
  OllamaServerStatus,
  OllamaPullProgress,
  OllamaRunningModel,
  OllamaModelInfo,
  OllamaModelCapabilities,
  OllamaCapability,
} from "@cognia/provider-types/ollama"
import { pullOllamaModelStreaming } from "./ollama-pull"
import { proxyFetch } from "./runtime-adapters"

/**
 * Default Ollama base URL
 */
export const DEFAULT_OLLAMA_URL = "http://localhost:11434"

/**
 * Get Ollama server status
 */
export async function getOllamaStatus(
  baseUrl: string = DEFAULT_OLLAMA_URL
): Promise<OllamaServerStatus> {
  try {
    const url = normalizeBaseUrl(baseUrl)

    // Try to get version
    let version: string | undefined
    try {
      const versionResp = await proxyFetch(`${url}/api/version`)
      if (versionResp.ok) {
        const data = await versionResp.json()
        version = data.version
      }
    } catch {
      // Version endpoint might not exist in older versions
    }

    // Get models count
    const tagsResp = await proxyFetch(`${url}/api/tags`)
    if (tagsResp.ok) {
      const data = await tagsResp.json()
      return {
        connected: true,
        version,
        models_count: data.models?.length || 0,
      }
    }

    return { connected: false, models_count: 0 }
  } catch {
    return { connected: false, models_count: 0 }
  }
}

/**
 * List all installed Ollama models
 */
export async function listOllamaModels(
  baseUrl: string = DEFAULT_OLLAMA_URL
): Promise<OllamaModel[]> {
  const url = normalizeBaseUrl(baseUrl)
  const response = await proxyFetch(`${url}/api/tags`)

  if (!response.ok) {
    throw new Error(`Failed to list models: ${response.status}`)
  }

  const data = await response.json()
  return data.models || []
}

/**
 * Get detailed info about a specific model
 */
export async function showOllamaModel(
  baseUrl: string,
  modelName: string
): Promise<OllamaModelInfo> {
  const url = normalizeBaseUrl(baseUrl)
  const response = await proxyFetch(`${url}/api/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: modelName }),
  })

  if (!response.ok) {
    throw new Error(`Failed to show model: ${response.status}`)
  }

  return response.json()
}

/**
 * Pull/download a model from Ollama registry.
 *
 * `/api/pull` is NDJSON, so this is the one call that cannot ride `proxyFetch`
 * (buffered body) — see `./ollama-pull` for the per-host transport and for why
 * the returned `unsubscribe` cannot actually stop the download.
 */
export async function pullOllamaModel(
  baseUrl: string,
  modelName: string,
  onProgress?: (progress: OllamaPullProgress) => void
): Promise<{ success: boolean; unsubscribe: () => void }> {
  return pullOllamaModelStreaming({ baseUrl, modelName, onProgress })
}

/**
 * Delete a model from Ollama
 */
export async function deleteOllamaModel(baseUrl: string, modelName: string): Promise<boolean> {
  const url = normalizeBaseUrl(baseUrl)
  const response = await proxyFetch(`${url}/api/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: modelName }),
  })

  if (!response.ok) {
    throw new Error(`Failed to delete model: ${response.status}`)
  }

  return true
}

/**
 * List currently running/loaded models
 */
export async function listRunningModels(
  baseUrl: string = DEFAULT_OLLAMA_URL
): Promise<OllamaRunningModel[]> {
  const url = normalizeBaseUrl(baseUrl)
  const response = await proxyFetch(`${url}/api/ps`)

  if (!response.ok) {
    throw new Error(`Failed to list running models: ${response.status}`)
  }

  const data = await response.json()
  return data.models || []
}

/**
 * Copy a model to create a new one
 */
export async function copyOllamaModel(
  baseUrl: string,
  source: string,
  destination: string
): Promise<boolean> {
  const url = normalizeBaseUrl(baseUrl)
  const response = await proxyFetch(`${url}/api/copy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, destination }),
  })

  if (!response.ok) {
    throw new Error(`Failed to copy model: ${response.status}`)
  }

  return true
}

/** Options accepted by `/api/embed`. All verified against the upstream `EmbedRequest`. */
export interface OllamaEmbedOptions {
  /** Truncate input past the context window instead of erroring. Server default: true. */
  truncate?: boolean
  /** Matryoshka truncation — shorten output vectors. Only some models honor it. */
  dimensions?: number
  /** How long to keep the model loaded after this call, e.g. "5m". */
  keepAlive?: string
}

/** POST `/api/embed` and return its always-2-D `embeddings`. */
async function postOllamaEmbed(
  baseUrl: string,
  model: string,
  input: string | string[],
  options?: OllamaEmbedOptions
): Promise<number[][]> {
  const url = `${normalizeBaseUrl(baseUrl)}/api/embed`

  const body: Record<string, unknown> = { model, input }
  if (options?.truncate !== undefined) body.truncate = options.truncate
  if (options?.dimensions !== undefined) body.dimensions = options.dimensions
  if (options?.keepAlive !== undefined) body.keep_alive = options.keepAlive

  let response: Response
  try {
    response = await proxyFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new Error(`Ollama embedding request failed (url=${url}): ${detail}`)
  }

  if (!response.ok) {
    let bodyText = ""
    try {
      bodyText = await response.text()
    } catch {
      // ignore — surface only the status
    }
    throw new Error(
      `Ollama embedding HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}: ${bodyText}`
    )
  }

  let data: { embedding?: number[]; embeddings?: number[][] }
  try {
    data = await response.json()
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new Error(`Ollama embedding response was not valid JSON: ${detail}`)
  }

  if (
    Array.isArray(data.embeddings) &&
    data.embeddings.length > 0 &&
    Array.isArray(data.embeddings[0])
  ) {
    return data.embeddings
  }
  // Tolerate the deprecated 1-D `embedding` shape: a server old enough to lack
  // /api/embed may route the path to its legacy handler.
  if (Array.isArray(data.embedding) && data.embedding.length > 0) {
    return [data.embedding]
  }
  throw new Error("Ollama embedding response is missing an 'embedding' / 'embeddings' field")
}

/**
 * Generate an embedding for a single text.
 *
 * Uses `/api/embed`, not the deprecated `/api/embeddings`. The two differ in
 * both directions: request field `input` (string OR array) vs `prompt` (string
 * only), and response field `embeddings` (always 2-D) vs `embedding` (1-D).
 * For more than one text use `generateOllamaEmbeddings` — it sends ONE request
 * instead of N.
 */
export async function generateOllamaEmbedding(
  baseUrl: string,
  model: string,
  input: string,
  options?: OllamaEmbedOptions
): Promise<number[]> {
  if (!baseUrl) throw new Error("baseURL is required")
  if (!model) throw new Error("modelId is required")

  const embeddings = await postOllamaEmbed(baseUrl, model, input, options)
  if (!embeddings[0]?.length) {
    throw new Error("Ollama embedding response is missing an 'embedding' / 'embeddings' field")
  }
  return embeddings[0]
}

/**
 * Generate embeddings for many texts in ONE request.
 *
 * `/api/embed`'s `input` takes an array natively. The previous approach looped
 * the single-text call, paying a full HTTP round-trip per text — on a few
 * hundred RAG chunks that is the difference between one request and a few
 * hundred sequential ones.
 *
 * Returns vectors positionally aligned with `texts`. An empty `texts` short-
 * circuits without a request.
 */
export async function generateOllamaEmbeddings(
  baseUrl: string,
  model: string,
  texts: string[],
  options?: OllamaEmbedOptions
): Promise<number[][]> {
  if (!baseUrl) throw new Error("baseURL is required")
  if (!model) throw new Error("modelId is required")
  if (texts.length === 0) return []

  const embeddings = await postOllamaEmbed(baseUrl, model, texts, options)

  // A short array would silently misalign every downstream vector with the
  // wrong chunk — fail loudly instead.
  if (embeddings.length !== texts.length) {
    throw new Error(
      `Ollama returned ${embeddings.length} embeddings for ${texts.length} inputs — refusing to misalign them`
    )
  }
  return embeddings
}

/**
 * Stop/unload a running model
 */
export async function stopOllamaModel(baseUrl: string, modelName: string): Promise<boolean> {
  const url = normalizeBaseUrl(baseUrl)
  const response = await proxyFetch(`${url}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelName, keep_alive: 0 }),
  })

  if (!response.ok) {
    throw new Error(`Failed to stop model: ${response.status}`)
  }

  return true
}

/**
 * Normalize base URL - remove trailing slash and /v1 suffix
 */
function normalizeBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, "")
  if (url.endsWith("/v1")) {
    url = url.slice(0, -3)
  }
  return url
}

/**
 * Check if a model name is an embedding model
 */
export function isOllamaEmbeddingModel(modelName: string): boolean {
  const embeddingKeywords = ["embed", "embedding", "nomic", "mxbai", "bge", "minilm"]
  const lowerName = modelName.toLowerCase()
  return embeddingKeywords.some((keyword) => lowerName.includes(keyword))
}

/**
 * Guess capabilities from a model's NAME.
 *
 * A guess, and named like one. `llava`/`vision` substring matching misses
 * every vision model not called that (qwen2.5-vl, moondream, minicpm-v, …) and
 * has no idea about tools or thinking. Prefer `probeOllamaModelCapabilities`,
 * which asks the server. This remains only as the fallback for a server too old
 * to report `capabilities`, and its results are marked `inferred: true` so
 * callers can tell a guess from a fact.
 */
export function getOllamaModelCapabilities(modelName: string): OllamaModelCapabilities {
  const lowerName = modelName.toLowerCase()
  const isEmbedding = isOllamaEmbeddingModel(modelName)

  return {
    supportsVision: lowerName.includes("llava") || lowerName.includes("vision"),
    supportsTools: !isEmbedding,
    supportsEmbedding: isEmbedding,
    supportsThinking: false,
    inferred: true,
  }
}

/**
 * Read the REAL context length out of `/api/show`'s `model_info`.
 *
 * The key is architecture-prefixed — `llama.context_length`,
 * `qwen2.context_length`, `gemma4.context_length` — because Ollama's own GGUF
 * reader prepends `general.architecture` to any key outside the `general.` and
 * `tokenizer.` namespaces. Hardcoding `llama.` therefore returns undefined on
 * every Gemma/Qwen/DeepSeek model, silently, which is worse than not asking.
 */
function readContextLength(modelInfo: Record<string, unknown> | undefined): {
  contextLength?: number
  architecture?: string
} {
  if (!modelInfo) return {}

  const architecture =
    typeof modelInfo["general.architecture"] === "string"
      ? (modelInfo["general.architecture"] as string)
      : undefined
  if (!architecture) return {}

  const raw = modelInfo[`${architecture}.context_length`]
  const contextLength = typeof raw === "number" && raw > 0 ? raw : undefined

  return { contextLength, architecture }
}

/**
 * Ask the server what a model can do, instead of guessing from its name.
 *
 * Falls back to `getOllamaModelCapabilities` (and flags `inferred: true`) when
 * the server reports no `capabilities` array — either an older Ollama, or a
 * failed request. Never throws: capability probing is decoration on top of a
 * model list, and a failed probe must not take the list down with it.
 */
export async function probeOllamaModelCapabilities(
  baseUrl: string,
  modelName: string
): Promise<OllamaModelCapabilities> {
  let info: OllamaModelInfo
  try {
    info = await showOllamaModel(baseUrl, modelName)
  } catch {
    return getOllamaModelCapabilities(modelName)
  }

  const { contextLength, architecture } = readContextLength(info.model_info)

  // An empty array is a real answer ("this model does nothing we track"); only
  // an absent one means the server cannot tell us and we must guess.
  if (!Array.isArray(info.capabilities)) {
    return { ...getOllamaModelCapabilities(modelName), contextLength, architecture }
  }

  const has = (capability: OllamaCapability) => info.capabilities!.includes(capability)

  return {
    // `image` and `vision` are distinct upstream capabilities; either means the
    // model takes images in.
    supportsVision: has("vision") || has("image"),
    supportsTools: has("tools"),
    supportsEmbedding: has("embedding"),
    supportsThinking: has("thinking"),
    contextLength,
    architecture,
    inferred: false,
  }
}
