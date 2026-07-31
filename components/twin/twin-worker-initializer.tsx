"use client"

import { useBackgroundTwinWorker } from "./use-twin-worker"

/**
 * TwinWorkerInitializer — the single app-level mount point for the all-twins
 * twin job worker. Placed in the root layout so queued ingest/distill jobs
 * (including cron-enqueued ones) drain whenever the app is open and the user
 * has enabled + configured the twin worker, without needing the `/twin`
 * workbench to be the active page.
 *
 * Gating lives entirely in {@link useBackgroundTwinWorker}: with the default
 * settings (worker disabled / no API keys) this mounts nothing live.
 */
export function TwinWorkerInitializer() {
  useBackgroundTwinWorker()
  return null
}
