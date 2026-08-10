type BuiltInProviderType = "cloud" | "local"
type BuiltInProviderCategory = "flagship" | "aggregator" | "specialized" | "local" | "enterprise"
type BuiltInProviderProtocol = "openai" | "anthropic" | "gemini" | "bedrock"
type ProviderUseCase = "coding"
type BuiltInProviderFamily =
  | "openai-compatible"
  | "anthropic-native"
  | "gemini-native"
  | "openrouter"
  | "local-openai-compatible"
  | "proxy-openai-compatible"
  | "bedrock-native"
type BuiltInProviderAdapterId =
  | "openai-compatible"
  | "anthropic"
  | "gemini"
  | "openrouter"
  | "local-openai-compatible"
  | "cliproxyapi"
  | "bedrock"
type BuiltInProviderQuickAddMode = "shortcut" | "promoted"
type BuiltInProviderQuickAddCategory = "china" | "global" | "proxy"
interface BuiltInProviderQuickAddMetadata {
  mode: BuiltInProviderQuickAddMode
  category: BuiltInProviderQuickAddCategory
  popular?: boolean
}
interface BuiltInProviderQuickAddPreset {
  id: string
  name: string
  description: string
  baseURL: string
  apiProtocol: BuiltInProviderProtocol
  models: string[]
  modelEntries: BuiltInProviderModelEntry[]
  defaultModel: string
  docsUrl?: string
  dashboardUrl?: string
  category: BuiltInProviderQuickAddCategory
  popular?: boolean
}
interface BuiltInProviderModelPricing {
  promptPer1M: number
  completionPer1M: number
  cachedInputPer1M?: number
  cacheCreationPer1M?: number
  batchInputPer1M?: number
  batchOutputPer1M?: number
  audioInputPer1M?: number
  audioOutputPer1M?: number
  currency?: "USD" | "CNY"
}
interface BuiltInProviderModelEntry {
  id: string
  name: string
  contextLength: number
  maxOutputTokens?: number
  supportsTools: boolean
  supportsVision: boolean
  supportsAudio: boolean
  supportsVideo: boolean
  supportsStreaming: boolean
  supportsReasoning?: boolean
  supportsImageGeneration?: boolean
  supportsEmbedding?: boolean
  pricing?: BuiltInProviderModelPricing
  recommendedFor?: ProviderUseCase[]
}
interface BuiltInProviderCodingPackage {
  id: "coding"
  label: string
  defaultModel: string
  modelIds: string[]
  mcpBundles?: BuiltInProviderCodingPackageMcpBundle[]
}
type BuiltInProviderCodingPackageMcpTransport = "stdio" | "sse" | "streamableHttp"
interface BuiltInProviderCodingPackageMcpCredentialBinding {
  type: "env" | "header"
  key: string
  prefix?: string
}
interface BuiltInProviderCodingPackageMcpBundle {
  id: string
  name: string
  description: string
  transport: BuiltInProviderCodingPackageMcpTransport
  command?: string
  args?: string[]
  url?: string
  messageUrl?: string
  envKeys?: string[]
  envDefaults?: Record<string, string>
  credentialBinding?: BuiltInProviderCodingPackageMcpCredentialBinding
  fallbackToSse?: boolean
  docsUrl?: string
}
interface BuiltInProviderOAuthConfig {
  authorizationUrl: string
  tokenUrl: string
  clientId?: string
  scope?: string
  pkceRequired?: boolean
  callbackPath: string
}
interface BuiltInProviderCompatibilityRule {
  protocol: BuiltInProviderProtocol
  baseURLs: string[]
  nameIncludes?: string[]
  modelPrefixes?: string[]
}
interface BuiltInProviderCatalogEntry {
  id: string
  name: string
  type: BuiltInProviderType
  protocol: BuiltInProviderProtocol
  /** Whether this provider exposes a chat/text-generation endpoint. Defaults to true. */
  supportsChat?: boolean
  family?: BuiltInProviderFamily
  /**
   * For relay entries (`*-anthropic` et al.): the vendor this entry is a
   * deployment OF (e.g. `glm-anthropic` → `zhipu`). Drives the ADR-0090
   * Phase 1 provider/deployment derivation — the relay id stays a valid
   * legacy id, but new writers treat it as a deployment of the vendor, not
   * a provider in its own right. The slug may name a vendor without its own
   * catalog entry (e.g. `qiniu`); the migration synthesizes the profile.
   */
  relayOf?: string
  adapter?: BuiltInProviderAdapterId
  apiKeyRequired: boolean
  baseURLRequired: boolean
  defaultModel: string
  defaultEnabled: boolean
  defaultBaseURL?: string
  defaultSettingsBaseURL?: string
  placeholderApiKey?: string
  category?: BuiltInProviderCategory
  description?: string
  website?: string
  dashboardUrl?: string
  docsUrl?: string
  pricingUrl?: string
  supportsOAuth?: boolean
  oauthConfig?: BuiltInProviderOAuthConfig
  models?: BuiltInProviderModelEntry[]
  quickAdd?: BuiltInProviderQuickAddMetadata
  codingPackage?: BuiltInProviderCodingPackage
  compatibility?: BuiltInProviderCompatibilityRule
}
declare const BUILT_IN_PROVIDER_IDS: readonly [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "groq",
  "mistral",
  "xai",
  "togetherai",
  "openrouter",
  "cohere",
  "fireworks",
  "cerebras",
  "sambanova",
  "siliconflow",
  "moonshot",
  "doubao",
  "baichuan",
  "lingyi",
  "stepfun",
  "perplexity",
  "deepinfra",
  "novita",
  "lepton",
  "aiproxy",
  "ohmygpt",
  "zhipu",
  "minimax",
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
  "cliproxyapi",
  "yi",
  "qwen",
  "volcengine",
  "internlm",
  "glm4",
  "bedrock",
  "azure",
  "nvidia",
  "huggingface",
  "replicate",
  "cloudflare",
  "github",
  "ai21",
  "baidu",
  "tencent",
  "modelscope",
  "voyage",
  "jina",
  "fal",
  "opencode",
  "opencode-go",
  "codex",
  "deepseek-anthropic",
  "glm-anthropic",
  "glm-anthropic-intl",
  "kimi-anthropic",
  "kimi-coding",
  "minimax-anthropic",
  "minimax-anthropic-intl",
  "stepfun-anthropic",
  "volcengine-agentplan",
  "longcat-anthropic",
  "qianfan-coding",
  "bailian-anthropic",
  "xiaomi-mimo-anthropic",
  "openrouter-anthropic",
  "siliconflow-anthropic",
  "novita-anthropic",
  "qiniu-anthropic",
  "modelscope-anthropic",
  "shengsuanyun",
  "packycode",
]
type BuiltInProviderId = (typeof BUILT_IN_PROVIDER_IDS)[number]
declare function isBuiltInProviderId(providerId: string): providerId is BuiltInProviderId
declare function getBuiltInProviderCatalog(): BuiltInProviderCatalogEntry[]
declare function getQuickAddProviderCatalogEntries(): BuiltInProviderCatalogEntry[]
declare function buildQuickAddProviderPresets(): BuiltInProviderQuickAddPreset[]
declare function getBuiltInProviderCatalogEntry(
  providerId: string
): BuiltInProviderCatalogEntry | undefined
declare function getBuiltInProviderDefaultModel(providerId: string): string | undefined
declare function getBuiltInProviderDefaultBaseURL(providerId: string): string | undefined
declare function getBuiltInProviderSettingsBaseURL(providerId: string): string | undefined
declare function getBuiltInProviderProtocol(providerId: string): BuiltInProviderProtocol | undefined
declare function getBuiltInProviderFamily(providerId: string): BuiltInProviderFamily | undefined
declare function getBuiltInProviderAdapter(providerId: string): BuiltInProviderAdapterId | undefined
declare function getBuiltInProviderCodingPackage(
  providerId: string
): BuiltInProviderCodingPackage | undefined
declare function getBuiltInProviderCodingPackageBundle(
  providerId: string,
  bundleId: string
): BuiltInProviderCodingPackageMcpBundle | undefined
declare function getBuiltInProviderPlaceholderApiKey(providerId: string): string | undefined
declare function buildDefaultBuiltInProviderSettings(): Record<
  BuiltInProviderId,
  {
    providerId: BuiltInProviderId
    apiKey?: string
    baseURL?: string
    defaultModel: string
    enabled: boolean
  }
