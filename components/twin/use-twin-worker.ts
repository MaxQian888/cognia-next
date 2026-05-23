"use client"

/**
 * `useTwinWorker` — wires the twin runtime settings to the job worker.
 *
 * Reads `twin-runtime` settings from Dexie, builds a live vector store
 * client when the user has a usable config, and starts a polling worker
 * for the active twin. The hook tears the worker down on unmount and
 * re-establishes it whenever the settings (or the active twin) change.
 *
 * Settings unset / `workerEnabled = false` → no worker; the hook returns
 * `{ active: false }`. Once ANY field is missing (e.g. embedding.apiKey
 * empty) the hook declines to start: surfacing the missing field in the
 * UI is the Settings tab's job.
 */

import { useEffect, useMemo, useRef } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { loggers } from "@/lib/logging"
import { createVectorStore, type IVectorStore, type VectorStoreConfig } from "@/lib/vector/store"
import { observeTwinRuntimeSettings } from "@/lib/db/twin-runtime-settings"
import { getTwinSource } from "@/lib/db/twin-sources"
import {
  startJobWorker,
  type JobWorkerHandle,
  type JobWorkerConfig,
  type SourceLoader,
} from "@/lib/twin/job-worker"
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
  }
  const apiKey = settings.embedding.apiKey
  if (!apiKey) return null

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
 * Activate a job worker scoped to `twinId`. Idempotent across renders —
 * the same settings produce the same worker; settings changes restart it.
 */
export function useTwinWorker(twinId: string | null): UseTwinWorkerStatus {
  const settings = useLiveQuery(
    () => observeTwinRuntimeSettings(),
    [],
    DEFAULT_TWIN_RUNTIME_SETTINGS
  )
  const handleRef = useRef<JobWorkerHandle | null>(null)

  // Memoise the worker config so an unrelated render doesn't tear the
  // worker down. Settings changes (deep-equal-different) DO trigger a
  // restart by virtue of the surrounding useEffect dependency.
  const config = useMemo<JobWorkerConfig | null>(() => {
    if (!settings.workerEnabled) return null
    if (!twinId) return null
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
  }, [settings, twinId])

  useEffect(() => {
    if (!config || !twinId) return
    const handle = startJobWorker(config, twinId)
    handleRef.current = handle
    return () => {
      void handle.stop()
      handleRef.current = null
    }
  }, [config, twinId])

  // Status is a pure derivation — no state involved, so the rules-of-hooks
  // and set-state-in-effect linters stay quiet. The reason strings stay in
  // sync with the gating order in the `config` memo above.
  return useMemo<UseTwinWorkerStatus>(() => {
    if (!twinId) return { active: false, reasonKey: "noTwinSelected" }
    if (!settings.workerEnabled) {
      return { active: false, reasonKey: "disabled" }
    }
    if (!config) {
      return { active: false, reasonKey: "incompleteConfig" }
    }
    return { active: true }
  }, [twinId, settings.workerEnabled, config])
}
