import * as _cognia_provider_types from "@cognia/provider-types"
import { ProviderModelDiscoveryEntry } from "@cognia/provider-types"
import { BuiltInProviderId } from "@cognia/provider-types/built-in-provider-catalog"

interface EquivalentCustomProviderLike {
  providerId?: string
  customName?: string
  baseURL?: string
  apiKey?: string
  apiProtocol?: "openai" | "anthropic" | "gemini" | (string & {})
  customModels?: string[]
  customModelMetadata?: Record<
    string,
    {
      id?: string
      name?: string
      contextLength?: number
      maxOutputTokens?: number
      pricing?: {
        promptPer1M?: number
        completionPer1M?: number
      }
      capabilities?: {
        vision?: boolean
        functionCalling?: boolean
        streaming?: boolean
      }
    }
  >
  models?: string[]
  discoveredModels?: ProviderModelDiscoveryEntry[]
  discoveredModelsLastFetched?: number
  defaultModel?: string
  enabled?: boolean
}
interface EquivalentBuiltInProviderCandidate {
  builtInProviderId: BuiltInProviderId
  customProviderId: string
  provider: EquivalentCustomProviderLike
}
declare function resolveEquivalentBuiltInProviderId(
  provider: EquivalentCustomProviderLike
): BuiltInProviderId | undefined
declare function findEquivalentBuiltInProviderCandidates(
  customProviders: Record<string, EquivalentCustomProviderLike | undefined>
): Partial<Record<BuiltInProviderId, EquivalentBuiltInProviderCandidate>>
declare function buildBuiltInSettingsFromCustomProvider(
  providerId: BuiltInProviderId,
  provider: EquivalentCustomProviderLike
): {
  providerId:
    | "openai"
    | "anthropic"
    | "bedrock"
    | "ollama"
    | "lmstudio"
    | "llamacpp"
    | "llamafile"
    | "vllm"
    | "localai"
    | "jan"
    | "textgenwebui"
    | "koboldcpp"
    | "tabbyapi"
    | "google"
    | "deepseek"
    | "groq"
    | "mistral"
    | "openrouter"
    | "cliproxyapi"
    | "xai"
    | "togetherai"
    | "cohere"
    | "fireworks"
    | "cerebras"
    | "sambanova"
    | "siliconflow"
    | "moonshot"
    | "doubao"
    | "baichuan"
    | "lingyi"
    | "stepfun"
    | "perplexity"
    | "deepinfra"
    | "novita"
    | "lepton"
    | "aiproxy"
    | "ohmygpt"
    | "zhipu"
    | "minimax"
    | "yi"
    | "qwen"
    | "volcengine"
    | "internlm"
    | "glm4"
    | "azure"
    | "nvidia"
    | "huggingface"
    | "replicate"
    | "cloudflare"
    | "github"
    | "ai21"
    | "baidu"
    | "tencent"
    | "modelscope"
    | "voyage"
    | "jina"
    | "fal"
    | "opencode"
    | "opencode-go"
    | "codex"
    | "deepseek-anthropic"
    | "glm-anthropic"
    | "glm-anthropic-intl"
    | "kimi-anthropic"
    | "kimi-coding"
    | "minimax-anthropic"
    | "minimax-anthropic-intl"
    | "stepfun-anthropic"
    | "volcengine-agentplan"
    | "longcat-anthropic"
    | "qianfan-coding"
    | "bailian-anthropic"
    | "xiaomi-mimo-anthropic"
    | "openrouter-anthropic"
    | "siliconflow-anthropic"
    | "novita-anthropic"
    | "qiniu-anthropic"
    | "modelscope-anthropic"
    | "shengsuanyun"
    | "packycode"
  apiKey: string
  defaultModel: string
  enabled: boolean
  discoveredModels:
    | {
        id: string
        name?: string
        provider?: string
        contextLength?: number
        maxOutputTokens?: number
        supportsTools?: boolean
        supportsVision?: boolean
        supportsAudio?: boolean
        supportsVideo?: boolean
        supportsStreaming?: boolean
        supportsReasoning?: boolean
        supportsImageGeneration?: boolean
        supportsEmbedding?: boolean
        supportsStructuredOutput?: boolean
        pricing?: Partial<_cognia_provider_types.ModelPricing>
      }[]
    | undefined
  discoveredModelsLastFetched: number | undefined
  baseURL: string | undefined
  verificationStatus: "unverified"
  verificationMessage: undefined
}

export {
  type EquivalentBuiltInProviderCandidate,
  type EquivalentCustomProviderLike,
  buildBuiltInSettingsFromCustomProvider,
  findEquivalentBuiltInProviderCandidates,
  resolveEquivalentBuiltInProviderId,
}
