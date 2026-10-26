import { reasoningTiersFor } from "@cognia/provider-core/providers/reasoning-tiers"
import { isHeadlessHost } from "@/lib/platform/detect"

/** What sub-task model validation needs to know about one provider's models. */
export interface GatewayModelFacts {
  modelSupportsReasoning: (modelId: string) => boolean | undefined
  modelEffortValues?: (modelId: string) => readonly string[] | undefined
}

/**
 * The model facts both saving and admitting sub-task models are judged by, so
 * a configuration that saves is one that runs. The app reads its own provider
 * settings; a headless Host has none and asks its gateway for the metadata it
 * routes with, where a model without a `supportsReasoning: true` record takes
 * no effort and one with it takes the provider's reasoning tiers.
 */
export async function resolveGatewayModelFacts(providerId: string): Promise<GatewayModelFacts> {
  if (isHeadlessHost()) {
    const { transport } = await import("@/lib/tauri")
    const capabilities = await transport.call<{
      providers?: Array<{
        id: string
        modelMetadataById?: Record<string, { supportsReasoning?: boolean }>
      }>
    }>("gateway_provider_capabilities")
    const metadata =
      capabilities.providers?.find((provider) => provider.id === providerId)?.modelMetadataById ??
      {}
    // The tier table the Codex catalog request also offers a Host-run task.
    return {
      modelSupportsReasoning: (modelId) => metadata[modelId]?.supportsReasoning === true,
      modelEffortValues: (modelId) =>
        metadata[modelId]?.supportsReasoning === true
          ? reasoningTiersFor({ providerId, modelId, reasoning: true })
          : undefined,
    }
  }
  const [{ cogniaModelReasoningFacts }, { useSettingsStore }] = await Promise.all([
    import("./cognia-model-options"),
    import("@/stores/settings"),
  ])
  const settings = useSettingsStore.getState().settings
  return cogniaModelReasoningFacts(providerId, {
    providerSettings: settings?.providerSettings ?? {},
    customProviders: settings?.customProviders,
  })
}
