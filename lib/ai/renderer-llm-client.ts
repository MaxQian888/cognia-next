/**
 * Shared renderer-side `LlmClient` factory for direct (non-sidecar) provider
 * calls.
 *
 * Some features run a provider call straight from the renderer instead of
 * through the Claude sidecar: the `/goal` judge (`lib/goal/judge-client.ts`)
 * and the background "utility model" tasks — conversation-title + timeline
 * label (`lib/ai/generation/utility-client.ts`). They all need the SAME
 * resolution chain (snapshot → `resolveFeatureProvider` → `createLlmClient`)
 * and the same renderer-key requirement, so it lives here once. Each feature
 * wraps this with its own override shape + telemetry `featureId`.
 *
 * Returns `null` (a signal, not an error) when no provider resolves with a
 * renderer-side API key — e.g. a legacy `ANTHROPIC_API_KEY`-env-only setup,
 * where the key lives in the sidecar and is never exposed to the renderer —
 * or when no model is determinable. Callers treat `null` as "silently skip".
 */

import type { AppSettings, ChatSession } from "@cognia/agent-config-types"
import { createLlmClient, type LlmClient } from "@/lib/twin/distill/llm"
import {
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
  type ProviderSettingsEntry,
  type RichCustomProviderEntry,
} from "@/lib/ai/provider-consumption"

export interface BuildRendererLlmClientArgs {
  session: ChatSession | null | undefined
  appSettings: AppSettings | null | undefined
  /** Telemetry-only feature id forwarded to the resolver. */
  featureId: string
  /** Explicit per-feature provider id override (highest priority). */
  providerOverride?: string
  /** Explicit per-feature model id override (highest priority). */
  modelOverride?: string
  /**
   * Lower-priority model preference: used when no explicit `modelOverride` is
   * given, but preferred over inheriting the session/default model. Useful for
   * utility tasks that should use a cheap model regardless of what the user's
   * session is configured for.
   */
  modelPreference?: string
}

/**
 * Build the `LlmClient` for a renderer-side feature call. Provider resolution
 * order: explicit override → session override → app default → anthropic. Model
 * order: explicit override → model preference → session model → resolved
 * provider default → app default model.
 */
export function buildRendererLlmClient({
  session,
  appSettings,
  featureId,
  providerOverride,
  modelOverride,
  modelPreference,
}: BuildRendererLlmClientArgs): LlmClient | null {
  if (!appSettings) return null

  const providerId =
    providerOverride ?? session?.providerOverride ?? appSettings.defaultProvider ?? "anthropic"

  const snapshot = createProviderSettingsSnapshot({
    defaultProvider: appSettings.defaultProvider,
    providerSettings: appSettings.providerSettings as
      Record<string, ProviderSettingsEntry> | undefined,
    customProviders: appSettings.customProviders as RichCustomProviderEntry[] | undefined,
  })

  const resolution = resolveFeatureProvider(
    {
      featureId,
      routeProfile: "general-text",
      selectionMode: "explicit-provider",
      providerId,
      fallbackMode: "none",
    },
    snapshot
  )

  if (resolution.kind !== "resolved") return null
  // No renderer key → can't build a client. (The anthropic legacy env path only
  // works inside the sidecar; these calls run in the renderer.)
  if (!resolution.apiKey) return null

  const model =
    modelOverride ??
    modelPreference ??
    session?.model ??
    resolution.model ??
    appSettings.defaultModel
  if (!model) return null

  // Plugin-contributed protocol ids (`${pluginId}:${id}`) execute only in the
  // sidecar's declarative variant adapter — the renderer client has no
  // executor for them, so utility features degrade gracefully to null.
  if (!isRendererExecutableProtocol(resolution.protocol)) return null

  return createLlmClient({
    // `protocol` (openai | anthropic | google | mistral | cohere) maps 1:1 to
    // createLlmClient's provider family; a custom OpenAI-compatible provider
    // resolves to protocol "openai" + its baseURL.
    provider: resolution.protocol,
    model,
    apiKey: resolution.apiKey,
    baseURL: resolution.baseURL,
    apiFlavor: resolution.apiFlavor,
  })
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
