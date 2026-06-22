import type { CircuitBreakerStateValue } from "@cognia/provider-types/circuit-breaker"
import type { ProviderHealthMetrics } from "@cognia/provider-types/health-metrics"
import type { DifficultyRoutingSettings, ToolRouteRecord } from "./routing-types"

export interface ModelContextLimits {
  maxTokens: number
  reserveTokens: number
}

export interface SemanticToolRouterRuntimeDeps {
  listRoutes: () => Promise<ToolRouteRecord[]>
  embed: (
    texts: string[],
    config: { provider: string; model: string; dimensions?: number }
  ) => Promise<number[][]>
  cacheRouteEmbeddings: (id: string, embeddings: number[][], model: string) => Promise<void>
  cosine: (a: number[], b: number[]) => number
}

export interface ProviderRoutingRuntimeAdapters {
  getHealthMetrics?: (providerId: string) => ProviderHealthMetrics | undefined
  getCircuitBreakerState?: (providerId: string) => CircuitBreakerStateValue
  isCircuitBreakerAvailable?: (providerId: string) => boolean
  getTodaySpend?: (providerId: string) => number
  getRate?: (providerId: string) => { rpm: number; tpm: number }
  getInFlight?: (providerId: string) => number
  getDeploymentHealth?: (deploymentKey: string) => ProviderHealthMetrics | undefined
  getDeploymentCircuitBreakerState?: (deploymentKey: string) => CircuitBreakerStateValue
  getDeploymentRate?: (deploymentKey: string) => { rpm: number; tpm: number }
  getDeploymentInFlight?: (deploymentKey: string) => number
  getSessionDeployment?: (sessionId: string) => string | undefined
  releaseSessionDeployment?: (sessionId: string) => void
  updateCircuitConfig?: (providerId: string, config: Record<string, unknown>) => void
  setCircuitBreakerEnabled?: (enabled: boolean) => void
  setCircuitBreakerSettings?: (settings: Record<string, unknown>) => void
  getDifficultyRoutingSettings?: () => DifficultyRoutingSettings | undefined
  semanticToolRouterDeps?: SemanticToolRouterRuntimeDeps
}

type RequiredRoutingRuntimeAdapters = Required<
  Pick<
    ProviderRoutingRuntimeAdapters,
    | "getHealthMetrics"
    | "getCircuitBreakerState"
    | "isCircuitBreakerAvailable"
    | "getTodaySpend"
    | "getRate"
    | "getInFlight"
    | "getDeploymentHealth"
    | "getDeploymentCircuitBreakerState"
    | "getDeploymentRate"
    | "getDeploymentInFlight"
    | "getSessionDeployment"
    | "releaseSessionDeployment"
    | "updateCircuitConfig"
    | "setCircuitBreakerEnabled"
    | "setCircuitBreakerSettings"
    | "getDifficultyRoutingSettings"
  >
> &
  Pick<ProviderRoutingRuntimeAdapters, "semanticToolRouterDeps">

