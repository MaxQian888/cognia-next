/**
 * Local Provider Service - Unified abstraction for all local inference engines
 *
 * Provides common patterns for:
 * - Connection testing and health checks
 * - Model listing and management
 * - Installation detection
 * - Configuration management
 *
 * Every request goes through `proxyFetch`, never a bare `fetch`. In the
 * packaged desktop shell the renderer's CSP (`connect-src 'self' ipc:
 * http://ipc.localhost ws: wss:`) carries no `http:` scheme, so a direct
 * `fetch` to a local inference server on `127.0.0.1` is blocked before it
 * leaves the WebView — loopback is not `'self'`. `proxyFetch` tunnels through
 * the Rust `proxy_http_request` command, which reqwest serves free of CSP and
 * CORS. `pnpm dev` has no CSP, which is why this surface looked healthy in
 * development while being dead in the shipped app.
 *
 * The `invoke("ollama_*")` / `invoke("local_provider_*")` branches that used to
 * front these calls are gone: no such Rust command has ever existed. They were
 * wrapped in `try/catch`, so instead of failing loudly they fell through to the
 * HTTP path on every single desktop run — which the CSP then blocked. Two dead
 * layers stacked into one silent failure.
 */

import type {
  LocalProviderName,
  LocalServerStatus,
  LocalModelInfo,
  LocalModelPullProgress,
} from "@cognia/provider-types/local-provider"
import {
  LOCAL_PROVIDER_CONFIGS,
  normalizeBaseUrl,
  type LocalProviderConfig,
} from "./local-providers"
import { validateStaticHeaders } from "@cognia/provider-types/transport-header-policy"
import { pullOllamaModelStreaming } from "./ollama-pull"
import { proxyFetch } from "./runtime-adapters"

/**
 * Local provider capabilities
 */
export interface LocalProviderCapabilities {
  canListModels: boolean
  canPullModels: boolean
  canDeleteModels: boolean
  canStopModels: boolean
  canGenerateEmbeddings: boolean
  supportsStreaming: boolean
  supportsVision: boolean
  supportsTools: boolean
}

/**
 * Provider installation info
 */
export interface LocalProviderInstallInfo {
  installed: boolean
  version?: string
  installPath?: string
  configPath?: string
  dataPath?: string
  executable?: string
}

/**
 * Installation check result.
 *
 * These come from an HTTP probe, which is strictly weaker than an installation
 * check. A responding server proves the provider is both installed and running.
 * SILENCE PROVES NOTHING: "not installed", "installed but not started" and
 * "started on a different port" are indistinguishable from the outside. So
 * `installed` is deliberately tri-state — `undefined` means "unknown", never
 * "absent". Reporting `false` there would be a claim the probe cannot support.
 */
export interface InstallCheckResult {
  providerId: LocalProviderName
  /** `true` when the server answered; `undefined` when unreachable (unknown, NOT absent). */
  installed?: boolean
  running: boolean
  version?: string
  error?: string
}

/**
 * Model pull options
 */
export interface ModelPullOptions {
  onProgress?: (progress: LocalModelPullProgress) => void
  signal?: AbortSignal
}

export interface LocalProviderRequestOptions {
  baseUrl?: string
  apiKey?: string
  customHeaders?: Record<string, string>
}

export type LocalProviderRequestErrorCode =
  "authentication_failed" | "http_error" | "invalid_headers" | "invalid_response" | "network_error"

export class LocalProviderRequestError extends Error {
  constructor(
    readonly code: LocalProviderRequestErrorCode,
    message: string,
    readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "LocalProviderRequestError"
  }
}

type LocalProviderConstructorInput = string | LocalProviderRequestOptions | undefined

function waitForDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
  }

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeoutId)
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
    }
    const timeoutId = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function normalizeModels(models: LocalModelInfo[]): LocalModelInfo[] {
  const byId = new Map<string, LocalModelInfo>()
  for (const model of models) {
    const id = model.id.trim()
    if (!id || byId.has(id)) continue
    byId.set(id, { ...model, id })
  }
  return [...byId.values()]
}

