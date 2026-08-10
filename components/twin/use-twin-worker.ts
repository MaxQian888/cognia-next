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
import { startJobWorker } from "@/lib/twin/job-worker"
import { buildTwinWorkerConfig, isTwinWorkerConfigComplete } from "@/lib/twin/worker-runtime"
import { DEFAULT_TWIN_RUNTIME_SETTINGS } from "@/types/twin"

export { buildTwinWorkerConfig, isTwinWorkerConfigComplete } from "@/lib/twin/worker-runtime"

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
    if (!settings.workerEnabled) return
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

  return settings.workerEnabled ? status : { active: false, reasonKey: "disabled" }
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
