import { getTwinSource } from "@/lib/db/twin-sources"
import { currentRouterFusionGateSettings } from "@/lib/router-fusion/gate/current-settings"
import { ledgerUtilityCalls } from "@/lib/router-fusion/gate/utility-ledger"
import { createAnthropicLlmClient } from "@/lib/twin/distill"
import { type JobWorkerConfig, type SourceLoader } from "@/lib/twin/job-worker"
import {
  buildTwinRuntimeAdapters,
  deriveTwinVectorStoreConfig,
} from "@/lib/twin/runtime/build-deps"
import type { TwinRuntimeSettings, TwinSource } from "@/types/twin"

function buildSourceLoader(): SourceLoader {
  return async (source: TwinSource) => {
    const refreshed = await getTwinSource(source.id)
    if (!refreshed) throw new Error(`twin source ${source.id} disappeared mid-load`)
    return {
      id: refreshed.id,
      filename: refreshed.title,
      format: refreshed.format,
      text: refreshed.source,
      ...(refreshed.speakers?.length ? { baseMetadata: { speakers: refreshed.speakers } } : {}),
    }
  }
}

export function isTwinWorkerConfigComplete(settings: TwinRuntimeSettings): boolean {
  if (!settings.workerEnabled) return false
  if (!deriveTwinVectorStoreConfig(settings)) return false
  if (!settings.llm.apiKey) return false
  return true
}

export async function buildTwinWorkerConfig(
  settings: TwinRuntimeSettings
): Promise<JobWorkerConfig | null> {
  if (!settings.workerEnabled || !settings.llm.apiKey) return null
  const runtime = await buildTwinRuntimeAdapters(settings)
  if (!runtime.ready) return null
  const llm = createAnthropicLlmClient({
    provider: settings.llm.provider,
    model: settings.llm.model,
    apiKey: settings.llm.apiKey,
    baseURL: settings.llm.baseURL,
  })
  return {
    embedding: settings.embedding,
    vectorBackend: settings.storage.vectorBackend,
    store: runtime.adapters.store,
    sourceLoader: buildSourceLoader(),
    nameHints: settings.extraNameHints,
    // Distillation is background generation, so Router + Fusion reserves and
    // settles every sub-agent call the worker makes when `utilityLedger` is on
    // (ADR-0188 D27). Off — the default — `ledgerUtilityCalls` hands `llm` back
    // untouched and no Router + Fusion module is loaded.
    llm: ledgerUtilityCalls(llm, {
      binding: {
        surface: "utilityLedger",
        origin: "utility",
        featureId: "twin-distill-worker",
        providerId: settings.llm.provider,
        modelId: settings.llm.model,
        workspaceId: null,
      },
      settings: await currentRouterFusionGateSettings(),
    }),
  }
}
