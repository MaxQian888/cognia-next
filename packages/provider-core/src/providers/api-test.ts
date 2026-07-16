/**
 * API Connection Testing - Test provider API connections
 */

import { invoke } from "@tauri-apps/api/core"
import type { ApiProtocol } from "@cognia/provider-types"
import {
  getBuiltInProviderDefaultBaseURL,
  getBuiltInProviderDefaultModel,
  getBuiltInProviderProtocol,
} from "@cognia/provider-types/built-in-provider-catalog"
import { isTauri, proxyFetch } from "./runtime-adapters"

export interface ApiTestResult {
  success: boolean
  message: string
  latency_ms?: number
  model_info?: string
  outcome?: "verified" | "failed" | "limited"
  authoritative?: boolean
}

export interface ProviderConnectionProbeInput {
  providerId: string
  apiKey?: string
  baseURL?: string
  protocol?: ApiProtocol
  /** Model to probe with; defaults to the built-in catalog's default model. */
  model?: string
}

export interface ProviderConnectionProbeResult extends ApiTestResult {
  outcome: "verified" | "failed" | "limited"
  authoritative: boolean
}

// Local provider detection result
export interface LocalProviderDetectionResult {
  providerId: string
  name: string
  baseUrl: string
  isRunning: boolean
  models?: string[]
  version?: string
}

// Default configurations for local providers
export const LOCAL_PROVIDER_TEST_CONFIGS: Record<
  string,
  { url: string; name: string; healthPath: string }
> = {
  ollama: { url: "http://localhost:11434", name: "Ollama", healthPath: "/api/tags" },
  lmstudio: { url: "http://localhost:1234", name: "LM Studio", healthPath: "/v1/models" },
  llamacpp: { url: "http://localhost:8080", name: "llama.cpp", healthPath: "/health" },
  llamafile: { url: "http://localhost:8080", name: "llamafile", healthPath: "/health" },
  vllm: { url: "http://localhost:8000", name: "vLLM", healthPath: "/v1/models" },
  localai: { url: "http://localhost:8080", name: "LocalAI", healthPath: "/v1/models" },
  jan: { url: "http://localhost:1337", name: "Jan", healthPath: "/v1/models" },
  textgenwebui: { url: "http://localhost:5000", name: "Text Gen WebUI", healthPath: "/v1/models" },
  koboldcpp: { url: "http://localhost:5001", name: "KoboldCpp", healthPath: "/api/v1/model" },
  tabbyapi: { url: "http://localhost:5000", name: "TabbyAPI", healthPath: "/v1/models" },
}

/**
 * Probe model for an Anthropic-wire host when the caller names none. Only
 * correct for Anthropic itself — every third-party host (Kimi, GLM, MiniMax)
 * rejects it, so callers should pass the model they actually intend to use.
 */
const ANTHROPIC_PROBE_FALLBACK_MODEL = "claude-3-haiku-20240307"

/**
 * The Anthropic Messages API is served at `<base>/v1/messages`. Hosts publish
 * their base URL either bare (`https://api.moonshot.cn/anthropic`) or already
 * `/v1`-suffixed, so the version segment is appended only when missing —
 * posting to `<base>/messages` 404s on every Anthropic-wire host.
 */
function buildAnthropicMessagesURL(trimmedBaseUrl: string): string {
  return trimmedBaseUrl.endsWith("/v1")
    ? `${trimmedBaseUrl}/messages`
    : `${trimmedBaseUrl}/v1/messages`
}

