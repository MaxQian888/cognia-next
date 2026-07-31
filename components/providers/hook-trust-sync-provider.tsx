"use client"

/**
 * Seeds the Rust hooks trust gate from the Dexie workspace-trust ledger once on
 * client mount. Project/local-scope settings.json hooks load only for trusted
 * roots, and that gate lives in Rust — so it must be populated at startup (and
 * after each trust change, which the trust mutators handle). No-op on web.
 *
 * Also pushes the renderer's workspace roots into the Rust FS allowed-roots
 * registry (shadow-mode containment for the raw read/write/ensure_dir commands),
 * re-syncing whenever the set of projects changes.
 */

import { useEffect } from "react"
import { syncTrustedWorkspacesToRust } from "@/lib/claude/hook-trust-sync"
import { syncAllowedRootsToRust } from "@/lib/files/allowed-roots-sync"
import { useProjectStore } from "@/stores/project/project-store"

export function HookTrustSyncProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    void syncTrustedWorkspacesToRust()
    void syncAllowedRootsToRust()
    // Re-push workspace roots whenever the project list changes (the registry is
    // additive, so re-syncing only ever widens the shadow-check's view).
    const unsub = useProjectStore.subscribe((state, prev) => {
      if (state.projects !== prev.projects) void syncAllowedRootsToRust()
    })
    return unsub
  }, [])
  return <>{children}</>
}
