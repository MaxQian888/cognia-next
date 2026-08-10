import {
  OllamaModelCapabilities,
  OllamaServerStatus,
  OllamaModel,
  OllamaRunningModel,
  OllamaPullProgress,
  OllamaModelInfo,
} from "@cognia/provider-types/ollama"

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

/**
 * Default Ollama base URL
 */
declare const DEFAULT_OLLAMA_URL = "http://localhost:11434"
/**
 * Get Ollama server status
 */
declare function getOllamaStatus(baseUrl?: string): Promise<OllamaServerStatus>
/**
 * List all installed Ollama models
 */
declare function listOllamaModels(baseUrl?: string): Promise<OllamaModel[]>
/**
 * Get detailed info about a specific model
 */
declare function showOllamaModel(baseUrl: string, modelName: string): Promise<OllamaModelInfo>
/**
 * Pull/download a model from Ollama registry.
 *
 * `/api/pull` is NDJSON, so this is the one call that cannot ride `proxyFetch`
 * (buffered body) — see `./ollama-pull` for the per-host transport and for why
 * the returned `unsubscribe` cannot actually stop the download.
 */
declare function pullOllamaModel(
  baseUrl: string,
  modelName: string,
  onProgress?: (progress: OllamaPullProgress) => void
): Promise<{
  success: boolean
  unsubscribe: () => void
}>
/**
 * Delete a model from Ollama
 */
declare function deleteOllamaModel(baseUrl: string, modelName: string): Promise<boolean>
/**
 * List currently running/loaded models
 */
declare function listRunningModels(baseUrl?: string): Promise<OllamaRunningModel[]>
/**
 * Copy a model to create a new one
 */
declare function copyOllamaModel(
  baseUrl: string,
  source: string,
  destination: string
): Promise<boolean>
/** Options accepted by `/api/embed`. All verified against the upstream `EmbedRequest`. */
interface OllamaEmbedOptions {
  /** Truncate input past the context window instead of erroring. Server default: true. */
  truncate?: boolean
  /** Matryoshka truncation — shorten output vectors. Only some models honor it. */
  dimensions?: number
  /** How long to keep the model loaded after this call, e.g. "5m". */
  keepAlive?: string
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
declare function generateOllamaEmbedding(
  baseUrl: string,
  model: string,
  input: string,
  options?: OllamaEmbedOptions
): Promise<number[]>
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
declare function generateOllamaEmbeddings(
  baseUrl: string,
  model: string,
  texts: string[],
  options?: OllamaEmbedOptions
): Promise<number[][]>
/**
 * Stop/unload a running model
 */
declare function stopOllamaModel(baseUrl: string, modelName: string): Promise<boolean>
/**
 * Check if a model name is an embedding model
 */
declare function isOllamaEmbeddingModel(modelName: string): boolean
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
declare function getOllamaModelCapabilities(modelName: string): OllamaModelCapabilities
/**
 * Ask the server what a model can do, instead of guessing from its name.
 *
 * Falls back to `getOllamaModelCapabilities` (and flags `inferred: true`) when
 * the server reports no `capabilities` array — either an older Ollama, or a
 * failed request. Never throws: capability probing is decoration on top of a
 * model list, and a failed probe must not take the list down with it.
 */
declare function probeOllamaModelCapabilities(
  baseUrl: string,
  modelName: string
): Promise<OllamaModelCapabilities>

export {
  DEFAULT_OLLAMA_URL,
  type OllamaEmbedOptions,
  copyOllamaModel,
  deleteOllamaModel,
  generateOllamaEmbedding,
  generateOllamaEmbeddings,
  getOllamaModelCapabilities,
  getOllamaStatus,
  isOllamaEmbeddingModel,
  listOllamaModels,
  listRunningModels,
  probeOllamaModelCapabilities,
  pullOllamaModel,
  showOllamaModel,
  stopOllamaModel,
}