export async function testCustomProviderConnectionByProtocol(
  baseUrl: string,
  apiKey: string,
  apiProtocol: ApiProtocol = "openai",
  model?: string
): Promise<ApiTestResult> {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "")
  const start = Date.now()

  try {
    let response: Response

    if (apiProtocol === "anthropic") {
      response = await proxyFetch(buildAnthropicMessagesURL(normalizedBaseUrl), {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: model?.trim() || ANTHROPIC_PROBE_FALLBACK_MODEL,
          max_tokens: 1,
          messages: [{ role: "user", content: "test" }],
        }),
      })

      const latency = Date.now() - start
      const ok = response.ok || response.status === 400
      return {
        success: ok,
        message: ok ? "Connected successfully." : `API error: ${response.status}`,
        latency_ms: latency,
      }
    }

    if (apiProtocol === "gemini") {
      response = await proxyFetch(`${normalizedBaseUrl}/models?key=${apiKey}`)

      const latency = Date.now() - start
      if (response.ok) {
        return { success: true, message: "Connected successfully.", latency_ms: latency }
      }
      return {
        success: false,
        message: `API error: ${response.status}`,
        latency_ms: latency,
      }
    }

    response = await proxyFetch(`${normalizedBaseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    })

    const latency = Date.now() - start
    if (response.ok) {
      return { success: true, message: "Connected successfully.", latency_ms: latency }
    }
    return {
      success: false,
      message: `API error: ${response.status}`,
      latency_ms: latency,
    }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Connection failed",
    }
  }
}

/**
 * Test OpenAI API connection
 */
export async function testOpenAIConnection(
  apiKey: string,
  baseUrl?: string
): Promise<ApiTestResult> {
  if (isTauri()) {
    return invoke<ApiTestResult>("test_openai_connection", {
      apiKey,
      baseUrl,
    })
  }

  // Browser fallback - make direct API call
  try {
    const url = baseUrl || "https://api.openai.com/v1"
    const start = Date.now()
    const response = await proxyFetch(`${url}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    })
    const latency = Date.now() - start

    if (response.ok) {
      const data = await response.json()
      const modelCount = data.data?.length || 0
      return {
        success: true,
        message: `Connected successfully. ${modelCount} models available.`,
        latency_ms: latency,
        model_info: `${modelCount} models`,
      }
    } else {
      return {
        success: false,
        message: `API error: ${response.status}`,
        latency_ms: latency,
      }
    }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Connection failed",
    }
  }
}

/**
 * Test Anthropic API connection
 */
export async function testAnthropicConnection(apiKey: string): Promise<ApiTestResult> {
  if (isTauri()) {
    return invoke<ApiTestResult>("test_anthropic_connection", { apiKey })
  }

  // Browser fallback - Anthropic requires server-side due to CORS
  return {
    success: false,
    message:
      apiKey.length > 20
        ? "API key format valid. Authoritative verification requires the desktop app."
        : "Invalid API key format",
    latency_ms: 0,
    outcome: apiKey.length > 20 ? "limited" : "failed",
    authoritative: false,
  }
}

/**
 * Test Google AI API connection
 */
export async function testGoogleConnection(apiKey: string): Promise<ApiTestResult> {
  if (isTauri()) {
    return invoke<ApiTestResult>("test_google_connection", { apiKey })
  }

  try {
    const start = Date.now()
    const response = await proxyFetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    )
    const latency = Date.now() - start

    if (response.ok) {
      const data = await response.json()
      const modelCount = data.models?.length || 0
      return {
        success: true,
        message: `Connected successfully. ${modelCount} models available.`,
        latency_ms: latency,
        model_info: `${modelCount} models`,
      }
    } else {
      return {
        success: false,
        message: `API error: ${response.status}`,
        latency_ms: latency,
      }
    }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Connection failed",
    }
  }
}

/**
 * Test DeepSeek API connection
 */
export async function testDeepSeekConnection(apiKey: string): Promise<ApiTestResult> {
  if (isTauri()) {
    return invoke<ApiTestResult>("test_deepseek_connection", { apiKey })
  }

  // DeepSeek uses OpenAI-compatible API
  try {
    const start = Date.now()
    const response = await proxyFetch("https://api.deepseek.com/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    })
    const latency = Date.now() - start

    if (response.ok) {
      const data = await response.json()
      const modelCount = data.data?.length || 0
      return {
        success: true,
        message: `Connected successfully. ${modelCount} models available.`,
        latency_ms: latency,
        model_info: `${modelCount} models`,
      }
    }
    return {
      success: false,
      message: `API error: ${response.status}`,
      latency_ms: latency,
    }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Connection failed",
    }
  }
}

/**
 * Test Groq API connection
 */
export async function testGroqConnection(apiKey: string): Promise<ApiTestResult> {
  if (isTauri()) {
    return invoke<ApiTestResult>("test_groq_connection", { apiKey })
  }

  // Groq uses OpenAI-compatible API
  try {
    const start = Date.now()
    const response = await proxyFetch("https://api.groq.com/openai/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    })
    const latency = Date.now() - start

    if (response.ok) {
      const data = await response.json()
      const modelCount = data.data?.length || 0
      return {
        success: true,
        message: `Connected successfully. ${modelCount} models available.`,
        latency_ms: latency,
        model_info: `${modelCount} models`,
      }
    }
    return {
      success: false,
      message: `API error: ${response.status}`,
      latency_ms: latency,
    }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Connection failed",
    }
  }
}

/**
 * Test Mistral API connection
 */
