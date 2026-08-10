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

import { useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { observeTwinRuntimeSettings } from "@/lib/db/twin-runtime-settings"
import { getTwinSource } from "@/lib/db/twin-sources"
import { startJobWorker, type JobWorkerConfig, type SourceLoader } from "@/lib/twin/job-worker"
import { createAnthropicLlmClient } from "@/lib/twin/distill"
import {
  buildTwinRuntimeAdapters,
  deriveTwinVectorStoreConfig,
} from "@/lib/twin/runtime/build-deps"
import type { TwinRuntimeSettings, TwinSource } from "@/types/twin"
import { DEFAULT_TWIN_RUNTIME_SETTINGS } from "@/types/twin"

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

function buildSourceLoader(): SourceLoader {
  // Every source is normalized to text at upload time: the paste path stores
  // the body in `twinSources.source`, and the file/importer paths (PDF/DOCX,
  // mbox/eml, chat exports, git-repo) are parsed client-side in
  // `twin-source-uploader.tsx` and also land their extracted text in `source`
  // (as `format: "markdown"`). So the worker only ever loads text — there is
  // no binary round-trip to do here. Import-time `speakers` ride along as
  // `baseMetadata.speakers` so `deriveNameHints` can seed the redaction pass.
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

/**
 * Cheap completeness check used by the status hook — mirrors the gate order in
 * {@link buildTwinWorkerConfig} WITHOUT constructing a live vector-store client
 * (the status surface doesn't need one).
 */
export function isTwinWorkerConfigComplete(settings: TwinRuntimeSettings): boolean {
  if (!settings.workerEnabled) return false
  if (!deriveTwinVectorStoreConfig(settings)) return false
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
export async function buildTwinWorkerConfig(
  settings: TwinRuntimeSettings
): Promise<JobWorkerConfig | null> {
  if (!settings.workerEnabled) return null
  if (!settings.llm.apiKey) return null
  const runtime = await buildTwinRuntimeAdapters(settings)
  if (!runtime.ready) return null
  return {
    embedding: settings.embedding,
    vectorBackend: settings.storage.vectorBackend,
    store: runtime.adapters.store,
    sourceLoader: buildSourceLoader(),
    nameHints: settings.extraNameHints,
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

  const [status, setStatus] = useState<UseTwinWorkerStatus>(() =>
    settings.workerEnabled
      ? { active: false, reasonKey: "incompleteConfig" }
      : { active: false, reasonKey: "disabled" }
  )

  useEffect(() => {
    let disposed = false
    let handle: ReturnType<typeof startJobWorker> | undefined
    if (!settings.workerEnabled) {
      setStatus({ active: false, reasonKey: "disabled" })
      return
    }
    void buildTwinWorkerConfig(settings).then((config) => {
      if (disposed) return
      if (!config) {
        setStatus({ active: false, reasonKey: "incompleteConfig" })
        return
      }
      // No twinId → claim across every twin's queue.
      handle = startJobWorker(config)
      setStatus({ active: true })
    })
    return () => {
      disposed = true
      if (handle) void handle.stop()
    }
  }, [settings])

  return status
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
