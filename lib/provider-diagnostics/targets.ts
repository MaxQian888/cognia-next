import type { AppSettings } from "@cognia/agent-config-types"
import { getProviderConfig } from "@cognia/provider-types/provider"
import type { ProviderDiagnosticCapability } from "@cognia/provider-types"

import {
  resolveProviderAttemptOptions,
  type ProviderAttemptOptions,
} from "@/lib/claude/provider-attempt-options"

import { PROVIDER_DIAGNOSTIC_EMBEDDING_VALUES, PROVIDER_DIAGNOSTIC_TEXT_PROMPT } from "./benchmark"
import type { ResolvedProviderDiagnosticTarget } from "./service"

export interface ResolveProviderDiagnosticTargetsInput {
  providerId: string
  modelIds: string[]
  capability: ProviderDiagnosticCapability
  credentialIds?: string[]
  endpoints?: string[]
  appSettings: AppSettings
}

interface TargetDependencies {
  resolveAttempt?: (providerId: string, appSettings: AppSettings) => Promise<ProviderAttemptOptions>
}

function credentialForId(
  id: string,
  settings: NonNullable<AppSettings["providerSettings"]>[string] | undefined,
  fallback: string | undefined
): string | undefined {
  if (id === "primary") return settings?.apiKey ?? fallback
  const match = /^pool:(\d+)$/.exec(id)
  if (!match) throw new Error(`Unsupported provider diagnostic credential id: ${id}`)
  const key = settings?.apiKeys?.[Number(match[1])]
  if (!key) throw new Error(`Provider diagnostic credential ${id} is not configured`)
  return key
}

function endpointIdentity(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    return encodeURIComponent(`${url.host}${url.pathname.replace(/\/+$/, "")}`)
  } catch {
    return encodeURIComponent(endpoint)
  }
}

function estimatedInputTokens(capability: ProviderDiagnosticCapability): number {
  if (capability === "embedding") {
    return PROVIDER_DIAGNOSTIC_EMBEDDING_VALUES.reduce(
      (total, value) => total + Math.ceil(value.length / 4),
      0
    )
  }
  return Math.ceil(PROVIDER_DIAGNOSTIC_TEXT_PROMPT.length / 4)
}

export async function resolveProviderDiagnosticTargets(
  input: ResolveProviderDiagnosticTargetsInput,
  dependencies: TargetDependencies = {}
): Promise<ResolvedProviderDiagnosticTarget[]> {
  const attempt = await (dependencies.resolveAttempt ?? resolveProviderAttemptOptions)(
    input.providerId,
    input.appSettings
  )
  const baseCredentials = attempt.providerCredentials
  if (!baseCredentials) {
    throw new Error(`Provider ${input.providerId} is not configured for diagnostics`)
  }
  const settings = input.appSettings.providerSettings?.[input.providerId]
  const credentialIds = input.credentialIds?.length ? input.credentialIds : ["primary"]
  const endpoints = input.endpoints?.length
    ? input.endpoints
    : [baseCredentials.baseURL ?? settings?.baseURL].filter((value): value is string => !!value)
  if (endpoints.length === 0) {
    throw new Error(`Provider ${input.providerId} has no diagnostic endpoint`)
  }
  const models = input.modelIds.length > 0 ? input.modelIds : [attempt.defaultModel].filter(Boolean)
  if (models.length === 0 && input.capability !== "probe") {
    throw new Error(`Provider ${input.providerId} has no diagnostic model`)
  }
  const effectiveModels = models.length > 0 ? (models as string[]) : [undefined]
  const providerConfig = getProviderConfig(input.providerId)
  const targets: ResolvedProviderDiagnosticTarget[] = []

  for (const credentialId of credentialIds) {
    const apiKey = credentialForId(credentialId, settings, baseCredentials.apiKey)
    for (const endpoint of endpoints) {
      for (const modelId of effectiveModels) {
        const pricing = modelId
          ? providerConfig?.models.find((model) => model.id === modelId)?.pricing
          : undefined
        const usdPricing = !pricing?.currency || pricing.currency === "USD" ? pricing : undefined
        const price = usdPricing
          ? {
              inputPerMillionUsd: usdPricing.promptPer1M,
              outputPerMillionUsd: usdPricing.completionPer1M,
              version: "built-in-provider-catalog",
            }
          : undefined
        const localOrFree =
          input.capability === "probe" ||
          providerConfig?.type === "local" ||
          (price?.inputPerMillionUsd === 0 && price.outputPerMillionUsd === 0)
        const estimatedMaxCostUsd = localOrFree
          ? 0
          : price
            ? (estimatedInputTokens(input.capability) * price.inputPerMillionUsd +
                (input.capability === "text-generation" ? 64 : 0) * price.outputPerMillionUsd) /
              1_000_000
            : undefined
        const fingerprint = `credential:${input.providerId}:${credentialId}`
        const modelIdentity = modelId ?? "probe"
        targets.push({
          id: `${input.providerId}:${modelIdentity}:${fingerprint}:${endpointIdentity(endpoint)}`,
          providerId: input.providerId,
          modelId,
          credentialId,
          credentialFingerprint: fingerprint,
          endpoint,
          capability: input.capability,
          credentials: {
            ...baseCredentials,
            apiKey,
            baseURL: endpoint,
          },
          protocolAdapterSpec: attempt.protocolAdapterSpec,
          price,
          estimatedMaxCostUsd,
          billable: !localOrFree,
        })
      }
    }
  }
  return targets
}
