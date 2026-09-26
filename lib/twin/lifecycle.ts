import { getTwinRuntimeSettings } from "@/lib/db/twin-runtime-settings"
import { getTwinSource, deleteTwinSource } from "@/lib/db/twin-sources"
import { listTwinChunksBySource, listTwinChunksByTwin } from "@/lib/db/twin-chunks"
import { getTwin, deleteTwin, resetTwinEmbeddingIndex, type DeleteTwinResult } from "@/lib/db/twins"
import { cancelJob, listActiveJobsByTwin } from "@/lib/db/twin-jobs"
import { syncTwinCronToScheduler } from "@/lib/twin/cron/cron-bridge"
import { buildTwinRuntimeAdapters } from "@/lib/twin/runtime/build-deps"
import { vectorCollectionName } from "@/lib/twin/ingest/persist"
import type { IVectorStore } from "@cognia/vector/store"
import { invalidateTwinMemoryNamespace } from "@/lib/memory/twin-lifecycle"
import { enqueueIngestJob } from "@/lib/twin/ingest"
import { loadTwinEmbeddingPlan } from "@/lib/twin/runtime/twin-embedding-status"
import { TWIN_EMBEDDING_UNCONFIGURED } from "@/lib/twin/runtime/twin-embedding"
import type { TwinEmbeddingSource } from "@/lib/twin/runtime/twin-embedding"
import type { RagEmbeddingProvider } from "@cognia/provider-embedding/embedding-catalog"

export type TwinLifecycleStage =
  "scheduler" | "runtime-adapter" | "vector-store" | "memory" | "database"

export type TwinLifecycleResult<T> =
  | { ok: true; removed: boolean; value?: T }
  | { ok: false; removed: false; stage: TwinLifecycleStage; error: string }

interface TwinLifecycleDeps {
  getSettings: typeof getTwinRuntimeSettings
  buildAdapters: typeof buildTwinRuntimeAdapters
  getSource: typeof getTwinSource
  listSourceChunks: typeof listTwinChunksBySource
  deleteSourceRows: typeof deleteTwinSource
  getTwin: typeof getTwin
  listTwinChunks: typeof listTwinChunksByTwin
  listActiveJobs: typeof listActiveJobsByTwin
  cancelJob: typeof cancelJob
  syncCron: typeof syncTwinCronToScheduler
  invalidateMemories: typeof invalidateTwinMemoryNamespace
  deleteTwinRows: typeof deleteTwin
  resolveEmbeddingPlan: typeof loadTwinEmbeddingPlan
  resetIndexRows: typeof resetTwinEmbeddingIndex
  enqueueIngest: typeof enqueueIngestJob
}

const defaultDeps: TwinLifecycleDeps = {
  getSettings: getTwinRuntimeSettings,
  buildAdapters: buildTwinRuntimeAdapters,
  getSource: getTwinSource,
  listSourceChunks: listTwinChunksBySource,
  deleteSourceRows: deleteTwinSource,
  getTwin,
  listTwinChunks: listTwinChunksByTwin,
  listActiveJobs: listActiveJobsByTwin,
  cancelJob,
  syncCron: syncTwinCronToScheduler,
  invalidateMemories: invalidateTwinMemoryNamespace,
  deleteTwinRows: deleteTwin,
  resolveEmbeddingPlan: loadTwinEmbeddingPlan,
  resetIndexRows: resetTwinEmbeddingIndex,
  enqueueIngest: enqueueIngestJob,
}

async function resolveStore(deps: TwinLifecycleDeps): Promise<TwinLifecycleResult<IVectorStore>> {
  const runtime = await deps.buildAdapters(await deps.getSettings(), { requireEnabled: false })
  return runtime.ready
    ? { ok: true, removed: false, value: runtime.adapters.store }
    : { ok: false, removed: false, stage: "runtime-adapter", error: runtime.reason }
}

