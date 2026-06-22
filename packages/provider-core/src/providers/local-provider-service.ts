/**
 * Local Provider Service - Unified abstraction for all local inference engines
 *
 * Provides common patterns for:
 * - Connection testing and health checks
 * - Model listing and management
 * - Installation detection
 * - Configuration management
 */

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
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
import { isTauri } from "./runtime-adapters"

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
 * Installation check result
 */
export interface InstallCheckResult {
  providerId: LocalProviderName
  installed: boolean
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
      canDeleteModels: true,
      canStopModels: false,
      canGenerateEmbeddings: true,
      supportsStreaming: true,
      supportsVision: true,
      supportsTools: true,
    },
    jan: {
      canListModels: true,
      canPullModels: true,
      canDeleteModels: true,
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
  private capabilities: LocalProviderCapabilities

  constructor(providerId: LocalProviderName, baseUrl?: string) {
    this.providerId = providerId
    this.config = LOCAL_PROVIDER_CONFIGS[providerId]
    this.baseUrl = normalizeBaseUrl(baseUrl || this.config.defaultBaseURL)
    this.capabilities = getProviderCapabilities(providerId)
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

    // Use Tauri command for Ollama if available
    if (this.providerId === "ollama" && isTauri()) {
      try {
        const status = await invoke<LocalServerStatus>("ollama_get_status", {
          baseUrl: this.baseUrl,
        })
        return {
          ...status,
          latency_ms: Date.now() - startTime,
        }
      } catch {
        // Fall through to HTTP check
      }
    }

    // Use Tauri command for generic local provider if available
    if (isTauri()) {
      try {
        const status = await invoke<LocalServerStatus>("local_provider_get_status", {
          providerId: this.providerId,
          baseUrl: this.baseUrl,
        })
        return {
          ...status,
          latency_ms: Date.now() - startTime,
        }
      } catch {
        // Fall through to HTTP check
      }
    }

    // Generic HTTP health check
    try {
      const healthUrl = `${this.baseUrl}${this.config.healthEndpoint}`
      const response = await fetch(healthUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      })

      if (response.ok) {
        const data = await response.json().catch(() => ({}))
        return {
          connected: true,
          version: data.version || data.build?.version,
          models_count: data.models?.length,
          latency_ms: Date.now() - startTime,
        }
      }

      return {
        connected: false,
        error: `HTTP ${response.status}`,
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

    // Use Tauri command for Ollama if available
    if (this.providerId === "ollama" && isTauri()) {
      try {
        const models = await invoke<Array<{ name: string; model: string; size: number }>>(
          "ollama_list_models",
          {
            baseUrl: this.baseUrl,
          }
        )
        return models.map((m) => ({
          id: m.name || m.model,
          object: "model",
          size: m.size,
        }))
      } catch {
        // Fall through to HTTP
      }
    }

    // Use Tauri command for generic local provider if available
    if (isTauri()) {
      try {
        return await invoke<LocalModelInfo[]>("local_provider_list_models", {
          providerId: this.providerId,
          baseUrl: this.baseUrl,
        })
      } catch {
        // Fall through to HTTP
      }
    }

    // Generic HTTP model listing
    try {
      const modelsUrl =
        this.providerId === "ollama" ? `${this.baseUrl}/api/tags` : `${this.baseUrl}/v1/models`

      const response = await fetch(modelsUrl, {
        method: "GET",
        signal: AbortSignal.timeout(10000),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const data = await response.json()

      // Handle Ollama format
      if (data.models) {
        return data.models.map((m: { name?: string; model?: string; size?: number }) => ({
          id: m.name || m.model || "",
          object: "model",
          size: m.size,
        }))
      }

      // Handle OpenAI format
      if (data.data) {
        return data.data.map((m: { id: string; object?: string; created?: number }) => ({
          id: m.id,
          object: m.object || "model",
          created: m.created,
        }))
      }

      return []
    } catch {
      return []
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

    let unlisten: UnlistenFn | undefined

    // Use Tauri command for Ollama
    if (this.providerId === "ollama" && isTauri()) {
      if (options?.onProgress) {
        unlisten = await listen<LocalModelPullProgress>("ollama-pull-progress", (event) => {
          if (event.payload.model === modelName) {
            options.onProgress!(event.payload)
          }
        })
      }

      try {
        const success = await invoke<boolean>("ollama_pull_model", {
          baseUrl: this.baseUrl,
          modelName,
        })
        return {
          success,
          unsubscribe: () => unlisten?.(),
        }
      } catch (error) {
        unlisten?.()
        throw error
      }
    }

    // Use Tauri command for generic provider
    if (isTauri()) {
      if (options?.onProgress) {
        unlisten = await listen<LocalModelPullProgress>("local-provider-pull-progress", (event) => {
          if (event.payload.model === modelName) {
            options.onProgress!(event.payload)
          }
        })
      }

      try {
        const success = await invoke<boolean>("local_provider_pull_model", {
          providerId: this.providerId,
          baseUrl: this.baseUrl,
          modelName,
        })
        return {
          success,
          unsubscribe: () => unlisten?.(),
        }
      } catch (error) {
        unlisten?.()
        throw error
      }
    }

    // HTTP fallback for Ollama
    if (this.providerId === "ollama") {
      const response = await fetch(`${this.baseUrl}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: modelName, stream: true }),
        signal: options?.signal,
      })

      if (!response.ok) {
        throw new Error(`Failed to pull model: ${response.status}`)
      }

      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error("No response body")
      }

      const decoder = new TextDecoder()
      let buffer = ""

      const processStream = async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() || ""

          for (const line of lines) {
            if (line.trim()) {
              try {
                const progress = JSON.parse(line) as LocalModelPullProgress
                progress.model = modelName
                options?.onProgress?.(progress)
              } catch {
                // Ignore parse errors
              }
            }
          }
        }
      }

      await processStream()
      return { success: true, unsubscribe: () => {} }
    }

    return { success: false, unsubscribe: () => {} }
  }

  /**
   * Delete a model
   */
  async deleteModel(modelName: string): Promise<boolean> {
    if (!this.capabilities.canDeleteModels) {
      return false
    }

    // Use Tauri command for Ollama
    if (this.providerId === "ollama" && isTauri()) {
      return invoke<boolean>("ollama_delete_model", {
        baseUrl: this.baseUrl,
        modelName,
      })
    }

    // Use Tauri command for generic provider
    if (isTauri()) {
      try {
        return await invoke<boolean>("local_provider_delete_model", {
          providerId: this.providerId,
          baseUrl: this.baseUrl,
          modelName,
        })
      } catch {
        // Fall through to HTTP
      }
    }

    // HTTP fallback for Ollama
    if (this.providerId === "ollama") {
      const response = await fetch(`${this.baseUrl}/api/delete`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
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

    // Use Tauri command for Ollama
    if (this.providerId === "ollama" && isTauri()) {
      return invoke<boolean>("ollama_stop_model", {
        baseUrl: this.baseUrl,
        modelName,
      })
    }

    // HTTP fallback for Ollama
    if (this.providerId === "ollama") {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelName, keep_alive: 0 }),
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

    // Use Tauri command for Ollama
    if (this.providerId === "ollama" && isTauri()) {
      return invoke<number[]>("ollama_generate_embedding", {
        baseUrl: this.baseUrl,
        model,
        input,
      })
    }

    // OpenAI-compatible embedding endpoint
    const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  providerId: LocalProviderName
): Promise<InstallCheckResult> {
  if (isTauri()) {
    try {
      return await invoke<InstallCheckResult>("local_provider_check_installation", {
        providerId,
      })
    } catch {
      // Fall through to basic check
    }
  }

  // Basic check via HTTP
  const service = new LocalProviderService(providerId)
  const status = await service.getStatus()

  return {
    providerId,
    installed: status.connected,
    running: status.connected,
    version: status.version,
    error: status.error,
  }
}

/**
 * Check all local providers installation status
 */
export async function checkAllProvidersInstallation(): Promise<InstallCheckResult[]> {
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

  const results = await Promise.all(providerIds.map((id) => checkProviderInstallation(id)))

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
    },
  }

  return instructions[providerId]
}

/**
 * Create a LocalProviderService instance
 */
export function createLocalProviderService(
  providerId: LocalProviderName,
  baseUrl?: string
): LocalProviderService {
  return new LocalProviderService(providerId, baseUrl)
}

export default LocalProviderService
