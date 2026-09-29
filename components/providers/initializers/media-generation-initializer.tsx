"use client"

import { useEffect } from "react"
import { loggers } from "@cognia/logging"
import { getVideoJobEngine, getVideoJobHost } from "@/lib/ai/media/video-jobs/host"
import { startVideoJobReconciler } from "@/lib/ai/media/video-jobs/reconciler"
import { ensureRendererVideoJobHost } from "@/lib/ai/media/video-jobs/renderer-host"

/**
 * Keeps video-generation jobs moving across reloads (ADR-0205): installs the
 * renderer's job host (Dexie rows, platform transport) and runs the
 * background checker, which polls from one window at a time.
 */
export function MediaGenerationInitializer() {
  useEffect(() => {
    ensureRendererVideoJobHost()
    const reconciler = startVideoJobReconciler({
      engine: getVideoJobEngine,
      store: () => getVideoJobHost().store,
      onError: (error) =>
        loggers.media.warn("video job check failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
    })
    return () => reconciler.dispose()
  }, [])
  return null
}

export default MediaGenerationInitializer
