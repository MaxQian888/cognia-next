import type { AppSettings } from "@cognia/agent-config-types"
import type { EvalCapability, EvalProjectDataset, EvalVariant } from "@cognia/eval-core"
import type { EvalCase, EvalDataset } from "@/types/eval/eval"
import type { EvalDatasetVersion } from "@/types/eval/version"
import {
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
  type ProviderSettingsEntry,
  type RichCustomProviderEntry,
} from "@/lib/ai/provider-consumption"
import { getDataset, listCases } from "@/lib/db/eval-datasets"
import { snapshotVersion } from "@/lib/db/eval-dataset-versions"
import { resolveModelMeta } from "@/lib/ai/model-options"
import { isConfirmedLocalProvider } from "./provider-locality"

export interface EvalDatasetSelectionDependencies {
  getDataset(id: string): Promise<EvalDataset | undefined>
  listCases(datasetId: string): Promise<EvalCase[]>
  snapshotVersion(datasetId: string): Promise<EvalDatasetVersion>
}

const defaultDatasetDependencies: EvalDatasetSelectionDependencies = {
  getDataset,
  listCases,
  snapshotVersion,
}

function mediaCapability(mediaType: string): EvalCapability {
  if (mediaType.startsWith("image/")) return "image"
  if (mediaType.startsWith("audio/")) return "audio"
  if (mediaType.startsWith("video/")) return "video"
  return "document"
}

function modelCatalogFingerprint(
  providerId: string,
  modelId: string,
  metadata: ReturnType<typeof resolveModelMeta>
): string {
  const input = JSON.stringify({ providerId, modelId, metadata })
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`
}

function deriveRequiredModalities(dataset: EvalDataset, cases: EvalCase[]): EvalCapability[] {
  const capabilities = new Set<EvalCapability>(["text"])
  for (const evalCase of cases) {
    for (const part of evalCase.contentParts ?? []) {
      if (part.type === "asset") capabilities.add(mediaCapability(part.mediaType))
    }
  }
  const tags = [dataset.capability, ...cases.map((item) => item.capability)].join(" ").toLowerCase()
  if (tags.includes("tool")) capabilities.add("tool")
  if (tags.includes("structured")) capabilities.add("structured-output")
  if (tags.includes("rag") || tags.includes("retriev")) capabilities.add("rag")
  if (tags.includes("trajectory") || tags.includes("agent")) capabilities.add("trajectory")
  const order: EvalCapability[] = [
    "text",
    "image",
    "audio",
    "video",
    "document",
    "tool",
    "structured-output",
    "rag",
    "trajectory",
  ]
  return order.filter((item) => capabilities.has(item))
}

export async function loadEvalDatasetSelection(
  datasetId: string,
  dependencies: EvalDatasetSelectionDependencies = defaultDatasetDependencies
): Promise<EvalProjectDataset> {
  const dataset = await dependencies.getDataset(datasetId)
  if (!dataset) throw new Error(`Evaluation dataset ${datasetId} not found`)
  const [cases, version] = await Promise.all([
    dependencies.listCases(datasetId),
    dependencies.snapshotVersion(datasetId),
  ])
  return {
    datasetId,
    version: dataset.version,
    digest: `fnv1a:${version.casesHash}`,
    caseIds: cases.map((item) => item.id),
    holdoutCaseIds: cases
      .filter((item) => item.split === "test" || item.split === "holdout")
      .map((item) => item.id),
    requiredModalities: deriveRequiredModalities(dataset, cases),
  }
}

export function resolveEvalVariantReadiness(
  variant: EvalVariant,
  appSettings: AppSettings | null
): EvalVariant {
  if (variant.kind === "team" || variant.kind === "workflow") {
    const configured = Boolean(variant.targetId?.trim())
    return {
      ...variant,
      isLocal: false,
      available: configured,
      credentialReady: configured,
      runtimeReady:
        variant.runtimeTarget === "web" ||
        typeof window === "undefined" ||
        "__TAURI_INTERNALS__" in window,
    }
  }
  if (!appSettings || !variant.providerId?.trim() || !variant.modelId?.trim()) {
    return { ...variant, available: false, credentialReady: false }
  }
  const snapshot = createProviderSettingsSnapshot({
    defaultProvider: appSettings.defaultProvider,
    providerSettings: appSettings.providerSettings as
      Record<string, ProviderSettingsEntry> | undefined,
    customProviders: appSettings.customProviders as RichCustomProviderEntry[] | undefined,
  })
  const resolution = resolveFeatureProvider(
    {
      featureId: "eval.preflight",
      routeProfile: "capability-bound",
      selectionMode: "explicit-provider",
      providerId: variant.providerId,
      fallbackMode: "none",
      executionMode: "direct-model",
      proxyMode: "never",
    },
    snapshot
  )
  const metadata = resolveModelMeta(
    variant.providerId,
    variant.modelId,
    appSettings.providerSettings,
    appSettings.customProviders
  )
  const capabilities = new Set(variant.capabilities)
  if (metadata.supportsVision) capabilities.add("image")
  if (metadata.supportsTools) capabilities.add("tool")
  return {
    ...variant,
    isLocal: resolution.kind === "resolved" && isConfirmedLocalProvider(resolution),
    capabilities: [...capabilities],
    catalogFingerprint: modelCatalogFingerprint(variant.providerId, variant.modelId, metadata),
    available: resolution.kind === "resolved",
    credentialReady: resolution.kind === "resolved",
    runtimeReady:
      variant.runtimeTarget === "web" ||
      typeof window === "undefined" ||
      "__TAURI_INTERNALS__" in window,
  }
}

export function listEvalProviderIds(appSettings: AppSettings | null): string[] {
  if (!appSettings) return []
  return [
    ...new Set([
      ...Object.keys(appSettings.providerSettings ?? {}),
      ...(appSettings.customProviders ?? [])
        .filter((provider) => provider.enabled !== false)
        .map((provider) => provider.id),
    ]),
  ].sort((a, b) => a.localeCompare(b))
}

export function resolveEvalProviderLocality(
  providerId: string,
  appSettings: AppSettings | null
): boolean {
  if (!appSettings || !providerId.trim()) return false
  const resolution = resolveFeatureProvider(
    {
      featureId: "eval.locality",
      routeProfile: "capability-bound",
      selectionMode: "explicit-provider",
      providerId,
      fallbackMode: "none",
      executionMode: "direct-model",
      proxyMode: "never",
    },
    createProviderSettingsSnapshot({
      defaultProvider: appSettings.defaultProvider,
      providerSettings: appSettings.providerSettings as
        Record<string, ProviderSettingsEntry> | undefined,
      customProviders: appSettings.customProviders as RichCustomProviderEntry[] | undefined,
    })
  )
  return resolution.kind === "resolved" && isConfirmedLocalProvider(resolution)
}
