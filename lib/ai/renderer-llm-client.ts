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
import { ledgerUtilityCalls, type UtilityRunOrigin } from "@/lib/router-fusion/gate/utility-ledger"
import type { RouterFusionSurface } from "@cognia/router-fusion/settings/switches"
import { createLlmClient, type LlmClient } from "@/lib/twin/distill/llm"
import {
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
  type ProviderSettingsEntry,
  type RichCustomProviderEntry,
} from "@/lib/ai/provider-consumption"
import { resolveAppDefaultModel } from "./app-default-model"
import { isExternalAgentProviderId } from "@/lib/ai/agent/external/session/session-models"
import { isRoutingPlaceholderModel } from "./routing/auto-model-resolution"

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
  /**
   * Which Router + Fusion surface owns this call (ADR-0188 D27/D36). Background
   * utilities — titles, labels, judges — are `utilityLedger`; a call a workflow
   * node or an agent makes is `agentsWorkflows`. With that surface's switch off
   * (the default) the client comes back exactly as it is built here.
   */
  ledgerSurface?: Extract<RouterFusionSurface, "utilityLedger" | "agentsWorkflows">
  /** Where the run came from, for the run list. Defaults to the surface's own kind. */
  ledgerOrigin?: UtilityRunOrigin
  /** Workspace the call belongs to, for the data-class policy (D30). */
  workspaceId?: string | null
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
  ledgerSurface = "utilityLedger",
  ledgerOrigin,
  workspaceId = null,
}: BuildRendererLlmClientArgs): LlmClient | null {
  if (!appSettings) return null

  // Both the session override and the app-wide default can carry the reserved
  // external-agent marker, which names no provider. Left in, `providerId`
  // became `cognia:external-agent:<id>`, `resolveFeatureProvider` resolved
  // nothing, and this factory returned `null` for EVERY renderer-side feature
  // (conversation titles, timeline labels, the /goal judge) as long as the app
  // default pointed at an agent. These are provider calls, so they read the
  // pair on the provider lane and fall through to anthropic like any other
  // unset default. See `lib/ai/app-default-model.ts`.
  const appDefault = resolveAppDefaultModel(appSettings)
  const sessionProvider = isExternalAgentProviderId(session?.providerOverride)
    ? undefined
    : session?.providerOverride

  const providerId = providerOverride ?? sessionProvider ?? appDefault.provider ?? "anthropic"

  const snapshot = createProviderSettingsSnapshot({
    defaultProvider: appDefault.provider,
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

  // A session model that is really a routing request — `"auto"` or an enabled
  // mapping alias — is not a dispatchable model id on this rail: the engine
  // resolves placeholders on the send path; here it reads as unset and the
  // resolution/default chain below supplies a concrete model.
  const sessionModel = isExternalAgentProviderId(session?.providerOverride)
    ? undefined
    : isRoutingPlaceholderModel(session?.model, appSettings.modelMappings)
      ? undefined
      : session?.model
  const model =
    modelOverride ??
    modelPreference ??
    // Same reason as the provider above: a row stamped with the marker holds
    // the agent's own model id, and no provider offers it.
    sessionModel ??
    resolution.model ??
    appDefault.model
  if (!model) return null

  // Plugin-contributed protocol ids (`${pluginId}:${id}`) execute only in the
  // sidecar's declarative variant adapter — the renderer client has no
  // executor for them, so utility features degrade gracefully to null.
  if (!isRendererExecutableProtocol(resolution.protocol)) return null

  const client = createLlmClient(llmConfigOf(resolution, model))
  // Every feature on this rail goes through one seam, so D27 ("every LLM
  // generation is reserved and settled") holds for all of them at once. Off —
  // the default — this hands `client` straight back.
  return ledgerUtilityCalls(client, {
    binding: {
      surface: ledgerSurface,
      origin: ledgerOrigin ?? (ledgerSurface === "agentsWorkflows" ? "workflow" : "utility"),
      featureId,
      // The app's own provider id, not the SDK protocol: pricing, data policy
      // and the circuit breakers are all keyed by it.
      providerId,
      modelId: model,
      workspaceId,
    },
    settings: appSettings,
  })
}

/**
 * The `createLlmClient` config one resolved provider becomes. `protocol`
 * (openai | anthropic | azure | google | mistral | cohere) maps 1:1 to the SDK
 * family; a custom OpenAI-compatible provider resolves to protocol "openai"
 * plus its own baseURL.
 */
function llmConfigOf(
  resolution: { protocol: string; apiKey?: string; baseURL?: string; apiFlavor?: unknown },
  model: string
): Parameters<typeof createLlmClient>[0] {
  return {
    provider: resolution.protocol as Parameters<typeof createLlmClient>[0]["provider"],
    model,
    apiKey: resolution.apiKey as string,
    baseURL: resolution.baseURL,
    apiFlavor: resolution.apiFlavor as Parameters<typeof createLlmClient>[0]["apiFlavor"],
  }
}

/**
 * Credentials for one concrete `providerId::modelId`, with no session or
 * default chain in the way — the deployment is already decided.
 *
 * Router + Fusion's role-call executor (ADR-0188 B2) resolves a deployment this
 * way: a run pinned its role to a deployment when it was routed, and a run must
 * call exactly that one or refuse. Returns null on the same terms as
 * `buildRendererLlmClient`: no renderer key, or a protocol only the sidecar can
 * execute.
 */
export function resolveDeploymentLlmConfig(
  appSettings: AppSettings,
  providerId: string,
  modelId: string,
  featureId: string
): Parameters<typeof createLlmClient>[0] | null {
  const snapshot = createProviderSettingsSnapshot({
    defaultProvider: resolveAppDefaultModel(appSettings).provider,
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
  if (resolution.kind !== "resolved" || !resolution.apiKey) return null
  if (!isRendererExecutableProtocol(resolution.protocol)) return null
  return llmConfigOf(resolution, modelId)
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
