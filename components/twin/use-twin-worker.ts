"use client"

/**
 * Twin worker hooks — wire the `twin-runtime` Dexie settings to the job worker.
 *
 * Two consumers, one config:
 *
 *  • {@link useBackgroundTwinWorker} runs ONE app-level, all-twins polling
 *    worker (mounted by `TwinWorkerInitializer` in `app/layout.tsx`). This is
 *    what lets cron-enqueued ingest/distill jobs actually drain even when the
 *    `/twin` workbench isn't open — `twinJobs` is an IndexedDB (renderer) table
 *    the scheduler executor can only enqueue into, never execute.
 *  • {@link useTwinWorkerStatus} is a pure, side-effect-free status derivation
 *    for the workbench header. It must NOT start a second worker (that would
 *    double the polling + per-kind concurrency budget against the same queue).
 *
 * Settings unset / `workerEnabled = false` → no worker. Once ANY field is
 * missing (e.g. embedding.apiKey empty) the worker declines to start;
 * surfacing the missing field in the UI is the Settings tab's job.
 */

import { useEffect, useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { loggers } from "@/lib/logging"
import { createVectorStore, type IVectorStore, type VectorStoreConfig } from "@cognia/vector/store"
import { embeddingProviderRequiresApiKey } from "@cognia/provider-embedding/embedding-catalog"
import { observeTwinRuntimeSettings } from "@/lib/db/twin-runtime-settings"
import { getTwinSource } from "@/lib/db/twin-sources"
import { startJobWorker, type JobWorkerConfig, type SourceLoader } from "@/lib/twin/job-worker"
import { createAnthropicLlmClient } from "@/lib/twin/distill"
import type { TwinRuntimeSettings, TwinSource } from "@/types/twin"
import { DEFAULT_TWIN_RUNTIME_SETTINGS } from "@/types/twin"

const log = loggers.scheduler

export type TwinWorkerReason = "noTwinSelected" | "disabled" | "incompleteConfig"

export interface UseTwinWorkerStatus {
  active: boolean
  /**
   * i18n key (under `twin.workerStatus`) describing why the worker isn't
   * running. Components translate it at the call site so the hook stays
   * free of `useTranslations`.
   */
  reasonKey?: TwinWorkerReason
}

function deriveVectorStoreConfig(settings: TwinRuntimeSettings): VectorStoreConfig | null {
  const storage = settings.storage
  const embedding = {
    provider: settings.embedding.provider,
    model: settings.embedding.model,
    dimensions: undefined,
    baseURL: settings.embedding.baseURL,
  }
  const apiKey = settings.embedding.apiKey
  // Local providers (ollama / lmstudio / … / transformers.js) need no API key;
  // only gate on a key when the provider actually requires one.
  if (embeddingProviderRequiresApiKey(settings.embedding.provider) && !apiKey) return null

  switch (storage.vectorBackend) {
    case "qdrant":
      if (!storage.qdrant?.url) return null
      return {
        provider: "qdrant",
        embeddingConfig: embedding,
        embeddingApiKey: apiKey,
        qdrantUrl: storage.qdrant.url,
        qdrantApiKey: storage.qdrant.apiKey,
      }
    case "pinecone":
      if (!storage.pinecone?.apiKey || !storage.pinecone.indexName) return null
      return {
        provider: "pinecone",
        embeddingConfig: embedding,
        embeddingApiKey: apiKey,
        pineconeApiKey: storage.pinecone.apiKey,
        pineconeIndexName: storage.pinecone.indexName,
        pineconeNamespace: storage.pinecone.namespace,
      }
    case "weaviate":
      if (!storage.weaviate?.url) return null
      return {
        provider: "weaviate",
        embeddingConfig: embedding,
        embeddingApiKey: apiKey,
        weaviateUrl: storage.weaviate.url,
        weaviateApiKey: storage.weaviate.apiKey,
      }
    case "milvus":
      if (!storage.milvus?.address) return null
      return {
        provider: "milvus",
        embeddingConfig: embedding,
        embeddingApiKey: apiKey,
        milvusAddress: storage.milvus.address,
        milvusToken: storage.milvus.token,
        milvusSsl: storage.milvus.ssl,
      }
    case "chroma":
      if (storage.chroma?.mode === "server" && !storage.chroma.serverUrl) return null
      return {
        provider: "chroma",
        embeddingConfig: embedding,
        embeddingApiKey: apiKey,
        chromaMode: storage.chroma?.mode,
        chromaServerUrl: storage.chroma?.serverUrl,
      }
    default:
      return null
  }
}

function buildSourceLoader(): SourceLoader {
  // The workbench's paste-text path stores the body in `twinSources.title` /
  // a future File-pickup path will populate `binary`. For Phase 7 we only
  // know how to load the markdown row from Dexie; binary sources surface a
  // clear error so the worker fails the job rather than silently skipping.
  return async (source: TwinSource) => {
    const refreshed = await getTwinSource(source.id)
    if (!refreshed) throw new Error(`twin source ${source.id} disappeared mid-load`)
    return {
      id: refreshed.id,
      filename: refreshed.title,
      format: refreshed.format,
      // The paste-text uploader stores the body inside `source` for now;
      // imported files round-trip through future importer modules.
      text: refreshed.source,
    }
  }
}

/**
 * Cheap completeness check used by the status hook — mirrors the gate order in
 * {@link buildTwinWorkerConfig} WITHOUT constructing a live vector-store client
 * (the status surface doesn't need one).
 */
export function isTwinWorkerConfigComplete(settings: TwinRuntimeSettings): boolean {
  if (!settings.workerEnabled) return false
  if (!deriveVectorStoreConfig(settings)) return false
  if (!settings.llm.apiKey) return false
  return true
}

/**
 * Build a twin-independent `JobWorkerConfig` from the runtime settings, or
 * `null` when the user's config is incomplete. The config carries no twin
 * scope — `startJobWorker(config)` (no `twinId`) drains EVERY twin's queue, so
 * one app-level worker covers all twins. Returns `null` (rather than throwing)
 * if the vector-store client can't be constructed, matching the rest of the
 * twin runtime's best-effort semantics.
 */
export function buildTwinWorkerConfig(settings: TwinRuntimeSettings): JobWorkerConfig | null {
  if (!settings.workerEnabled) return null
  const storeConfig = deriveVectorStoreConfig(settings)
  if (!storeConfig) return null
  if (!settings.llm.apiKey) return null

  let store: IVectorStore
  try {
    store = createVectorStore(storeConfig)
  } catch (err) {
    log.warn("twin worker: createVectorStore failed; worker will not start", {
      err: String(err),
    })
    return null
  }
  return {
    embedding: settings.embedding,
    vectorBackend: settings.storage.vectorBackend,
    store,
    sourceLoader: buildSourceLoader(),
    llm: createAnthropicLlmClient({
      provider: settings.llm.provider,
      model: settings.llm.model,
      apiKey: settings.llm.apiKey,
      baseURL: settings.llm.baseURL,
    }),
  }
}

/**
 * App-level, all-twins job worker. Mounted ONCE via `TwinWorkerInitializer`
 * so queued ingest/distill jobs (including cron-enqueued ones) drain whenever
 * the app is open and the user has enabled + configured the twin worker — no
 * need to sit on the `/twin` page. Idempotent across renders; a settings change
 * tears the old worker down and starts a fresh one.
 */
export function useBackgroundTwinWorker(): UseTwinWorkerStatus {
  const settings = useLiveQuery(
    () => observeTwinRuntimeSettings(),
    [],
    DEFAULT_TWIN_RUNTIME_SETTINGS
  )

  // Memoise so an unrelated render doesn't tear the worker down. Settings
  // changes (deep-equal-different) DO restart it via the effect dependency.
  const config = useMemo<JobWorkerConfig | null>(() => buildTwinWorkerConfig(settings), [settings])

  useEffect(() => {
    if (!config) return
    // No twinId → claim across every twin's queue.
    const handle = startJobWorker(config)
    return () => {
      void handle.stop()
    }
  }, [config])

  return useMemo<UseTwinWorkerStatus>(() => {
    if (!settings.workerEnabled) return { active: false, reasonKey: "disabled" }
    if (!config) return { active: false, reasonKey: "incompleteConfig" }
    return { active: true }
  }, [settings.workerEnabled, config])
}

/**
 * Pure status derivation for the workbench header — reports whether the
 * background worker would be running for this twin. Starts NO worker (the
 * app-level {@link useBackgroundTwinWorker} owns the single loop).
 */
export function useTwinWorkerStatus(twinId: string | null): UseTwinWorkerStatus {
  const settings = useLiveQuery(
    () => observeTwinRuntimeSettings(),
    [],
    DEFAULT_TWIN_RUNTIME_SETTINGS
  )
  return useMemo<UseTwinWorkerStatus>(() => {
    if (!twinId) return { active: false, reasonKey: "noTwinSelected" }
    if (!settings.workerEnabled) return { active: false, reasonKey: "disabled" }
    if (!isTwinWorkerConfigComplete(settings))
      return { active: false, reasonKey: "incompleteConfig" }
    return { active: true }
  }, [twinId, settings])
}
