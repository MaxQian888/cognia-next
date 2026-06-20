// Re-export shim: canonical source moved to @cognia/provider-core (Stage 2).
export {
  LOCAL_PROVIDER_TEST_CONFIGS,
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
} from "@cognia/provider-core/providers/api-test"
export type {
  ApiTestResult,
  LocalProviderDetectionResult,
  ProviderConnectionProbeInput,
  ProviderConnectionProbeResult,
} from "@cognia/provider-core/providers/api-test"
