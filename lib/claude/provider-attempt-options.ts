import { getAllProviders, type ModelConfig } from "@cognia/provider-types/provider"
import type { AppSettings, SendOptions } from "@cognia/agent-config-types"
import {
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
} from "@/lib/ai/provider-consumption"
import { buildModelInferenceParams } from "@cognia/provider-core/providers/inference-params"
import { getSchemaForProvider } from "@cognia/provider-core/providers/provider-parameter-schemas"
import { recordKeyUse, selectApiKey } from "@cognia/provider-core/providers/api-key-rotation"
import { resolveOpencodeVaultCredential } from "@/lib/subscription/opencode/chat-bridge"
import { resolveCommandcodeVaultCredential } from "@/lib/subscription/commandcode/chat-bridge"
import { getSubscriptionProvider } from "@/lib/subscription/core/provider-registry"
import { resolveManagedSubscriptionCredential } from "@/lib/subscription/core/managed-key-credential"
import { resolveCodexVaultCredential } from "@/lib/subscription/codex/chat-bridge"
import { isCodexChatProviderId, isOpencodeChatProviderId } from "@/types/subscription"
import { getBuiltInProviderDefaultModel } from "@cognia/provider-types/built-in-provider-catalog"
import {
  resolveModelContextLength,
  resolveModelMaxOutputTokens,
  resolveModelMeta,
} from "@/lib/ai/model-options"
import { getModelContextWindow } from "./usage"
import { DEFAULT_COMPRESSION_SETTINGS } from "@cognia/agent-config-types/compression"
import { hasOwnKey, isRemoteHostKeyedProvider } from "@/lib/host-secrets/remote-host-keys"
import {
  EFFORT_TO_BUDGET,
  claude55CapabilitiesForModel,
} from "@cognia/provider-types/reasoning-effort-tables"

export interface ProviderAttemptOptions {
  providerCredentials?: SendOptions["providerCredentials"]
  protocolAdapterSpec?: SendOptions["protocolAdapterSpec"]
  modelParams?: SendOptions["modelParams"]
  defaultModel?: string
  concurrentLimit?: number
}

/** Match documented DeepSeek defaults; other providers retain their existing policy. */
function defaultOutputTokens(
  provider: string | undefined,
  model: string | undefined,
  ceiling: number,
  params: SendOptions["modelParams"]
): number {
  if (provider !== "deepseek" || !/^deepseek-(?:flash|v4-)/.test(model ?? "")) return ceiling
  const options = params?.providerOptions?.deepseek as
    { thinking?: { type?: string }; reasoningEffort?: string } | undefined
  return Math.min(
    ceiling,
    options?.thinking?.type === "disabled" || options?.reasoningEffort === "none"
      ? 8_192
      : options?.reasoningEffort === "max" || options?.reasoningEffort === "xhigh"
        ? 131_072
        : 65_536
  )
}

/** Anthropic's AI SDK adds enabled thinking to the text limit before clamping. */
export function resolveProviderOutputReserve(options: SendOptions, ceiling?: number): number {
  const output = Math.max(0, options.modelParams?.maxOutputTokens ?? 0)
  const thinking = options.modelParams?.providerOptions?.anthropic?.thinking as
    { type?: string; budgetTokens?: number } | undefined
  const protocol = options.providerCredentials?.protocol ?? options.provider
  const effortBudget = options.effort
    ? ((EFFORT_TO_BUDGET as Readonly<Record<string, number>>)[options.effort] ??
      EFFORT_TO_BUDGET.high)
    : 0
  const generated = protocol === "anthropic" && (options.maxThinkingTokens || effortBudget)
  const added = generated
    ? claude55CapabilitiesForModel(options.model)
      ? 0
      : options.maxThinkingTokens || effortBudget
    : protocol === "anthropic" && thinking?.type === "enabled"
      ? (thinking.budgetTokens ?? 0)
      : 0
  return Math.min(ceiling ?? Infinity, output + Math.max(0, added))
}

