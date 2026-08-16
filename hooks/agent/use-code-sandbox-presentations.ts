"use client"

/**
 * Tool presentations this host can actually offer (ADR-0117, Phase 4).
 *
 * Starts at the fail-closed answer — native only — and widens to include the
 * sandboxed presentations once the active confinement probe comes back
 * positive. The initial value matters: rendering `code` as available and then
 * retracting it would let a user select it in the gap, and a composition
 * selected in that gap would resolve to something the host cannot run.
 */

import { useEffect, useState } from "react"

import { hostToolPresentations } from "@/lib/ai/code-mode/host-probe"
import { codeSandboxStatus } from "@/lib/ai/code-mode/sandbox-status"
import type { ToolPresentationMode } from "@cognia/agent-config-types/agent-composition"

export function useCodeSandboxPresentations(): ToolPresentationMode[] {
  const [presentations, setPresentations] = useState<ToolPresentationMode[]>(() =>
    hostToolPresentations()
  )

  useEffect(() => {
    let alive = true
    void codeSandboxStatus().then((status) => {
      if (!alive) return
      setPresentations(hostToolPresentations({ strictSandboxReported: status.confined }))
    })
    return () => {
      alive = false
    }
  }, [])

  return presentations
}
