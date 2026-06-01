"use client"

/**
 * Seeds the Rust hooks trust gate from the Dexie workspace-trust ledger once on
 * client mount. Project/local-scope settings.json hooks load only for trusted
 * roots, and that gate lives in Rust — so it must be populated at startup (and
 * after each trust change, which the trust mutators handle). No-op on web.
 */

import { useEffect } from "react"
import { syncTrustedWorkspacesToRust } from "@/lib/claude/hook-trust-sync"

export function HookTrustSyncProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    void syncTrustedWorkspacesToRust()
  }, [])
  return <>{children}</>
}
