import type { LanguageModel } from "ai"
import type { AppSettings } from "@cognia/agent-config-types"
import {
  createFeatureProviderModel,
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
  type ProviderSettingsEntry,
  type RichCustomProviderEntry,
} from "@/lib/ai/provider-consumption"
import { getBuiltInProviderDefaultModel } from "@cognia/provider-types/built-in-provider-catalog"

/** The catalog's Anthropic default, resolved lazily so it can never go stale. */
function anthropicDefaultModel(): string | undefined {
  return getBuiltInProviderDefaultModel("anthropic")
}

export function buildTeamClaudeRuntimeModel(
  settings: AppSettings | null | undefined
): LanguageModel {
  const providerId = settings?.defaultProvider ?? "anthropic"
  if (settings) {
    const snapshot = createProviderSettingsSnapshot({
      defaultProvider: settings.defaultProvider,
      providerSettings: settings.providerSettings as
        Record<string, ProviderSettingsEntry> | undefined,
      customProviders: settings.customProviders as RichCustomProviderEntry[] | undefined,
    })
    const resolution = resolveFeatureProvider(
      {
        featureId: "agent-team-claude-runtime",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId,
        fallbackMode: "none",
      },
      snapshot
    )

    if (resolution.kind === "resolved" && isRendererExecutableProtocol(resolution.protocol)) {
      return createFeatureProviderModel({
        ...resolution,
        model: resolution.model ?? settings.defaultModel,
      }) as LanguageModel
    }
  }

  return createFeatureProviderModel({
    kind: "resolved",
    providerId: "anthropic",
    protocol: "anthropic",
    apiKey: settings?.apiKey,
    baseURL: undefined,
    model: settings?.defaultModel ?? anthropicDefaultModel(),
    isCustomProvider: false,
    useProxy: false,
  }) as LanguageModel
}

const RENDERER_EXECUTABLE_PROTOCOLS = new Set([
  "anthropic",
  "openai",
  "azure",
  "google",
  "mistral",
  "cohere",
] as const)

function isRendererExecutableProtocol(
  protocol: string
): protocol is "anthropic" | "openai" | "azure" | "google" | "mistral" | "cohere" {
  return RENDERER_EXECUTABLE_PROTOCOLS.has(
    protocol as "anthropic" | "openai" | "azure" | "google" | "mistral" | "cohere"
  )
}
