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
import { useAccountStore } from "@/stores/account/account-store"

export function HookTrustSyncProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    void syncTrustedWorkspacesToRust()
    void syncAllowedRootsToRust()
    // The remote Git registry is a replaceable current-account snapshot, so
    // project and account changes both revoke the previous authorization set.
    const unsubProjects = useProjectStore.subscribe((state, prev) => {
      if (state.projects !== prev.projects) void syncAllowedRootsToRust()
    })
    const unsubAccount = useAccountStore.subscribe((state, prev) => {
      if (
        state.unlockedAccountId !== prev.unlockedAccountId ||
        state.accountRevision !== prev.accountRevision
      ) {
        void syncAllowedRootsToRust()
      }
    })
    return () => {
      unsubProjects()
      unsubAccount()
    }
  }, [])
  return <>{children}</>
}