export async function testMistralConnection(apiKey: string): Promise<ApiTestResult> {
  if (isTauri()) {
    return invoke<ApiTestResult>("test_mistral_connection", { apiKey })
  }

  // Mistral uses OpenAI-compatible API
  try {
    const start = Date.now()
    const response = await proxyFetch("https://api.mistral.ai/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    })
    const latency = Date.now() - start

    if (response.ok) {
      const data = await response.json()
      const modelCount = data.data?.length || 0
      return {
        success: true,
        message: `Connected successfully. ${modelCount} models available.`,
        latency_ms: latency,
        model_info: `${modelCount} models`,
      }
    }
    return {
      success: false,
      message: `API error: ${response.status}`,
      latency_ms: latency,
    }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Connection failed",
    }
  }
}

/**
 * Test Ollama connection
 */
export async function testOllamaConnection(baseUrl: string): Promise<ApiTestResult> {
  if (isTauri()) {
    return invoke<ApiTestResult>("test_ollama_connection", { baseUrl })
  }

  try {
    const url = baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl
    const start = Date.now()
    const response = await proxyFetch(`${url}/api/tags`)
    const latency = Date.now() - start

    if (response.ok) {
      const data = await response.json()
      const modelCount = data.models?.length || 0
      return {
        success: true,
        message: `Connected successfully. ${modelCount} local models available.`,
        latency_ms: latency,
        model_info: `${modelCount} models`,
      }
    } else {
      return {
        success: false,
        message: `Connection failed: ${response.status}`,
        latency_ms: latency,
      }
    }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Connection failed",
    }
  }
}

/**
 * Test local inference provider connection by URL (OpenAI-compatible)
 * Works for: LM Studio, llama.cpp, llamafile, vLLM, LocalAI, Jan, etc.
 */
export async function testLocalProviderConnectionByUrl(
  baseUrl: string,
  providerName: string = "Local"
): Promise<ApiTestResult> {
  try {
    // Normalize the URL
    let url = baseUrl.trim().replace(/\/+$/, "")
    if (!url.endsWith("/v1")) {
      url = `${url}/v1`
    }

    const start = Date.now()
    const response = await proxyFetch(`${url}/models`, {
      headers: {
        "Content-Type": "application/json",
      },
    })
    const latency = Date.now() - start

    if (response.ok) {
      const data = await response.json()
      const modelCount = data.data?.length || 0
      const modelList = data.data
        ?.slice(0, 3)
        .map((m: { id: string }) => m.id)
        .join(", ")
      return {
        success: true,
        message: `${providerName} connected. ${modelCount} model(s)${modelList ? `: ${modelList}` : ""}.`,
        latency_ms: latency,
        model_info: `${modelCount} models`,
      }
    } else {
      return {
        success: false,
        message: `${providerName} connection failed: HTTP ${response.status}`,
        latency_ms: latency,
      }
    }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : `${providerName} connection failed`,
    }
  }
}

/**
 * Test custom OpenAI-compatible provider connection
 */
export async function testCustomProviderConnection(
  baseUrl: string,
  apiKey: string
): Promise<ApiTestResult> {
  if (isTauri()) {
    return invoke<ApiTestResult>("test_custom_provider_connection", {
      baseUrl,
      apiKey,
    })
  }

  try {
    const url = baseUrl.endsWith("/") ? `${baseUrl}models` : `${baseUrl}/models`
    const start = Date.now()
    const response = await proxyFetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    })
    const latency = Date.now() - start

    if (response.ok) {
      return {
        success: true,
        message: "Connected successfully to custom provider.",
        latency_ms: latency,
        model_info: "Custom provider available",
      }
    } else {
      return {
        success: false,
        message: `API error: ${response.status}`,
        latency_ms: latency,
      }
    }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Connection failed",
    }
  }
}

/**
 * Test provider connection by provider ID
 */
export async function testProviderConnection(
  providerId: string,
  apiKey: string,
  baseUrl?: string
): Promise<ApiTestResult> {
  const probeResult = await probeProviderConnection({
    providerId,
    apiKey,
    baseURL: baseUrl,
  })

  return probeResult
}

function toAuthoritativeResult(result: ApiTestResult): ProviderConnectionProbeResult {
  if (result.outcome) {
    return {
      ...result,
      outcome: result.outcome,
      authoritative: result.authoritative ?? result.outcome !== "limited",
    }
  }

  return {
    ...result,
    outcome: result.success ? "verified" : "failed",
    authoritative: true,
  }
}

