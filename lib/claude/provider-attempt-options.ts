import type { AppSettings, SendOptions } from "@cognia/agent-config-types"
import {
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
} from "@/lib/ai/provider-consumption"
import { buildModelInferenceParams } from "@cognia/provider-core/providers/inference-params"
import { recordKeyUse, selectApiKey } from "@cognia/provider-core/providers/api-key-rotation"
import { resolveOpencodeVaultCredential } from "@/lib/subscription/opencode/chat-bridge"
import { resolveCodexVaultCredential } from "@/lib/subscription/codex/chat-bridge"
import { isCodexChatProviderId, isOpencodeChatProviderId } from "@/types/subscription"
import { getBuiltInProviderDefaultModel } from "@cognia/provider-types/built-in-provider-catalog"

export interface ProviderAttemptOptions {
  providerCredentials?: SendOptions["providerCredentials"]
  protocolAdapterSpec?: SendOptions["protocolAdapterSpec"]
  modelParams?: SendOptions["modelParams"]
  defaultModel?: string
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

/**
 * Resolve credentials and protocol metadata for one concrete provider
 * attempt. The result is intentionally separate from RoutingPlan so secrets
 * are obtained immediately before dispatch and never persisted with a plan.
 */
export async function resolveProviderAttemptOptions(
  providerId: string,
  appSettings: AppSettings,
  selectedAccountId?: string | null
): Promise<ProviderAttemptOptions> {
  const accountProvider =
    providerId === "anthropic" || providerId === "codex"
      ? providerId
      : providerId === "opencode" || providerId === "opencode-go"
        ? "opencode"
        : null
  const subscriptionAccountId =
    selectedAccountId === undefined && accountProvider
      ? (appSettings.defaultAccountIds?.[accountProvider] ??
        (appSettings.defaultProvider === providerId ||
        appSettings.defaultProvider === accountProvider
          ? appSettings.defaultAccountId
          : null))
      : (selectedAccountId ?? null)
  const snapshot = createProviderSettingsSnapshot({
    defaultProvider: appSettings.defaultProvider,
    providerSettings: appSettings.providerSettings as
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

  if (resolution.kind === "resolved") {
    const providerCredentials: NonNullable<SendOptions["providerCredentials"]> = {
      apiKey: resolution.apiKey,
      baseURL: resolution.baseURL,
      protocol: resolution.protocol,
      ...(resolution.apiFlavor ? { apiFlavor: resolution.apiFlavor } : {}),
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
    const providerConfig =
      appSettings.providerSettings?.[providerId] ??
      appSettings.customProviders?.find((provider) => provider.id === providerId)
    const modelParams = buildModelInferenceParams(providerConfig)

    if (providerConfig?.apiKeyRotationEnabled) {
      const selection = selectApiKey(providerConfig)
      if (selection.apiKey) providerCredentials.apiKey = selection.apiKey
      const persisted = recordKeyUse(providerConfig, selection)
      if (persisted) {
        void persistRotation(providerId, resolution.isCustomProvider, persisted)
      }
    }
    if (!resolution.apiKey && isOpencodeChatProviderId(providerId)) {
      const vaultCredential = await resolveOpencodeVaultCredential(
        providerId,
        subscriptionAccountId
      )
      if (vaultCredential) providerCredentials.apiKey = vaultCredential.apiKey
    }
    if (!resolution.apiKey && isCodexChatProviderId(providerId)) {
      const vaultCredential = await resolveCodexVaultCredential(providerId, subscriptionAccountId)
      if (vaultCredential) {
        providerCredentials.apiKey = vaultCredential.apiKey
        providerCredentials.baseURL = vaultCredential.baseURL
        if (vaultCredential.headers) providerCredentials.headers = vaultCredential.headers
      }
    }

    return {
      providerCredentials,
      protocolAdapterSpec: await resolveProtocolAdapterSpec(resolution.protocol),
      ...(modelParams ? { modelParams } : {}),
      ...(resolution.model ? { defaultModel: resolution.model } : {}),
    }
  }

  if (isOpencodeChatProviderId(providerId) && resolution.nextAction !== "enable_provider") {
    const vaultCredential = await resolveOpencodeVaultCredential(providerId, subscriptionAccountId)
    if (vaultCredential) {
      return {
        providerCredentials: {
          apiKey: vaultCredential.apiKey,
          baseURL: vaultCredential.baseURL,
          protocol: "openai",
        },
        defaultModel: getBuiltInProviderDefaultModel(providerId),
      }
    }
  }
  if (isCodexChatProviderId(providerId) && resolution.nextAction !== "enable_provider") {
    const vaultCredential = await resolveCodexVaultCredential(providerId, subscriptionAccountId)
    if (vaultCredential) {
      return {
        providerCredentials: {
          apiKey: vaultCredential.apiKey,
          baseURL: vaultCredential.baseURL,
          protocol: "openai",
          ...(vaultCredential.headers ? { headers: vaultCredential.headers } : {}),
        },
        defaultModel: getBuiltInProviderDefaultModel(providerId),
      }
    }
  }
  return {}
}