/** Recompute model-dependent retry limits for chat and Room/team dispatch alike. */
export function applyProviderAttemptLimits(
  options: SendOptions,
  settings: AppSettings | undefined,
  previousOutputLimit?: number
): Pick<SendOptions, "modelParams" | "compaction"> {
  let modelParams = options.modelParams
  const knownOutput = resolveModelMaxOutputTokens(
    options.model,
    options.provider,
    settings?.providerSettings,
    settings?.customProviders
  )
  const requestedOutput =
    modelParams?.maxOutputTokens ??
    (knownOutput !== undefined
      ? defaultOutputTokens(options.provider, options.model, knownOutput, modelParams)
      : undefined)
  const outputLimits = [requestedOutput, previousOutputLimit, knownOutput].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0
  )
  if (outputLimits.length)
    modelParams = { ...modelParams, maxOutputTokens: Math.min(...outputLimits) }
  let compaction = options.compaction
  if (compaction?.enabled && options.model && options.provider) {
    const contextWindow =
      resolveModelContextLength(
        options.model,
        options.provider,
        settings?.providerSettings,
        settings?.customProviders
      ) ?? getModelContextWindow(options.model)
    const maxInput = resolveModelMeta(
      options.provider,
      options.model,
      settings?.providerSettings,
      settings?.customProviders
    ).maxInputTokens
    const outputReserve = resolveProviderOutputReserve({ ...options, modelParams }, knownOutput)
    compaction = {
      ...compaction,
      contextWindow: Math.max(
        1,
        Math.min(contextWindow - outputReserve, maxInput ?? contextWindow)
      ),
    }
    const summaryOutput = resolveModelMaxOutputTokens(
      compaction.summary?.model ?? options.model,
      compaction.summary?.providerId ?? options.provider,
      settings?.providerSettings,
      settings?.customProviders
    )
    if (!compaction.summaryTokenBudgetIsDefault && compaction.maxSummaryTokens !== undefined) {
      const requested = compaction.requestedMaxSummaryTokens ?? compaction.maxSummaryTokens
      compaction.requestedMaxSummaryTokens = requested
      compaction.maxSummaryTokens = Math.min(requested, summaryOutput ?? Infinity)
    }
    const summaryProvider = compaction.summary?.providerId ?? options.provider
    const summaryModel = compaction.summary?.model ?? options.model
    const summaryWindow =
      resolveModelContextLength(
        summaryModel,
        summaryProvider,
        settings?.providerSettings,
        settings?.customProviders
      ) ?? getModelContextWindow(summaryModel)
    const summaryMaxInput = resolveModelMeta(
      summaryProvider,
      summaryModel,
      settings?.providerSettings,
      settings?.customProviders
    ).maxInputTokens
    if (compaction.summaryTokenBudgetIsDefault) {
      // A delta need not regenerate the cumulative checkpoint. Reserve a
      // half of small windows, bounded on large models, rather than their
      // full output capacity. Explicit caps above remain authoritative.
      const summaryProtocol =
        compaction.summary?.protocol ??
        compaction.summary?.credentials?.protocol ??
        compaction.summary?.providerId ??
        options.providerCredentials?.protocol ??
        options.provider
      const thinking = modelParams?.providerOptions?.anthropic?.thinking as
        { type?: string; budgetTokens?: number } | undefined
      const explicitThinking =
        summaryProtocol === "anthropic" &&
        !claude55CapabilitiesForModel(summaryModel) &&
        thinking?.type === "enabled"
          ? (thinking.budgetTokens ?? 1024)
          : 0
      compaction.maxSummaryTokens = Math.min(
        summaryOutput ?? Infinity,
        Math.max(1, summaryWindow - 1),
        Math.max(
          Math.min(32_768, Math.max(1, Math.floor(summaryWindow / 2))),
          explicitThinking > 0 ? explicitThinking + 1024 : 0
        )
      )
    }
    // The sidecar enforces this as total generated output, including thinking.
    const summaryReserve = compaction.maxSummaryTokens ?? 16_384
    compaction.summaryInputBudget = Math.max(
      1,
      Math.min(summaryWindow - summaryReserve, summaryMaxInput ?? summaryWindow)
    )
    if (
      compaction.checkpointTokenBudget === undefined ||
      compaction.checkpointTokenBudgetIsDefault
    ) {
      // Cumulative findings can exceed one generated delta. Leave a quarter
      // of retained input and summary input for navigation and new source.
      compaction.checkpointTokenBudget = Math.max(
        1,
        Math.floor(
          Math.min(
            compaction.contextWindow! *
              (compaction.retainedFraction ??
                DEFAULT_COMPRESSION_SETTINGS.retainedThreshold / 100) *
              0.75,
            compaction.summaryInputBudget * 0.75
          )
        )
      )
      compaction.checkpointTokenBudgetIsDefault = true
    }
    if (
      compaction.postCompactionTokenBudget === undefined ||
      compaction.postCompactionTokenBudgetIsDefault
    ) {
      compaction.postCompactionTokenBudget = Math.max(
        1,
        Math.floor(
          compaction.contextWindow! *
            (compaction.retainedFraction ?? DEFAULT_COMPRESSION_SETTINGS.retainedThreshold / 100)
        )
      )
      compaction.postCompactionTokenBudgetIsDefault = true
    }
  }
  return { modelParams, ...(compaction ? { compaction } : {}) }
}

