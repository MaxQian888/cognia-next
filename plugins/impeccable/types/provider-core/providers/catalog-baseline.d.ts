import { InMemoryCatalogRepository } from "./catalog-repository.js"
import "@cognia/provider-types/model-catalog"

declare const CERTIFICATION_CANDIDATES: readonly [
  {
    readonly id: "openai"
    readonly providerIds: readonly ["openai"]
  },
  {
    readonly id: "anthropic"
    readonly providerIds: readonly ["anthropic"]
  },
  {
    readonly id: "google-gemini"
    readonly providerIds: readonly ["google"]
  },
  {
    readonly id: "xai"
    readonly providerIds: readonly ["xai"]
  },
  {
    readonly id: "mistral"
    readonly providerIds: readonly ["mistral"]
  },
  {
    readonly id: "deepseek"
    readonly providerIds: readonly ["deepseek"]
  },
  {
    readonly id: "groq"
    readonly providerIds: readonly ["groq"]
  },
  {
    readonly id: "openrouter"
    readonly providerIds: readonly ["openrouter"]
  },
  {
    readonly id: "vercel-ai-gateway"
    readonly providerIds: readonly ["models-dev:vercel"]
  },
  {
    readonly id: "aws-bedrock"
    readonly providerIds: readonly ["bedrock"]
  },
  {
    readonly id: "azure-openai"
    readonly providerIds: readonly ["azure"]
  },
  {
    readonly id: "google-vertex-ai"
    readonly providerIds: readonly ["models-dev:google-vertex"]
  },
  {
    readonly id: "alibaba-qwen-bailian"
    readonly providerIds: readonly ["qwen", "bailian-anthropic"]
  },
  {
    readonly id: "zhipu-glm-zai"
    readonly providerIds: readonly ["zhipu", "glm4"]
  },
  {
    readonly id: "moonshot-kimi"
    readonly providerIds: readonly ["moonshot", "kimi-anthropic"]
  },
  {
    readonly id: "minimax"
    readonly providerIds: readonly ["minimax"]
  },
  {
    readonly id: "volcengine-doubao"
    readonly providerIds: readonly ["volcengine", "doubao"]
  },
  {
    readonly id: "siliconflow"
    readonly providerIds: readonly ["siliconflow"]
  },
  {
    readonly id: "modelscope"
    readonly providerIds: readonly ["modelscope"]
  },
  {
    readonly id: "nvidia-nim"
    readonly providerIds: readonly ["nvidia"]
  },
  {
    readonly id: "hugging-face-inference"
    readonly providerIds: readonly ["huggingface"]
  },
  {
    readonly id: "ollama"
    readonly providerIds: readonly ["ollama"]
  },
  {
    readonly id: "lm-studio"
    readonly providerIds: readonly ["lmstudio"]
  },
  {
    readonly id: "vllm"
    readonly providerIds: readonly ["vllm"]
  },
]
/** Providers that have passed the bundled conformance baseline today. */
declare const BUNDLED_CERTIFIED_PROVIDER_IDS: ReadonlySet<string>
/**
 * Offline last-known-good catalog for headless consumers before live storage
 * is available. It is built through the same mapper and repository as the
 * reviewed remote revision, never through a private model table.
 */
declare function getBundledCatalogRepository(): InMemoryCatalogRepository

export { BUNDLED_CERTIFIED_PROVIDER_IDS, CERTIFICATION_CANDIDATES, getBundledCatalogRepository }