export async function removeTwinSource(
  sourceId: string,
  deps: TwinLifecycleDeps = defaultDeps
): Promise<TwinLifecycleResult<void>> {
  const source = await deps.getSource(sourceId)
  if (!source) return { ok: true, removed: false }
  const chunks = await deps.listSourceChunks(sourceId)
  if (chunks.length > 0) {
    const storeResult = await resolveStore(deps)
    if (!storeResult.ok) return storeResult
    const byCollection = new Map<string, string[]>()
    for (const chunk of chunks) {
      const ids = byCollection.get(chunk.vectorCollection) ?? []
      ids.push(chunk.vectorDocId)
      byCollection.set(chunk.vectorCollection, ids)
    }
    try {
      for (const [collection, ids] of byCollection) {
        await storeResult.value!.deleteDocuments(collection, ids)
      }
    } catch (error) {
      return {
        ok: false,
        removed: false,
        stage: "vector-store",
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  try {
    await deps.deleteSourceRows(sourceId)
    return { ok: true, removed: true }
  } catch (error) {
    return {
      ok: false,
      removed: false,
      stage: "database",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function removeTwin(
  twinId: string,
  deps: TwinLifecycleDeps = defaultDeps
): Promise<TwinLifecycleResult<DeleteTwinResult>> {
  if (!(await deps.getTwin(twinId))) return { ok: true, removed: false }
  try {
    const activeJobs = await deps.listActiveJobs(twinId)
    await Promise.all(activeJobs.map((job) => deps.cancelJob(job.id, "twin deleted")))
    await deps.syncCron(twinId, undefined)
  } catch (error) {
    return {
      ok: false,
      removed: false,
      stage: "scheduler",
      error: error instanceof Error ? error.message : String(error),
    }
  }
  const storeResult = await resolveStore(deps)
  if (!storeResult.ok) return storeResult
  const chunks = await deps.listTwinChunks(twinId)
  const collections = new Set(chunks.map((chunk) => chunk.vectorCollection))
  collections.add(vectorCollectionName(twinId))
  try {
    for (const collection of collections) {
      await storeResult.value!.deleteCollection(collection)
    }
  } catch (error) {
    return {
      ok: false,
      removed: false,
      stage: "vector-store",
      error: error instanceof Error ? error.message : String(error),
    }
  }
  try {
    await deps.invalidateMemories(twinId)
  } catch (error) {
    return {
      ok: false,
      removed: false,
      stage: "memory",
      error: error instanceof Error ? error.message : String(error),
    }
  }
  try {
    const value = await deps.deleteTwinRows(twinId, { skipExternalCleanup: true })
    return { ok: true, removed: true, value }
  } catch (error) {
    return {
      ok: false,
      removed: false,
      stage: "database",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export type TwinRebuildStage =
  "runtime-adapter" | "embedding" | "scheduler" | "vector-store" | "database"

export interface RebuildTwinIndexValue {
  /** The queued re-ingest job; absent when the twin has no live sources. */
  jobId?: string
  sourceIds: string[]
  droppedCollections: string[]
  cancelledJobIds: string[]
  chunksRemoved: number
  /** The embedding the rebuild will index with. */
  embedding: { provider: RagEmbeddingProvider; model: string; source: TwinEmbeddingSource }
}

export type RebuildTwinIndexResult =
  | { ok: true; rebuilt: boolean; value?: RebuildTwinIndexValue }
  | { ok: false; rebuilt: false; stage: TwinRebuildStage; error: string }

function rebuildFailure(stage: TwinRebuildStage, error: unknown): RebuildTwinIndexResult {
  return {
    ok: false,
    rebuilt: false,
    stage,
    error: error instanceof Error ? error.message : String(error),
  }
}

/**
 * Rebuild a twin's vector index with its CURRENT effective embedding (the
 * twin's override, else the global config). Mirrors the knowledge-base
 * rebuild, adapted to the twin's single fixed collection name:
 *
 *   1. Pre-flight — the runtime adapter must be ready (worker enabled, vector
 *      store configured) and the effective embedding must have credentials.
 *      Nothing is destroyed when either check fails.
 *   2. Stop queued / running / paused ingest jobs so none writes into the
 *      index being torn down. Distill jobs are left alone.
 *   3. Drop every vector collection the twin's chunks point at (plus the
 *      default `cognia_twin_{id}`), so a model with another dimension can
 *      recreate it.
 *   4. `resetTwinEmbeddingIndex` — delete chunk rows, reset live sources to
 *      `pending`, drop cached style-sample vectors, clear `embeddingIndex`.
 *   5. Queue one ingest job over those sources. The worker embeds them with
 *      the effective config and records the new `embeddingIndex`.
 *
 * Between step 3 and the end of step 5 the twin has no index; retrieval
 * degrades to "no twin RAG" exactly as it does for an empty twin.
 */
export async function rebuildTwinIndex(
  twinId: string,
  deps: TwinLifecycleDeps = defaultDeps
): Promise<RebuildTwinIndexResult> {
  if (!(await deps.getTwin(twinId))) return { ok: true, rebuilt: false }

  let settings: Awaited<ReturnType<typeof getTwinRuntimeSettings>>
  let store: IVectorStore
  try {
    settings = await deps.getSettings()
    const runtime = await deps.buildAdapters(settings)
    if (!runtime.ready) return rebuildFailure("runtime-adapter", runtime.reason)
    store = runtime.adapters.store
  } catch (error) {
    return rebuildFailure("runtime-adapter", error)
  }

  let embedding: RebuildTwinIndexValue["embedding"]
  try {
    const plan = await deps.resolveEmbeddingPlan(twinId, settings.embedding)
    if (!plan.credentialsReady) {
      return rebuildFailure("embedding", `${TWIN_EMBEDDING_UNCONFIGURED}: ${plan.config.provider}`)
    }
    embedding = { provider: plan.config.provider, model: plan.config.model, source: plan.source }
  } catch (error) {
    return rebuildFailure("embedding", error)
  }

  const cancelledJobIds: string[] = []
  try {
    const active = await deps.listActiveJobs(twinId)
    for (const job of active) {
      if (job.kind !== "ingest") continue
      await deps.cancelJob(job.id, "twin index rebuild")
      cancelledJobIds.push(job.id)
    }
  } catch (error) {
    return rebuildFailure("scheduler", error)
  }

  const collections = new Set<string>([vectorCollectionName(twinId)])
  try {
    for (const chunk of await deps.listTwinChunks(twinId)) collections.add(chunk.vectorCollection)
    for (const collection of collections) await store.deleteCollection(collection)
  } catch (error) {
    return rebuildFailure("vector-store", error)
  }

  let reset: Awaited<ReturnType<typeof resetTwinEmbeddingIndex>>
  try {
    reset = await deps.resetIndexRows(twinId)
  } catch (error) {
    return rebuildFailure("database", error)
  }

  let jobId: string | undefined
  if (reset.sourceIds.length > 0) {
    try {
      jobId = (await deps.enqueueIngest({ twinId, sourceIds: reset.sourceIds })).id
    } catch (error) {
      return rebuildFailure("database", error)
    }
  }

  return {
    ok: true,
    rebuilt: true,
    value: {
      ...(jobId ? { jobId } : {}),
      sourceIds: reset.sourceIds,
      droppedCollections: [...collections],
      cancelledJobIds,
      chunksRemoved: reset.chunks,
      embedding,
    },
  }
}