/** Project the selected model's supported inference settings without reading credentials. */
export function buildProviderAttemptModelParams(
  providerId: string,
  targetModelId: string | undefined,
  appSettings: AppSettings
): SendOptions["modelParams"] {
  const subscriptionDefinition = getSubscriptionProvider(providerId, appSettings.customProviders)
  const providerConfig =
    appSettings.providerSettings?.[providerId] ??
    appSettings.customProviders?.find((provider) => provider.id === providerId)
  const params = buildModelInferenceParams(providerConfig, {
    providerId,
    // Capability conditions accept partial metadata: unknown fields are not
    // treated as explicit lack of support by the parameter resolver.
    modelConfig: targetModelId
      ? ({
          id: targetModelId,
          ...resolveModelMeta(
            providerId,
            targetModelId,
            appSettings.providerSettings,
            appSettings.customProviders
          ),
        } as ModelConfig)
      : undefined,
    schema: getSchemaForProvider(providerId, {
      ...Object.fromEntries(
        (appSettings.customProviders ?? []).map((provider) => [
          provider.id,
          { apiProtocol: provider.apiProtocol, name: provider.customName },
        ])
      ),
      ...(subscriptionDefinition?.source === "plugin" && subscriptionDefinition.protocol
        ? {
            [providerId]: {
              apiProtocol: subscriptionDefinition.protocol,
              name: subscriptionDefinition.name,
            },
          }
        : {}),
    }),
  })
  const limit = resolveModelMaxOutputTokens(
    targetModelId,
    providerId,
    appSettings.providerSettings,
    appSettings.customProviders
  )
  return limit !== undefined
    ? {
        ...params,
        maxOutputTokens: Math.min(
          params?.maxOutputTokens ?? defaultOutputTokens(providerId, targetModelId, limit, params),
          limit
        ),
      }
    : params
}

async function resolveProtocolAdapterSpec(
  protocol: string
): Promise<SendOptions["protocolAdapterSpec"] | undefined> {
  const { getProtocolAdapter } =
    await import("@cognia/provider-core/providers/protocol-adapter-registry")
  const adapterDef = getProtocolAdapter(protocol)
  if (!adapterDef) return undefined
  if (adapterDef.spec.kind === "code") {
    const separator = protocol.indexOf(":")
    return {
      kind: "code",
      pluginId: separator > 0 ? protocol.slice(0, separator) : protocol,
      adapterId: protocol,
    }
  }
  return adapterDef.spec
}

async function persistRotation(
  providerId: string,
  isCustomProvider: boolean,
  persisted: NonNullable<ReturnType<typeof recordKeyUse>>
): Promise<void> {
  try {
    const { useSettingsStore } = await import("@/stores/settings")
    const store = useSettingsStore.getState()
    if (isCustomProvider) {
      await store.updateCustomProvider(providerId, persisted)
    } else {
      await store.setProviderConfig(providerId, persisted)
    }
  } catch (error) {
    console.warn("api key rotation advance persist failed", error)
  }
}

/** Resolve the account-bound transport without mutating manual API settings. */
export async function resolveSubscriptionProviderCredential(
  providerId: string,
  appSettings: AppSettings,
  selectedAccountId?: string | null
): Promise<{
  apiKey: string
  baseURL: string
  headers?: Record<string, string>
  protocol?: string
  apiFlavor?: "chat" | "responses"
} | null> {
  const definition = getSubscriptionProvider(providerId, appSettings.customProviders)
  const accountProvider = definition?.id
  const subscriptionAccountId =
    selectedAccountId === undefined && accountProvider
      ? (appSettings.defaultAccountIds?.[accountProvider] ??
        (appSettings.defaultProvider === providerId ||
        appSettings.defaultProvider === accountProvider
          ? appSettings.defaultAccountId
          : null))
      : (selectedAccountId ?? null)
  const credential = isOpencodeChatProviderId(providerId)
    ? await resolveOpencodeVaultCredential(providerId, subscriptionAccountId)
    : isCodexChatProviderId(providerId)
      ? await resolveCodexVaultCredential(providerId, subscriptionAccountId)
      : providerId === "commandcode"
        ? await resolveCommandcodeVaultCredential(providerId, subscriptionAccountId)
        : definition
          ? await resolveManagedSubscriptionCredential(definition, subscriptionAccountId)
          : null
  if (!credential) return null
  const config =
    appSettings.providerSettings?.[providerId] ??
    appSettings.customProviders?.find((provider) => provider.id === providerId)
  const headers = {
    ...(definition?.billingMode === "subscription" ? {} : config?.customHeaders),
    ...credential.headers,
  }
  return {
    ...credential,
    ...(definition?.protocol && definition.source !== "builtin"
      ? { protocol: definition.protocol }
      : {}),
    ...(definition?.protocol === "openai" && definition.apiFlavor
      ? { apiFlavor: definition.apiFlavor }
      : {}),
    baseURL: isOpencodeChatProviderId(providerId)
      ? config?.baseURL?.trim() || credential.baseURL
      : credential.baseURL,
    ...(Object.keys(headers).length ? { headers } : {}),
  }
}

