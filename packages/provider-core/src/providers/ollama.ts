/**
 * Ollama API client - wraps Tauri commands with browser fallback
 */

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type {
  OllamaModel,
  OllamaServerStatus,
  OllamaPullProgress,
  OllamaRunningModel,
  OllamaModelInfo,
} from "@cognia/provider-types/ollama"
import { isTauri, proxyFetch } from "./runtime-adapters"

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
  if (isTauri()) {
    return invoke<OllamaServerStatus>("ollama_get_status", { baseUrl })
  }

  // Browser fallback
  try {
    const url = normalizeBaseUrl(baseUrl)

    // Try to get version
    let version: string | undefined
    try {
      const versionResp = await fetch(`${url}/api/version`)
      if (versionResp.ok) {
        const data = await versionResp.json()
        version = data.version
      }
    } catch {
      // Version endpoint might not exist in older versions
    }

    // Get models count
    const tagsResp = await fetch(`${url}/api/tags`)
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
  if (isTauri()) {
    return invoke<OllamaModel[]>("ollama_list_models", { baseUrl })
  }

  // Browser fallback
  const url = normalizeBaseUrl(baseUrl)
  const response = await fetch(`${url}/api/tags`)

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
  if (isTauri()) {
    return invoke<OllamaModelInfo>("ollama_show_model", { baseUrl, modelName })
  }

  // Browser fallback
  const url = normalizeBaseUrl(baseUrl)
  const response = await fetch(`${url}/api/show`, {
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
 * Pull/download a model from Ollama registry
 * Returns an unsubscribe function to stop listening to progress
 */
export async function pullOllamaModel(
  baseUrl: string,
  modelName: string,
  onProgress?: (progress: OllamaPullProgress) => void
): Promise<{ success: boolean; unsubscribe: () => void }> {
  let unlisten: UnlistenFn | undefined

  if (isTauri()) {
    // Listen for progress events
    if (onProgress) {
      unlisten = await listen<OllamaPullProgress>("ollama-pull-progress", (event) => {
        if (event.payload.model === modelName) {
          onProgress(event.payload)
        }
      })
    }

    try {
      const success = await invoke<boolean>("ollama_pull_model", { baseUrl, modelName })
      return {
        success,
        unsubscribe: () => unlisten?.(),
      }
    } catch (error) {
      unlisten?.()
      throw error
    }
  }

  // Browser fallback - streaming pull
  const url = normalizeBaseUrl(baseUrl)
  const response = await fetch(`${url}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: modelName, stream: true }),
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
            const progress = JSON.parse(line) as OllamaPullProgress
            progress.model = modelName
            onProgress?.(progress)
          } catch {
            // Ignore parse errors
          }
        }
      }
    }
  }

  await processStream()

  return {
    success: true,
    unsubscribe: () => {},
  }
}

/**
 * Delete a model from Ollama
 */
export async function deleteOllamaModel(baseUrl: string, modelName: string): Promise<boolean> {
  if (isTauri()) {
    return invoke<boolean>("ollama_delete_model", { baseUrl, modelName })
  }

  // Browser fallback
  const url = normalizeBaseUrl(baseUrl)
  const response = await fetch(`${url}/api/delete`, {
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
  if (isTauri()) {
    return invoke<OllamaRunningModel[]>("ollama_list_running", { baseUrl })
  }

  // Browser fallback
  const url = normalizeBaseUrl(baseUrl)
  const response = await fetch(`${url}/api/ps`)

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
  if (isTauri()) {
    return invoke<boolean>("ollama_copy_model", { baseUrl, source, destination })
  }

  // Browser fallback
  const url = normalizeBaseUrl(baseUrl)
  const response = await fetch(`${url}/api/copy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, destination }),
  })

  if (!response.ok) {
    throw new Error(`Failed to copy model: ${response.status}`)
  }

  return true
}

/**
 * Generate embeddings using Ollama
 */
export async function generateOllamaEmbedding(
  baseUrl: string,
  model: string,
  input: string
): Promise<number[]> {
  if (!baseUrl) throw new Error("baseURL is required")
  if (!model) throw new Error("modelId is required")

  if (isTauri()) {
    return invoke<number[]>("ollama_generate_embedding", { baseUrl, model, input })
  }

  const url = `${normalizeBaseUrl(baseUrl)}/api/embeddings`
  let response: Response
  try {
    response = await proxyFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: input }),
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

  if (Array.isArray(data.embedding) && data.embedding.length > 0) {
    return data.embedding
  }
  if (
    Array.isArray(data.embeddings) &&
    data.embeddings.length > 0 &&
    Array.isArray(data.embeddings[0]) &&
    data.embeddings[0].length > 0
  ) {
    return data.embeddings[0]
  }
  throw new Error("Ollama embedding response is missing an 'embedding' / 'embeddings' field")
}

/**
 * Stop/unload a running model
 */
export async function stopOllamaModel(baseUrl: string, modelName: string): Promise<boolean> {
  if (isTauri()) {
    return invoke<boolean>("ollama_stop_model", { baseUrl, modelName })
  }

  // Browser fallback - send generate with keep_alive: 0
  const url = normalizeBaseUrl(baseUrl)
  const response = await fetch(`${url}/api/generate`, {
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
 * Get model capabilities based on name
 */
export function getOllamaModelCapabilities(modelName: string): {
  supportsVision: boolean
  supportsTools: boolean
  supportsEmbedding: boolean
} {
  const lowerName = modelName.toLowerCase()

  return {
    supportsVision: lowerName.includes("llava") || lowerName.includes("vision"),
    supportsTools: !isOllamaEmbeddingModel(modelName),
    supportsEmbedding: isOllamaEmbeddingModel(modelName),
  }
}
