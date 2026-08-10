import { ApiProtocol } from "@cognia/provider-types"

/**
 * API Connection Testing - Test provider API connections
 */

interface ApiTestResult {
  success: boolean
  message: string
  latency_ms?: number
  model_info?: string
  outcome?: "verified" | "failed" | "limited"
  authoritative?: boolean
}
interface ProviderConnectionProbeInput {
  providerId: string
  apiKey?: string
  baseURL?: string
  protocol?: ApiProtocol
  /** Model to probe with; defaults to the built-in catalog's default model. */
  model?: string
}
interface ProviderConnectionProbeResult extends ApiTestResult {
  outcome: "verified" | "failed" | "limited"
  authoritative: boolean
}
interface LocalProviderDetectionResult {
  providerId: string
  name: string
  baseUrl: string
  isRunning: boolean
  models?: string[]
  version?: string
}
declare const LOCAL_PROVIDER_TEST_CONFIGS: Record<
  string,
  {
    url: string
    name: string
    healthPath: string
  }
>
declare function testCustomProviderConnectionByProtocol(
  baseUrl: string,
  apiKey: string,
  apiProtocol?: ApiProtocol,
  model?: string
): Promise<ApiTestResult>
/**
 * Test OpenAI API connection
 */
declare function testOpenAIConnection(apiKey: string, baseUrl?: string): Promise<ApiTestResult>
/**
 * Test Anthropic API connection
 */
declare function testAnthropicConnection(apiKey: string): Promise<ApiTestResult>
/**
 * Test Google AI API connection
 */
declare function testGoogleConnection(apiKey: string): Promise<ApiTestResult>
/**
 * Test DeepSeek API connection
 */
declare function testDeepSeekConnection(apiKey: string): Promise<ApiTestResult>
/**
 * Test Groq API connection
 */
declare function testGroqConnection(apiKey: string): Promise<ApiTestResult>
/**
 * Test Mistral API connection
 */
declare function testMistralConnection(apiKey: string): Promise<ApiTestResult>
/**
 * Test Ollama connection
 */
declare function testOllamaConnection(baseUrl: string): Promise<ApiTestResult>
/**
 * Test local inference provider connection by URL (OpenAI-compatible)
 * Works for: LM Studio, llama.cpp, llamafile, vLLM, LocalAI, Jan, etc.
 */
declare function testLocalProviderConnectionByUrl(
  baseUrl: string,
  providerName?: string
): Promise<ApiTestResult>
/**
 * Test custom OpenAI-compatible provider connection
 */
declare function testCustomProviderConnection(
  baseUrl: string,
  apiKey: string
): Promise<ApiTestResult>
/**
 * Test provider connection by provider ID
 */
declare function testProviderConnection(
  providerId: string,
  apiKey: string,
  baseUrl?: string
): Promise<ApiTestResult>
declare function probeProviderConnection(
  input: ProviderConnectionProbeInput
): Promise<ProviderConnectionProbeResult>
/**
 * Detect running local AI providers by checking their health endpoints
 * Returns list of detected providers with their status and available models
 */
declare function detectLocalProviders(
  providerIds?: string[]
): Promise<LocalProviderDetectionResult[]>
/**
 * Detect a single local provider
 */
declare function detectLocalProvider(
  providerId: string,
  customUrl?: string
): Promise<LocalProviderDetectionResult | null>

export {
  type ApiTestResult,
  LOCAL_PROVIDER_TEST_CONFIGS,
  type LocalProviderDetectionResult,
  type ProviderConnectionProbeInput,
  type ProviderConnectionProbeResult,
  detectLocalProvider,
  detectLocalProviders,
  probeProviderConnection,
  testAnthropicConnection,
  testCustomProviderConnection,
  testCustomProviderConnectionByProtocol,
  testDeepSeekConnection,
  testGoogleConnection,
  testGroqConnection,
  testLocalProviderConnectionByUrl,
  testMistralConnection,
  testOllamaConnection,
  testOpenAIConnection,
  testProviderConnection,
}