/** Stands in for a key the driven Host holds; never leaves this module. */
const HOST_KEY_PLACEHOLDER = "cognia-host-sealed-key"

/**
 * Resolve credentials and protocol metadata for one concrete provider
 * attempt. The result is intentionally separate from RoutingPlan so secrets
 * are obtained immediately before dispatch and never persisted with a plan.
 */
export async function resolveProviderAttemptOptions(
  providerId: string,
  appSettings: AppSettings,
  selectedAccountId?: string | null,
  preferSelectedAccount = Boolean(selectedAccountId),
  selectedModelId?: string
): Promise<ProviderAttemptOptions> {
  if (
    providerId.includes(":") &&
    !getAllProviders()[providerId] &&
    !appSettings.customProviders?.some((provider) => provider.id === providerId)
  )
    return {}
  const subscriptionDefinition = getSubscriptionProvider(providerId, appSettings.customProviders)
  const hasApiSubscription =
    !!subscriptionDefinition && subscriptionDefinition.authMode !== "anthropic-oauth"
  const preferSubscriptionAccount =
    (preferSelectedAccount || subscriptionDefinition?.billingMode === "subscription") &&
    hasApiSubscription
  // ADR-0224 A6: the `/pair` Host this device drives holds a key for this
  // built-in provider and this device has none. The turn names the provider
  // and its endpoint; the Host fills the key (`fill_host_provider_key`), which
  // never comes here. The placeholder only lets the resolver answer with the
  // endpoint, and is removed below before anything is sent.
  const hostKeyed =
    isRemoteHostKeyedProvider(providerId) &&
    !hasOwnKey(appSettings.providerSettings?.[providerId]) &&
    !appSettings.customProviders?.some((provider) => provider.id === providerId) &&
    !preferSubscriptionAccount
  const resolvableProviderSettings = hostKeyed
    ? {
        ...appSettings.providerSettings,
        [providerId]: {
          ...(appSettings.providerSettings?.[providerId] ?? { providerId }),
          enabled: true,
          apiKey: HOST_KEY_PLACEHOLDER,
        },
      }
    : appSettings.providerSettings
  const snapshot = createProviderSettingsSnapshot({
    defaultProvider: appSettings.defaultProvider,
    providerSettings: resolvableProviderSettings as
      Record<string, import("@/lib/ai/provider-consumption").ProviderSettingsEntry> | undefined,
    customProviders: appSettings.customProviders as
      import("@/lib/ai/provider-consumption").RichCustomProviderEntry[] | undefined,
  })
  const resolution = resolveFeatureProvider(
    {
      featureId: "chat-send",
      routeProfile: "general-text",
      selectionMode: "explicit-provider",
      providerId,
      fallbackMode: "none",
    },
    snapshot
  )
  const providerConfig =
    appSettings.providerSettings?.[providerId] ??
    appSettings.customProviders?.find((provider) => provider.id === providerId)
  const buildAttemptModelParams = (modelId?: string) =>
    buildProviderAttemptModelParams(providerId, selectedModelId ?? modelId, appSettings)

  if (resolution.kind === "resolved") {
    const providerCredentials: NonNullable<SendOptions["providerCredentials"]> = {
      apiKey: resolution.apiKey,
      baseURL: resolution.baseURL,
      protocol:
        subscriptionDefinition?.source === "plugin"
          ? subscriptionDefinition.protocol!
          : resolution.protocol,
      ...(subscriptionDefinition?.source === "plugin" &&
      subscriptionDefinition.protocol === "openai"
        ? { apiFlavor: subscriptionDefinition.apiFlavor ?? "chat" }
        : resolution.apiFlavor
          ? { apiFlavor: resolution.apiFlavor }
          : {}),
      ...(resolution.bedrock
        ? {
            bedrockAuthMode: resolution.bedrock.authMode,
            region: resolution.bedrock.region,
            accessKeyId: resolution.bedrock.accessKeyId,
            secretAccessKey: resolution.bedrock.secretAccessKey,
            sessionToken: resolution.bedrock.sessionToken,
            profile: resolution.bedrock.profile,
            roleArn: resolution.bedrock.roleArn,
            roleSessionName: resolution.bedrock.roleSessionName,
          }
        : {}),
    }
    // Parameters tab → AI SDK call options, including the provider-specific
    // knobs projected through the provider's parameter schema (`providerOptions`).
    const modelParams = buildAttemptModelParams(resolution.model)
    // Static transport headers from the settings UI (`customHeaders`) — the
    // resolver already folded them into `resolution.headers`. Vault-issued
    // relay headers (Codex) are merged on top below and win on collision.
    if (resolution.headers) providerCredentials.headers = { ...resolution.headers }

    if (hostKeyed) {
      delete providerCredentials.apiKey
      return {
        providerCredentials,
        protocolAdapterSpec: await resolveProtocolAdapterSpec(
          providerCredentials.protocol ?? resolution.protocol
        ),
        ...(modelParams ? { modelParams } : {}),
        ...(resolution.model ? { defaultModel: resolution.model } : {}),
      }
    }

    if (providerConfig?.apiKeyRotationEnabled && !preferSubscriptionAccount) {
      const selection = selectApiKey(providerConfig)
      if (selection.apiKey) providerCredentials.apiKey = selection.apiKey
      const persisted = recordKeyUse(providerConfig, selection)
      if (persisted) {
        void persistRotation(providerId, resolution.isCustomProvider, persisted)
      }
    }
    if ((!resolution.apiKey || preferSubscriptionAccount) && hasApiSubscription) {
      const vaultCredential = await resolveSubscriptionProviderCredential(
        providerId,
        appSettings,
        selectedAccountId
      )
      // A deliberate account switch must never silently bill the manual key.
      if (
        !vaultCredential &&
        (preferSubscriptionAccount ||
          subscriptionDefinition?.source === "custom" ||
          subscriptionDefinition?.source === "plugin")
      )
        return {}
      if (vaultCredential) {
        providerCredentials.apiKey = vaultCredential.apiKey
        providerCredentials.baseURL = vaultCredential.baseURL
        if (vaultCredential.protocol) providerCredentials.protocol = vaultCredential.protocol
        if (vaultCredential.apiFlavor) providerCredentials.apiFlavor = vaultCredential.apiFlavor
        if (subscriptionDefinition?.billingMode === "subscription") {
          delete providerCredentials.headers
        }
        if (vaultCredential.headers) {
          providerCredentials.headers = {
            ...providerCredentials.headers,
            ...vaultCredential.headers,
          }
        }
      }
    }

    return {
      providerCredentials,
      protocolAdapterSpec: await resolveProtocolAdapterSpec(
        providerCredentials.protocol ?? resolution.protocol
      ),
      ...(modelParams ? { modelParams } : {}),
      ...(resolution.model ? { defaultModel: resolution.model } : {}),
      ...(typeof providerConfig?.connectionParams?.concurrentLimit === "number" &&
      Number.isFinite(providerConfig.connectionParams.concurrentLimit) &&
      providerConfig.connectionParams.concurrentLimit > 0
        ? { concurrentLimit: Math.floor(providerConfig.connectionParams.concurrentLimit) }
        : {}),
    }
  }

  if (hasApiSubscription && resolution.nextAction !== "enable_provider") {
    const vaultCredential = await resolveSubscriptionProviderCredential(
      providerId,
      appSettings,
      selectedAccountId
    )
    if (vaultCredential) {
      const defaultModel =
        subscriptionDefinition?.models?.[0] ?? getBuiltInProviderDefaultModel(providerId)
      const modelParams = buildAttemptModelParams(defaultModel)
      return {
        providerCredentials: {
          ...vaultCredential,
          protocol: subscriptionDefinition?.protocol ?? "openai",
        },
        defaultModel,
        ...(modelParams ? { modelParams } : {}),
      }
    }
  }
  return {}
}
