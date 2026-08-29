"use client"

/**
 * Mounts the two `useArtifactStore` ↔ Dexie bridges once on the client and
 * configures the Monaco loader path.
 *
 * Both halves of the store have a Dexie home: canvas documents
 * (`lib/canvas/dexie-bridge.ts`) and artifacts (`lib/artifacts/dexie-bridge.ts`).
 * Without the bridges the rows never reach the backup export pipeline, and — for
 * artifacts, which Dexie now owns outright — never survive a reload at all.
 * Without the loader configuration the Tauri production build can't reach
 * Monaco's CDN.
 *
 * Both bridges are keyed on `accountRevision` so unlocking, switching or
 * locking an account restarts them. A bridge started against one account's
 * database must not keep mirroring into another's, and only a restart re-runs
 * hydration against the database that is actually selected now.
 *
 * Monaco is configured once and never again: it is a global loader path, not
 * per-account state.
 */

import { useEffect } from "react"
import { startCanvasDexieBridge } from "@/lib/canvas/dexie-bridge"
import { startArtifactDexieBridge } from "@/lib/artifacts/dexie-bridge"
import { configureMonacoLoader } from "@/lib/canvas/monaco-loader"
import { useAccountStore } from "@/stores/account/account-store"

export function CanvasBridgeProvider({ children }: { children: React.ReactNode }) {
  const accountRevision = useAccountStore((state) => state.accountRevision)

  useEffect(() => {
    configureMonacoLoader()
  }, [])

  useEffect(() => {
    const disposeCanvas = startCanvasDexieBridge()
    const disposeArtifacts = startArtifactDexieBridge()
    return () => {
      disposeCanvas()
      disposeArtifacts()
    }
  }, [accountRevision])

  return <>{children}</>
}