/**
 * Get provider capabilities based on provider type
 */
export function getProviderCapabilities(providerId: LocalProviderName): LocalProviderCapabilities {
  const capabilities: Record<LocalProviderName, LocalProviderCapabilities> = {
    ollama: {
      canListModels: true,
      canPullModels: true,
      canDeleteModels: true,
      canStopModels: true,
      canGenerateEmbeddings: true,
      supportsStreaming: true,
      supportsVision: true,
      supportsTools: true,
    },
    lmstudio: {
      canListModels: true,
      canPullModels: false,
      canDeleteModels: false,
      canStopModels: false,
      canGenerateEmbeddings: true,
      supportsStreaming: true,
      supportsVision: true,
      supportsTools: true,
    },
    llamacpp: {
      canListModels: true,
      canPullModels: false,
      canDeleteModels: false,
      canStopModels: false,
      canGenerateEmbeddings: true,
      supportsStreaming: true,
      supportsVision: true,
      supportsTools: false,
    },
    llamafile: {
      canListModels: true,
      canPullModels: false,
      canDeleteModels: false,
      canStopModels: false,
      canGenerateEmbeddings: false,
      supportsStreaming: true,
      supportsVision: false,
      supportsTools: false,
    },
    vllm: {
      canListModels: true,
      canPullModels: false,
      canDeleteModels: false,
      canStopModels: false,
      canGenerateEmbeddings: true,
      supportsStreaming: true,
      supportsVision: true,
      supportsTools: true,
    },
    localai: {
      canListModels: true,
      canPullModels: true,
      canDeleteModels: false,
      canStopModels: true,
      canGenerateEmbeddings: true,
      supportsStreaming: true,
      supportsVision: true,
      supportsTools: true,
    },
    jan: {
      canListModels: true,
      canPullModels: false,
      canDeleteModels: false,
      canStopModels: false,
      canGenerateEmbeddings: true,
      supportsStreaming: true,
      supportsVision: false,
      supportsTools: false,
    },
    textgenwebui: {
      canListModels: true,
      canPullModels: false,
      canDeleteModels: false,
      canStopModels: false,
      canGenerateEmbeddings: false,
      supportsStreaming: true,
      supportsVision: false,
      supportsTools: false,
    },
    koboldcpp: {
      canListModels: true,
      canPullModels: false,
      canDeleteModels: false,
      canStopModels: false,
      canGenerateEmbeddings: false,
      supportsStreaming: true,
      supportsVision: false,
      supportsTools: false,
    },
    tabbyapi: {
      canListModels: true,
      canPullModels: false,
      canDeleteModels: false,
      canStopModels: false,
      canGenerateEmbeddings: false,
      supportsStreaming: true,
      supportsVision: false,
      supportsTools: false,
    },
  }

  return (
    capabilities[providerId] || {
      canListModels: true,
      canPullModels: false,
      canDeleteModels: false,
      canStopModels: false,
      canGenerateEmbeddings: false,
      supportsStreaming: true,
      supportsVision: false,
      supportsTools: false,
    }
  )
}

/**
 * Unified Local Provider Service
 */
export class LocalProviderService {
  private providerId: LocalProviderName
  private config: LocalProviderConfig
  private baseUrl: string
  private apiKey?: string
  private customHeaders?: Record<string, string>
  private capabilities: LocalProviderCapabilities

