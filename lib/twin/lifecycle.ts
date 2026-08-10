import { getTwinRuntimeSettings } from "@/lib/db/twin-runtime-settings"
import { getTwinSource, deleteTwinSource } from "@/lib/db/twin-sources"
import { listTwinChunksBySource, listTwinChunksByTwin } from "@/lib/db/twin-chunks"
import { getTwin, deleteTwin, type DeleteTwinResult } from "@/lib/db/twins"
import { cancelJob, listActiveJobsByTwin } from "@/lib/db/twin-jobs"
import { syncTwinCronToScheduler } from "@/lib/twin/cron/cron-bridge"
import { buildTwinRuntimeAdapters } from "@/lib/twin/runtime/build-deps"
import { vectorCollectionName } from "@/lib/twin/ingest/persist"
import type { IVectorStore } from "@cognia/vector/store"
import { invalidateTwinMemoryNamespace } from "@/lib/memory/twin-lifecycle"

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
