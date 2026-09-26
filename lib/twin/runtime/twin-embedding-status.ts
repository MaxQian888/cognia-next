/**
 * IO half of per-twin embedding: loads the twin row + credentials and answers
 * "what does this twin embed with, and does its index still match?".
 *
 * The pure rules live in `./twin-embedding`. This module is the single place
 * that reads them against Dexie and the chat-provider settings store, so
 * ingest (`lib/twin/job-worker.ts`), retrieval (`applyTwinContext`), the
 * workbench card and the agent editor all see the same answer.
 *
 * Legacy behaviour: a twin indexed before `Twin.embeddingIndex` existed has no
 * record. It never reports `rebuildRequired`; retrieval keeps relying on the
 * dimension guard alone, and ingest records the fingerprint only once every
 * chunk of the twin was written under one model (a full re-ingest or a
 * rebuild). `legacyIndex` tells the UI to recommend a rebuild.
 */

import { getTwin, setTwinEmbeddingIndex } from "@/lib/db/twins"
import { getDb } from "@/lib/db/schema"
import type {
  Twin,
  TwinEmbeddingIndexRecord,
  TwinEmbeddingOverride,
  TwinRuntimeEmbeddingSettings,
} from "@/types/twin"
import type { RagEmbeddingProvider } from "@cognia/provider-embedding/embedding-catalog"
import {
  TWIN_EMBEDDING_UNCONFIGURED,
  buildTwinEmbeddingIndexRecord,
  describeTwinIndexMismatch,
  expectedTwinEmbeddingDimensions,
  resolveTwinEmbeddingConfig,
  sameEmbeddingModel,
  twinIndexRebuildRequired,
  type EmbeddingProviderSettingsMap,
  type TwinEffectiveEmbedding,
  type TwinEmbeddingSource,
} from "./twin-embedding"

export interface TwinEmbeddingPlan extends TwinEffectiveEmbedding {
  twinId: string
  /** Undefined when the twin row does not exist (the global config applies). */
  twin?: Twin
  index?: TwinEmbeddingIndexRecord
  rebuildRequired: boolean
}

export interface TwinEmbeddingIoDeps {
  getTwin: (twinId: string) => Promise<Twin | undefined>
  loadProviderSettings: () => Promise<EmbeddingProviderSettingsMap>
}

async function loadProviderSettingsFromStore(): Promise<EmbeddingProviderSettingsMap> {
  const { useSettingsStore } = await import("@/stores/settings")
  return (useSettingsStore.getState().settings?.providerSettings ??
    {}) as EmbeddingProviderSettingsMap
}

const defaultIoDeps: TwinEmbeddingIoDeps = {
  getTwin,
  loadProviderSettings: loadProviderSettingsFromStore,
}

/** Provider settings are only needed when the override leaves the global provider. */
function needsProviderSettings(
  override: TwinEmbeddingOverride | undefined,
  global: TwinRuntimeEmbeddingSettings
): boolean {
  return Boolean(override && override.provider !== global.provider)
}

/**
 * Resolve the embedding a twin embeds with right now, plus its recorded index
 * state. `globalEmbedding` is the global twin-runtime embedding with its key
 * already hydrated (the `embedding` of the runtime deps / worker config).
 */
export async function loadTwinEmbeddingPlan(
  twinId: string,
  globalEmbedding: TwinRuntimeEmbeddingSettings,
  deps: TwinEmbeddingIoDeps = defaultIoDeps
): Promise<TwinEmbeddingPlan> {
  const twin = await deps.getTwin(twinId)
  const override = twin?.embedding
  const providerSettings = needsProviderSettings(override, globalEmbedding)
    ? await deps.loadProviderSettings()
    : undefined
  const effective = resolveTwinEmbeddingConfig({
    override,
    global: globalEmbedding,
    providerSettings,
  })
  const index = twin?.embeddingIndex
  return {
    ...effective,
    twinId,
    ...(twin ? { twin } : {}),
    ...(index ? { index } : {}),
    rebuildRequired: twinIndexRebuildRequired(effective.config, index),
  }
}

/** Thrown by ingest when writing would mix two embedding models in one index. */
export class TwinEmbeddingRebuildRequiredError extends Error {
  readonly code = "rebuild-required"
  constructor(message: string) {
    super(message)
    this.name = "TwinEmbeddingRebuildRequiredError"
  }
}

/** Thrown by ingest when the twin's effective embedding has no credentials. */
export class TwinEmbeddingUnconfiguredError extends Error {
  readonly code = TWIN_EMBEDDING_UNCONFIGURED
  constructor(provider: RagEmbeddingProvider) {
    super(
      `${TWIN_EMBEDDING_UNCONFIGURED}: the twin embeds with "${provider}" but no API key / base URL is configured for it`
    )
    this.name = "TwinEmbeddingUnconfiguredError"
  }
}

/**
 * Chunks of the twin that belong to sources OUTSIDE `sourceIds`. Index-only
 * counts (no chunk bodies are loaded).
 */
export async function countTwinChunksOutsideSources(
  twinId: string,
  sourceIds: Iterable<string>
): Promise<number> {
  const db = getDb()
  const total = await db.twinChunks.where("twinId").equals(twinId).count()
  if (total === 0) return 0
  let inside = 0
  for (const sourceId of new Set(sourceIds)) {
    inside += await db.twinChunks
      .where("sourceId")
      .equals(sourceId)
      .filter((chunk) => chunk.twinId === twinId)
      .count()
  }
  return Math.max(0, total - inside)
}

/**
 * Ingest pre-flight. Refuses (throws) when the effective config has no
 * credentials, or when the recorded index was built with another model AND
 * chunks from that model would survive this job (sources outside it). A job
 * that replaces every chunk of the twin may proceed: it rebuilds the index.
 */