  constructor(providerId: LocalProviderName, input?: LocalProviderConstructorInput) {
    this.providerId = providerId
    this.config = LOCAL_PROVIDER_CONFIGS[providerId]
    const options =
      typeof input === "string"
        ? ({ baseUrl: input } satisfies LocalProviderRequestOptions)
        : (input ?? {})
    this.baseUrl = normalizeBaseUrl(options.baseUrl || this.config.defaultBaseURL)
    this.apiKey = options.apiKey?.trim() || undefined
    const headerViolations = validateStaticHeaders(options.customHeaders)
    if (headerViolations.length > 0) {
      const details = headerViolations.map(({ name, reason }) => `${name}: ${reason}`).join(", ")
      throw new LocalProviderRequestError("invalid_headers", `Invalid custom headers (${details})`)
    }
    this.customHeaders = options.customHeaders
    this.capabilities = getProviderCapabilities(providerId)
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      ...(this.customHeaders ?? {}),
      ...(extra ?? {}),
    }

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`
    }

    return headers
  }

  private createHttpError(status: number): LocalProviderRequestError {
    if (status === 401 || status === 403) {
      return new LocalProviderRequestError(
        "authentication_failed",
        `Authentication failed (HTTP ${status})`,
        status
      )
    }
    return new LocalProviderRequestError("http_error", `HTTP ${status}`, status)
  }

  /**
   * Get provider ID
   */
  getId(): LocalProviderName {
    return this.providerId
  }

  /**
   * Get provider config
   */
  getConfig(): LocalProviderConfig {
    return this.config
  }

  /**
   * Get capabilities
   */
  getCapabilities(): LocalProviderCapabilities {
    return this.capabilities
  }

  /**
   * Check server status
   */
  async getStatus(): Promise<LocalServerStatus> {
    const startTime = Date.now()

    // Generic HTTP health check
    try {
      const healthUrl = `${this.baseUrl}${this.config.healthEndpoint}`
      const response = await proxyFetch(healthUrl, {
        method: "GET",
        headers: this.buildHeaders(),
        timeout: 5000,
      })

      if (response.ok) {
        const data = await response.json().catch(() => ({}))
        return {
          connected: true,
          version: data.version || data.build?.version,
          models_count: Array.isArray(data.models)
            ? data.models.length
            : Array.isArray(data.data)
              ? data.data.length
              : undefined,
          latency_ms: Date.now() - startTime,
        }
      }

      return {
        connected: false,
        error: this.createHttpError(response.status).message,
        latency_ms: Date.now() - startTime,
      }
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : "Connection failed",
        latency_ms: Date.now() - startTime,
      }
    }
  }

  /**
   * List available models
   */
  async listModels(): Promise<LocalModelInfo[]> {
    if (!this.capabilities.canListModels) {
      return []
    }

    // Generic HTTP model listing
    try {
      const modelsUrl = `${this.baseUrl}${this.config.modelsEndpoint}`

      const response = await proxyFetch(modelsUrl, {
        method: "GET",
        headers: this.buildHeaders(),
        timeout: 10000,
      })

      if (!response.ok) {
        throw this.createHttpError(response.status)
      }

      let data: unknown
      try {
        data = await response.json()
      } catch (error) {
        throw new LocalProviderRequestError(
          "invalid_response",
          "Invalid model list response",
          undefined,
          { cause: error }
        )
      }

      if (!data || typeof data !== "object") {
        throw new LocalProviderRequestError("invalid_response", "Invalid model list response")
      }

      const payload = data as {
        models?: Array<{ name?: string; model?: string; size?: number }>
        data?: Array<{ id?: string; object?: string; created?: number; owned_by?: string }>
      }

      // Handle Ollama format
      if (Array.isArray(payload.models)) {
        return normalizeModels(
          payload.models.map((model) => ({
            id: model.name || model.model || "",
            object: "model",
            size: model.size,
          }))
        )
      }

      // Handle OpenAI format
      if (Array.isArray(payload.data)) {
        return normalizeModels(
          payload.data.map((model) => ({
            id: model.id || "",
            object: model.object || "model",
            ...(model.created === undefined ? {} : { created: model.created }),
            ...(model.owned_by === undefined ? {} : { owned_by: model.owned_by }),
          }))
        )
      }

      throw new LocalProviderRequestError("invalid_response", "Invalid model list response")
    } catch (error) {
      if (error instanceof LocalProviderRequestError) throw error
      throw new LocalProviderRequestError(
        "network_error",
        error instanceof Error ? error.message : "Failed to list models",
        undefined,
        error instanceof Error ? { cause: error } : undefined
      )
    }
  }

  /**
   * Pull/download a model (Ollama, LocalAI, Jan)
   */
  async pullModel(
    modelName: string,
    options?: ModelPullOptions
  ): Promise<{ success: boolean; unsubscribe: () => void }> {
    if (!this.capabilities.canPullModels) {
      return { success: false, unsubscribe: () => {} }
    }

    if (this.providerId === "localai") {
      return this.pullLocalAIModel(modelName, options)
    }

    if (this.providerId !== "ollama") return { success: false, unsubscribe: () => {} }

    return pullOllamaModelStreaming({
      baseUrl: this.baseUrl,
      modelName,
      apiKey: this.apiKey,
      customHeaders: this.customHeaders,
      onProgress: options?.onProgress,
      signal: options?.signal,
    })
  }

  private async pullLocalAIModel(
    modelName: string,
    options?: ModelPullOptions
  ): Promise<{ success: boolean; unsubscribe: () => void }> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    options?.signal?.addEventListener("abort", abort, { once: true })

    try {
      if (options?.signal?.aborted) controller.abort()
      const applyResponse = await proxyFetch(`${this.baseUrl}/models/apply`, {
        method: "POST",
        headers: this.buildHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ id: modelName }),
        signal: controller.signal,
      })
      if (!applyResponse.ok) {
        throw new Error(`Failed to install model: ${applyResponse.status}`)
      }

      const applyResult = (await applyResponse.json()) as { uuid?: string }
      if (!applyResult.uuid) {
        throw new Error("LocalAI did not return a model installation job id")
      }

      options?.onProgress?.({ model: modelName, status: "queued", percentage: 0 })
      const jobUrl = `${this.baseUrl}/models/jobs/${encodeURIComponent(applyResult.uuid)}`

      while (true) {
        const jobResponse = await proxyFetch(jobUrl, {
          method: "GET",
          headers: this.buildHeaders(),
          signal: controller.signal,
        })
        if (!jobResponse.ok) {
          throw new Error(`Failed to read model installation job: ${jobResponse.status}`)
        }

        const job = (await jobResponse.json()) as {
          processed?: boolean
          error?: string | null
          message?: string
          phase?: string
        }
        const status = job.phase || job.message || (job.processed ? "completed" : "processing")
        if (job.error) throw new Error(job.error)
        if (job.processed) {
          options?.onProgress?.({ model: modelName, status, percentage: 100 })
          return { success: true, unsubscribe: abort }
        }

        options?.onProgress?.({ model: modelName, status })
        await waitForDelay(1000, controller.signal)
      }
    } finally {
      options?.signal?.removeEventListener("abort", abort)
    }
  }

  /**
   * Delete a model
   */
  async deleteModel(modelName: string): Promise<boolean> {
    if (!this.capabilities.canDeleteModels) {
      return false
    }

    if (this.providerId === "ollama") {
      const response = await proxyFetch(`${this.baseUrl}/api/delete`, {
        method: "DELETE",
        headers: this.buildHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ name: modelName }),
      })

      if (!response.ok) {
        throw new Error(`Failed to delete model: ${response.status}`)
      }

      return true
    }

    return false
  }

  /**
   * Stop/unload a model
   */
  async stopModel(modelName: string): Promise<boolean> {
    if (!this.capabilities.canStopModels) {
      return false
    }

    // HTTP fallback for Ollama
    if (this.providerId === "ollama") {
      const response = await proxyFetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: this.buildHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ model: modelName, keep_alive: 0 }),
      })

      return response.ok
    }

    if (this.providerId === "localai") {
      const response = await proxyFetch(`${this.baseUrl}/backend/shutdown`, {
        method: "POST",
        headers: this.buildHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ model: modelName }),
      })
      return response.ok
    }

    return false
  }

  /**
   * Generate embeddings
   */
  async generateEmbedding(model: string, input: string): Promise<number[]> {
    if (!this.capabilities.canGenerateEmbeddings) {
      throw new Error(`${this.providerId} does not support embeddings`)
    }

    // OpenAI-compatible embedding endpoint
    const response = await proxyFetch(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: this.buildHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ model, input }),
    })

    if (!response.ok) {
      throw new Error(`Failed to generate embedding: ${response.status}`)
    }

    const data = await response.json()
    return data.data?.[0]?.embedding || []
  }
}

/**
 * Check installation status for a local provider
 */
export async function checkProviderInstallation(
  providerId: LocalProviderName,
  baseUrl?: string
): Promise<InstallCheckResult> {
  // `baseUrl` must be threaded through. Omitting it silently rebuilds the
  // service on the provider's DEFAULT port, so a user who moved their server
  // (say Ollama to :11500) got a probe of :11434 and a permanent "offline".
  const service = new LocalProviderService(providerId, baseUrl)
  const status = await service.getStatus()

  return {
    providerId,
    // Reachable ⇒ provably installed. Unreachable ⇒ unknown, not absent.
    installed: status.connected ? true : undefined,
    running: status.connected,
    version: status.version,
    error: status.error,
  }
}

/**
 * Check all local providers installation status.
 *
 * `baseUrls` overrides the per-provider probe target; anything absent from the
 * map falls back to that provider's default. Callers holding user settings
 * MUST pass it — see the port note in `checkProviderInstallation`.
 */
export async function checkAllProvidersInstallation(
  baseUrls?: Partial<Record<LocalProviderName, string | undefined>>
): Promise<InstallCheckResult[]> {
  const providerIds: LocalProviderName[] = [
    "ollama",
    "lmstudio",
    "llamacpp",
    "llamafile",
    "vllm",
    "localai",
    "jan",
    "textgenwebui",
    "koboldcpp",
    "tabbyapi",
  ]

  const results = await Promise.all(
    providerIds.map((id) => checkProviderInstallation(id, baseUrls?.[id]))
  )

  return results
}

/**
 * Get installation instructions for a provider
 */
export function getInstallInstructions(providerId: LocalProviderName): {
  title: string
  steps: string[]
  downloadUrl: string
  docsUrl: string
  /** Command that starts the local server. Omitted for GUI apps that expose a server toggle. */
  serveCommand?: string
  /** Example command that fetches a first model. Omitted when models load via a GUI or auto-download. */
  modelPullCommand?: string
  /** Where to browse/download models compatible with this provider. */
  modelsUrl: string
} {
  const instructions: Record<LocalProviderName, ReturnType<typeof getInstallInstructions>> = {
    ollama: {
      title: "Install Ollama",
      steps: [
        "Download Ollama from the official website",
        "Run the installer",
        "Start Ollama with `ollama serve`",
        "Pull a model with `ollama pull llama3.2`",
      ],
      downloadUrl: "https://ollama.ai/download",
      docsUrl: "https://ollama.ai/docs",
      serveCommand: "ollama serve",
      modelPullCommand: "ollama pull llama3.2",
      modelsUrl: "https://ollama.ai/library",
    },
    lmstudio: {
      title: "Install LM Studio",
      steps: [
        "Download LM Studio from the official website",
        "Install and launch the application",
        "Download a model from the Discover tab",
        "Start the local server from the Developer tab",
      ],
      downloadUrl: "https://lmstudio.ai",
      docsUrl: "https://lmstudio.ai/docs",
      // GUI app: the server is toggled from the Developer tab, no shell command.
      modelsUrl: "https://huggingface.co/models?library=gguf",
    },
    llamacpp: {
      title: "Install llama.cpp Server",
      steps: [
        "Clone the llama.cpp repository",
        "Build with `make` or `cmake`",
        "Download a GGUF model",
        "Start server with `./llama-server -m model.gguf`",
      ],
      downloadUrl: "https://github.com/ggerganov/llama.cpp/releases",
      docsUrl: "https://github.com/ggerganov/llama.cpp/blob/master/examples/server/README.md",
      serveCommand: "./llama-server -m model.gguf",
      modelsUrl: "https://huggingface.co/models?search=gguf",
    },
    llamafile: {
      title: "Install llamafile",
      steps: [
        "Download a llamafile from the releases page",
        "Make it executable: `chmod +x model.llamafile`",
        "Run it: `./model.llamafile --server`",
      ],
      downloadUrl: "https://github.com/Mozilla-Ocho/llamafile/releases",
      docsUrl: "https://github.com/Mozilla-Ocho/llamafile",
      serveCommand: "./model.llamafile --server",
      modelsUrl: "https://huggingface.co/models?search=gguf",
    },
    vllm: {
      title: "Install vLLM",
      steps: [
        "Install with pip: `pip install vllm`",
        "Start server: `vllm serve meta-llama/Llama-3.2-3B-Instruct`",
        "Requires NVIDIA GPU with CUDA support",
      ],
      downloadUrl: "https://vllm.ai",
      docsUrl: "https://docs.vllm.ai",
      serveCommand: "vllm serve meta-llama/Llama-3.2-3B-Instruct",
      modelsUrl: "https://huggingface.co/models",
    },
    localai: {
      title: "Install LocalAI",
      steps: [
        "Download from GitHub releases or use Docker",
        "Docker: `docker run -p 8080:8080 localai/localai`",
        "Download models to the models directory",
      ],
      downloadUrl: "https://github.com/mudler/LocalAI/releases",
      docsUrl: "https://localai.io/docs",
      serveCommand: "docker run -p 8080:8080 localai/localai",
      modelsUrl: "https://localai.io/models",
    },
    jan: {
      title: "Install Jan",
      steps: [
        "Download Jan from the official website",
        "Install and launch the application",
        "Download models from the Hub",
        "Enable Local API Server in settings",
      ],
      downloadUrl: "https://jan.ai/download",
      docsUrl: "https://jan.ai/docs",
      // GUI app: the Local API Server is enabled from settings, no shell command.
      modelsUrl: "https://huggingface.co/models?library=gguf",
    },
    textgenwebui: {
      title: "Install Text Generation WebUI",
      steps: [
        "Clone the repository",
        "Run the start script for your OS",
        "Enable --api flag for OpenAI-compatible API",
      ],
      downloadUrl: "https://github.com/oobabooga/text-generation-webui",
      docsUrl: "https://github.com/oobabooga/text-generation-webui/wiki",
      // The start script is OS-specific (start_linux.sh / start_windows.bat / …).
      modelsUrl: "https://huggingface.co/models",
    },
    koboldcpp: {
      title: "Install KoboldCpp",
      steps: [
        "Download from GitHub releases",
        "Run the executable",
        "Load a GGUF model",
        "API is available automatically",
      ],
      downloadUrl: "https://github.com/LostRuins/koboldcpp/releases",
      docsUrl: "https://github.com/LostRuins/koboldcpp/wiki",
      // Prebuilt executable / GUI launcher, no canonical shell command.
      modelsUrl: "https://huggingface.co/models?search=gguf",
    },
    tabbyapi: {
      title: "Install TabbyAPI",
      steps: [
        "Clone the repository",
        "Install dependencies with pip",
        "Configure your model in config.yml",
        "Start with `python main.py`",
      ],
      downloadUrl: "https://github.com/theroyallab/tabbyAPI",
      docsUrl: "https://github.com/theroyallab/tabbyAPI/wiki",
      serveCommand: "python main.py",
      modelsUrl: "https://huggingface.co/models?search=exl2",
    },
  }

  return instructions[providerId]
}

/**
 * Create a LocalProviderService instance
 */
export function createLocalProviderService(
  providerId: LocalProviderName,
  input?: LocalProviderConstructorInput
): LocalProviderService {
  return new LocalProviderService(providerId, input)
}

export default LocalProviderService