const MODEL_CONTEXT_LIMITS: Record<string, ModelContextLimits> = {
  "gpt-4": { maxTokens: 8192, reserveTokens: 2000 },
  "gpt-4-32k": { maxTokens: 32768, reserveTokens: 4000 },
  "gpt-4-turbo": { maxTokens: 128000, reserveTokens: 8000 },
  "gpt-4o": { maxTokens: 128000, reserveTokens: 8000 },
  "gpt-4o-mini": { maxTokens: 128000, reserveTokens: 8000 },
  "gpt-5.4": { maxTokens: 1000000, reserveTokens: 10000 },
  "gpt-5.4-mini": { maxTokens: 1000000, reserveTokens: 10000 },
  "gpt-5.4-nano": { maxTokens: 1000000, reserveTokens: 8000 },
  "gpt-5.4-pro": { maxTokens: 1000000, reserveTokens: 10000 },
  "gpt-4.1": { maxTokens: 1047576, reserveTokens: 10000 },
  "gpt-4.1-mini": { maxTokens: 1047576, reserveTokens: 10000 },
  "gpt-4.1-nano": { maxTokens: 1047576, reserveTokens: 8000 },
  "gpt-3.5-turbo": { maxTokens: 16385, reserveTokens: 2000 },
  o1: { maxTokens: 200000, reserveTokens: 10000 },
  o3: { maxTokens: 200000, reserveTokens: 10000 },
  "o4-mini": { maxTokens: 200000, reserveTokens: 10000 },
  "claude-3-opus": { maxTokens: 200000, reserveTokens: 10000 },
  "claude-3-sonnet": { maxTokens: 200000, reserveTokens: 10000 },
  "claude-3-haiku": { maxTokens: 200000, reserveTokens: 8000 },
  "claude-3.5-sonnet": { maxTokens: 200000, reserveTokens: 10000 },
  "claude-3.5-haiku": { maxTokens: 200000, reserveTokens: 8000 },
  "claude-4-opus": { maxTokens: 200000, reserveTokens: 10000 },
  "claude-4-sonnet": { maxTokens: 200000, reserveTokens: 10000 },
  "claude-sonnet": { maxTokens: 200000, reserveTokens: 10000 },
  "gemini-pro": { maxTokens: 32768, reserveTokens: 4000 },
  "gemini-1.5-pro": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-1.5-flash": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-2.0-flash": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-3-flash-preview": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-3.1-pro-preview": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-3.1-flash-lite-preview": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-2.5-pro": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-2.5-flash": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-2.5-flash-lite": { maxTokens: 1048576, reserveTokens: 8000 },
  "deepseek-v4-flash": { maxTokens: 1048576, reserveTokens: 10000 },
  "deepseek-v4-pro": { maxTokens: 1048576, reserveTokens: 10000 },
  "deepseek-v3": { maxTokens: 128000, reserveTokens: 8000 },
  "deepseek-r1": { maxTokens: 128000, reserveTokens: 8000 },
  "deepseek-chat": { maxTokens: 1048576, reserveTokens: 10000 },
  "deepseek-reasoner": { maxTokens: 1048576, reserveTokens: 10000 },
  "qwen-2.5": { maxTokens: 131072, reserveTokens: 8000 },
  "qwen-3": { maxTokens: 131072, reserveTokens: 8000 },
  "qwen-turbo": { maxTokens: 131072, reserveTokens: 8000 },
  "qwen-plus": { maxTokens: 131072, reserveTokens: 8000 },
  "qwen-max": { maxTokens: 131072, reserveTokens: 8000 },
}

function defaultAdapters(): RequiredRoutingRuntimeAdapters {
  return {
    getHealthMetrics: () => undefined,
    getCircuitBreakerState: () => "closed",
    isCircuitBreakerAvailable: () => true,
    getTodaySpend: () => 0,
    getRate: () => ({ rpm: 0, tpm: 0 }),
    getInFlight: () => 0,
    getDeploymentHealth: () => undefined,
    getDeploymentCircuitBreakerState: () => "closed",
    getDeploymentRate: () => ({ rpm: 0, tpm: 0 }),
    getDeploymentInFlight: () => 0,
    getSessionDeployment: () => undefined,
    releaseSessionDeployment: () => {},
    updateCircuitConfig: () => {},
    setCircuitBreakerEnabled: () => {},
    setCircuitBreakerSettings: () => {},
    getDifficultyRoutingSettings: () => undefined,
  }
}

let adapters = defaultAdapters()

export function setProviderRoutingRuntimeAdapters(next: ProviderRoutingRuntimeAdapters): void {
  adapters = {
    ...adapters,
    ...next,
  }
}

export function resetProviderRoutingRuntimeAdaptersForTesting(): void {
  adapters = defaultAdapters()
}

export function getProviderRoutingRuntimeAdapters(): RequiredRoutingRuntimeAdapters {
  return adapters
}

export function getModelContextLimits(model: string): ModelContextLimits {
  if (MODEL_CONTEXT_LIMITS[model]) {
    return MODEL_CONTEXT_LIMITS[model]
  }

  const sortedKeys = Object.keys(MODEL_CONTEXT_LIMITS).sort((a, b) => b.length - a.length)
  const modelLower = model.toLowerCase()
  for (const key of sortedKeys) {
    if (modelLower.includes(key)) {
      return MODEL_CONTEXT_LIMITS[key]
    }
  }

  if (modelLower.includes("claude")) return { maxTokens: 200000, reserveTokens: 10000 }
  if (modelLower.includes("gemini")) return { maxTokens: 1048576, reserveTokens: 10000 }
  if (modelLower.includes("gpt")) return { maxTokens: 128000, reserveTokens: 8000 }
  if (modelLower.includes("deepseek")) return { maxTokens: 128000, reserveTokens: 8000 }
  if (modelLower.includes("qwen")) return { maxTokens: 131072, reserveTokens: 8000 }

  return { maxTokens: 100000, reserveTokens: 2000 }
}

export function getModelMaxTokens(model: string): number {
  return getModelContextLimits(model).maxTokens
}