export async function assertTwinIngestCompatible(
  plan: TwinEmbeddingPlan,
  jobSourceIds: string[]
): Promise<void> {
  if (!plan.credentialsReady) throw new TwinEmbeddingUnconfiguredError(plan.config.provider)
  if (!plan.rebuildRequired || !plan.index) return
  const outside = await countTwinChunksOutsideSources(plan.twinId, jobSourceIds)
  if (outside > 0) {
    throw new TwinEmbeddingRebuildRequiredError(describeTwinIndexMismatch(plan.config, plan.index))
  }
}

/**
 * After a successful ingest, record what built the index — but only when the
 * record would be TRUE for every chunk of the twin: either the existing record
 * already names this model, or no chunk from outside the written sources
 * remains. Returns the record written, or `undefined` when nothing was stamped.
 */
export async function recordTwinEmbeddingIndexAfterIngest(input: {
  twinId: string
  embedding: { provider: RagEmbeddingProvider; model: string }
  dimensions: number | undefined
  writtenSourceIds: string[]
  now?: number
}): Promise<TwinEmbeddingIndexRecord | undefined> {
  if (input.dimensions === undefined || input.writtenSourceIds.length === 0) return undefined
  const twin = await getTwin(input.twinId)
  if (!twin) return undefined
  const current = twin.embeddingIndex
  const sameAsRecord = current ? sameEmbeddingModel(input.embedding, current) : false
  if (!sameAsRecord) {
    const outside = await countTwinChunksOutsideSources(input.twinId, input.writtenSourceIds)
    if (outside > 0) return undefined
  }
  const record = buildTwinEmbeddingIndexRecord({
    provider: input.embedding.provider,
    model: input.embedding.model,
    dimensions: input.dimensions,
    builtAt: input.now ?? Date.now(),
  })
  await setTwinEmbeddingIndex(input.twinId, record)
  return record
}

// ─── Read API for the workbench card and the agent editor ───────────────────

export interface TwinEmbeddingStatus {
  twinId: string
  /** False when no twin row exists for `twinId` (the global config is reported). */
  exists: boolean
  /** Where the effective embedding comes from. */
  source: TwinEmbeddingSource
  effective: { provider: RagEmbeddingProvider; model: string; expectedDimensions?: number }
  global: { provider: RagEmbeddingProvider; model: string }
  override?: TwinEmbeddingOverride
  /** False when the effective provider is missing its key / base URL. */
  credentialsReady: boolean
  /** What built the current index, when recorded. */
  index?: TwinEmbeddingIndexRecord
  chunkCount: number
  /** Chunks exist but nothing recorded which model built them. */
  legacyIndex: boolean
  /** Recorded index model differs from the effective one: twin RAG is skipped. */
  rebuildRequired: boolean
}

/** Pure status assembly — the workbench card feeds it live-query inputs. */
export function computeTwinEmbeddingStatus(input: {
  twinId: string
  twin: Twin | undefined
  global: TwinRuntimeEmbeddingSettings
  providerSettings?: EmbeddingProviderSettingsMap
  chunkCount: number
}): TwinEmbeddingStatus {
  const { twin, global } = input
  const effective = resolveTwinEmbeddingConfig({
    override: twin?.embedding,
    global,
    providerSettings: input.providerSettings,
  })
  const index = twin?.embeddingIndex
  const expectedDimensions = expectedTwinEmbeddingDimensions(effective.config)
  return {
    twinId: input.twinId,
    exists: Boolean(twin),
    source: effective.source,
    effective: {
      provider: effective.config.provider,
      model: effective.config.model,
      ...(expectedDimensions !== undefined ? { expectedDimensions } : {}),
    },
    global: { provider: global.provider, model: global.model },
    ...(twin?.embedding ? { override: twin.embedding } : {}),
    credentialsReady: effective.credentialsReady,
    ...(index ? { index } : {}),
    chunkCount: input.chunkCount,
    legacyIndex: !index && input.chunkCount > 0,
    rebuildRequired: twinIndexRebuildRequired(effective.config, index),
  }
}

export interface TwinEmbeddingStatusDeps extends TwinEmbeddingIoDeps {
  getGlobalEmbedding: () => Promise<TwinRuntimeEmbeddingSettings>
  countChunks: (twinId: string) => Promise<number>
}

const defaultStatusDeps: TwinEmbeddingStatusDeps = {
  ...defaultIoDeps,
  // Lazy: the runtime-settings module pulls in the keyring + vector store, and
  // this file is also imported by the retrieval path, which never needs it.
  getGlobalEmbedding: async () => {
    const { getTwinRuntimeSettings } = await import("@/lib/db/twin-runtime-settings")
    return (await getTwinRuntimeSettings()).embedding
  },
  countChunks: (twinId) => getDb().twinChunks.where("twinId").equals(twinId).count(),
}

/**
 * The bound twin's effective embedding + index status for a given twinId.
 * Intended for surfaces outside the twin workbench (e.g. the agent editor).
 */
export async function getTwinEmbeddingStatus(
  twinId: string,
  deps: TwinEmbeddingStatusDeps = defaultStatusDeps
): Promise<TwinEmbeddingStatus> {
  const [twin, global, chunkCount] = await Promise.all([
    deps.getTwin(twinId),
    deps.getGlobalEmbedding(),
    deps.countChunks(twinId),
  ])
  const providerSettings = needsProviderSettings(twin?.embedding, global)
    ? await deps.loadProviderSettings()
    : undefined
  return computeTwinEmbeddingStatus({ twinId, twin, global, providerSettings, chunkCount })
}
