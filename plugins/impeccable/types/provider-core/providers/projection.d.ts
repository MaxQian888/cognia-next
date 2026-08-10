import {
  BuiltInProviderCategory,
  BuiltInProviderCodingPackage,
} from "@cognia/provider-types/built-in-provider-catalog"
import {
  UserProviderSettings,
  ApiProtocol,
  ProviderVerificationStatus,
  ProviderMetadata,
  ModelConfig,
} from "@cognia/provider-types"
import {
  ProviderReadinessState,
  ProviderNextAction,
  ProviderSetupChecklist,
} from "./completeness.js"

type ProviderProjectionKind = "built-in" | "local" | "custom"
type ProviderProjectionCategory = BuiltInProviderCategory | "custom" | undefined
interface CustomProviderProjectionInput {
  providerId?: string
  isCustom?: true
  customName?: string
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
  apiProtocol?: ApiProtocol
  apiKey?: string
  baseURL?: string
  defaultModel?: string
  enabled?: boolean
  verificationStatus?: ProviderVerificationStatus
  verificationFingerprint?: string
}
interface ProviderStateProjection {
  id: string
  kind: ProviderProjectionKind
  category: ProviderProjectionCategory
  displayName: string
  description: string
  icon?: string
  website?: string
  metadata: ProviderMetadata
  /** All available models (static + discovered + curated). */
  models: ModelConfig[]
  modelIds: string[]
  /** User-selected subset of models. Empty/same as models when no whitelist is set. */
  enabledModels: ModelConfig[]
  enabledModelIds: string[]
  defaultModelId: string
  defaultModel?: ModelConfig
  readiness: ProviderReadinessState
  verificationStatus: ProviderVerificationStatus
  nextAction?: ProviderNextAction
  recommendedRemediation?: string
  selectable: boolean
  blockedReason?: string
  codingPackage?: BuiltInProviderCodingPackage
  enabled: boolean
  hasCredential: boolean
  hasBaseUrl: boolean
  setupChecklist: ProviderSetupChecklist
  isCustom: boolean
  settings: Partial<UserProviderSettings> | CustomProviderProjectionInput
}
interface BuildProviderStateProjectionInput {
  providerSettings: Record<string, Partial<UserProviderSettings> | undefined>
  customProviders?: Record<string, CustomProviderProjectionInput | undefined>
  builtInTestResults?: Record<
    string,
    | {
        success?: boolean
      }
    | null
    | undefined
  >
  customTestResults?: Record<
    string,
    | {
        success?: boolean
      }
    | "success"
    | "error"
    | "limited"
    | null
    | undefined
  >
}
declare function buildProviderStateProjections(
  input: BuildProviderStateProjectionInput
): ProviderStateProjection[]
declare function buildProviderStateProjectionMap(
  input: BuildProviderStateProjectionInput
): Record<string, ProviderStateProjection>
declare function getProviderSelectionGuidance(
  projections: ProviderStateProjection[]
): string | undefined

export {
  type BuildProviderStateProjectionInput,
  type CustomProviderProjectionInput,
  type ProviderProjectionCategory,
  type ProviderProjectionKind,
  type ProviderStateProjection,
  buildProviderStateProjectionMap,
  buildProviderStateProjections,
  getProviderSelectionGuidance,
}