>

export {
  BUILT_IN_PROVIDER_IDS,
  type BuiltInProviderAdapterId,
  type BuiltInProviderCatalogEntry,
  type BuiltInProviderCategory,
  type BuiltInProviderCodingPackage,
  type BuiltInProviderCodingPackageMcpBundle,
  type BuiltInProviderCodingPackageMcpCredentialBinding,
  type BuiltInProviderCodingPackageMcpTransport,
  type BuiltInProviderCompatibilityRule,
  type BuiltInProviderFamily,
  type BuiltInProviderId,
  type BuiltInProviderModelEntry,
  type BuiltInProviderModelPricing,
  type BuiltInProviderOAuthConfig,
  type BuiltInProviderProtocol,
  type BuiltInProviderQuickAddCategory,
  type BuiltInProviderQuickAddMetadata,
  type BuiltInProviderQuickAddMode,
  type BuiltInProviderQuickAddPreset,
  type BuiltInProviderType,
  type ProviderUseCase,
  buildDefaultBuiltInProviderSettings,
  buildQuickAddProviderPresets,
  getBuiltInProviderAdapter,
  getBuiltInProviderCatalog,
  getBuiltInProviderCatalogEntry,
  getBuiltInProviderCodingPackage,
  getBuiltInProviderCodingPackageBundle,
  getBuiltInProviderDefaultBaseURL,
  getBuiltInProviderDefaultModel,
  getBuiltInProviderFamily,
  getBuiltInProviderPlaceholderApiKey,
  getBuiltInProviderProtocol,
  getBuiltInProviderSettingsBaseURL,
  getQuickAddProviderCatalogEntries,
  isBuiltInProviderId,
}