export async function probeProviderConnection(
  input: ProviderConnectionProbeInput
): Promise<ProviderConnectionProbeResult> {
  const { providerId, apiKey = "", baseURL } = input
  const protocol = input.protocol || getBuiltInProviderProtocol(providerId) || "openai"

  // Use centralized local provider configs
  const localProviderDefaults = LOCAL_PROVIDER_TEST_CONFIGS

  switch (providerId) {
    case "openai":
      return toAuthoritativeResult(await testOpenAIConnection(apiKey, baseURL))
    case "anthropic":
      return toAuthoritativeResult(await testAnthropicConnection(apiKey))
    case "google":
      return toAuthoritativeResult(await testGoogleConnection(apiKey))
    case "deepseek":
      return toAuthoritativeResult(await testDeepSeekConnection(apiKey))
    case "groq":
      return toAuthoritativeResult(await testGroqConnection(apiKey))
    case "mistral":
      return toAuthoritativeResult(await testMistralConnection(apiKey))
    case "ollama":
      return toAuthoritativeResult(
        await testOllamaConnection(baseURL || localProviderDefaults.ollama.url)
      )
    // Local inference providers (OpenAI-compatible)
    case "lmstudio":
    case "llamacpp":
    case "llamafile":
    case "vllm":
    case "localai":
    case "jan":
    case "textgenwebui":
    case "koboldcpp":
    case "tabbyapi": {
      const config = localProviderDefaults[providerId]
      return toAuthoritativeResult(
        await testLocalProviderConnectionByUrl(baseURL || config.url, config.name)
      )
    }
    default: {
      // Settings seed a built-in config without a baseURL (it is only backfilled
      // while the Config tab is mounted), so fall back to the catalog rather
      // than reporting the provider as unknown.
      const resolvedBaseURL = baseURL?.trim() || getBuiltInProviderDefaultBaseURL(providerId)
      if (resolvedBaseURL) {
        return toAuthoritativeResult(
          await testCustomProviderConnectionByProtocol(
            resolvedBaseURL,
            apiKey,
            protocol,
            input.model ?? getBuiltInProviderDefaultModel(providerId)
          )
        )
      }
      return {
        success: false,
        message: "Unknown provider",
        outcome: "failed",
        authoritative: true,
      }
    }
  }
}

/**
 * Detect running local AI providers by checking their health endpoints
 * Returns list of detected providers with their status and available models
 */
export async function detectLocalProviders(
  providerIds?: string[]
): Promise<LocalProviderDetectionResult[]> {
  const providersToCheck = providerIds || Object.keys(LOCAL_PROVIDER_TEST_CONFIGS)
  const results: LocalProviderDetectionResult[] = []

  // Check each provider in parallel with timeout
  const checkPromises = providersToCheck.map(async (providerId) => {
    const config = LOCAL_PROVIDER_TEST_CONFIGS[providerId]
    if (!config) return null

    const result: LocalProviderDetectionResult = {
      providerId,
      name: config.name,
      baseUrl: config.url,
      isRunning: false,
    }

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 2000) // 2 second timeout

      const response = await fetch(`${config.url}${config.healthPath}`, {
        method: "GET",
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (response.ok) {
        result.isRunning = true

        // Try to parse models from response
        try {
          const data = await response.json()

          // Handle different response formats
          if (providerId === "ollama" && data.models) {
            result.models = data.models.map((m: { name: string }) => m.name)
          } else if (data.data && Array.isArray(data.data)) {
            // OpenAI-compatible format
            result.models = data.data.map((m: { id: string }) => m.id)
          } else if (Array.isArray(data)) {
            result.models = data.map((m: { id?: string; name?: string }) => m.id || m.name || "")
          }
        } catch {
          // Couldn't parse models, but provider is running
        }
      }
    } catch {
      // Provider not running or unreachable
      result.isRunning = false
    }

    return result
  })

  const checkResults = await Promise.all(checkPromises)

  // Filter out nulls and add to results
  for (const result of checkResults) {
    if (result) {
      results.push(result)
    }
  }

  return results
}

/**
 * Detect a single local provider
 */
export async function detectLocalProvider(
  providerId: string,
  customUrl?: string
): Promise<LocalProviderDetectionResult | null> {
  const config = LOCAL_PROVIDER_TEST_CONFIGS[providerId]
  if (!config && !customUrl) return null

  const baseUrl = customUrl || config?.url || ""
  const healthPath = config?.healthPath || "/v1/models"

  const result: LocalProviderDetectionResult = {
    providerId,
    name: config?.name || providerId,
    baseUrl,
    isRunning: false,
  }

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 3000)

    const response = await fetch(`${baseUrl}${healthPath}`, {
      method: "GET",
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (response.ok) {
      result.isRunning = true

      try {
        const data = await response.json()

        if (providerId === "ollama" && data.models) {
          result.models = data.models.map((m: { name: string }) => m.name)
        } else if (data.data && Array.isArray(data.data)) {
          result.models = data.data.map((m: { id: string }) => m.id)
        }
      } catch {
        // Couldn't parse models
      }
    }
  } catch {
    result.isRunning = false
  }

  return result
}
