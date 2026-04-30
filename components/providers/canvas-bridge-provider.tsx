"use client"

/**
 * Mounts the artifact-store ↔ Dexie bridge once on the client and
 * configures the Monaco loader path. Without the bridge, canvas
 * documents persist only in localStorage and never reach the backup
 * export pipeline; without the loader configuration the Tauri
 * production build can't reach Monaco's CDN.
 */

import { useEffect } from "react"
import { startCanvasDexieBridge } from "@/lib/canvas/dexie-bridge"
import { configureMonacoLoader } from "@/lib/canvas/monaco-loader"

export function CanvasBridgeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    configureMonacoLoader()
    const dispose = startCanvasDexieBridge()
    return () => dispose()
  }, [])
  return <>{children}</>
}
