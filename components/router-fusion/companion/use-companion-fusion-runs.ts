"use client"

/**
 * The Router + Fusion runs a paired device started from one conversation
 * (ADR-0188 D25, the `companion` surface).
 *
 * `available` is the host's answer, not a guess: the host declares the
 * `router-fusion.companion` operations and reports them healthy only while its
 * companion switch is on (D36), and names the capabilities this device holds.
 * Nothing Router + Fusion loads on this device until a run is started — the
 * client is a dynamic import.
 */

import { useCallback, useMemo, useState } from "react"

import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { ROUTER_FUSION_COMPANION_CAPABILITY } from "@/lib/devices/grant-capabilities"
import type { HostRuntimeSnapshot } from "@/lib/runtime/operation-availability"
import type {
  CompanionRunMode,
  PendingCompanionRun,
} from "@/lib/router-fusion/api/companion-run-client"

/** The operations a run from this device needs: start it, then follow it. */
const REQUIRED_OPERATIONS = ["execution_run_create", "execution_run_get", "execution_run_events"]

export function companionFusionAvailable(host: HostRuntimeSnapshot | null | undefined): boolean {
  if (!host?.compatible) return false
  if (!REQUIRED_OPERATIONS.every((operation) => host.operations.includes(operation))) return false
  return host.grants.includes(ROUTER_FUSION_COMPANION_CAPABILITY)
}

export interface CompanionFusionRuns {
  /** The host would run one for this device right now. */
  available: boolean
  /** Runs started from this conversation on this screen, oldest first. */
  runs: readonly PendingCompanionRun[]
  /** Queue a run; resolves once the queue holds it. */
  start: (text: string, mode: CompanionRunMode, label: string) => Promise<PendingCompanionRun>
  dismiss: (rowId: string) => void
}

export function useCompanionFusionRuns(sessionId: string): CompanionFusionRuns {
  const runtime = useRuntimeSnapshot()
  const available = companionFusionAvailable(runtime.host)
  const [started, setStarted] = useState<Array<{ sessionId: string; run: PendingCompanionRun }>>([])

  const start = useCallback(
    async (text: string, mode: CompanionRunMode, label: string) => {
      const client = await import("@/lib/router-fusion/api/companion-run-client")
      const pending = await client.enqueueCompanionFusionRun({ sessionId, text, mode, label })
      setStarted((current) => [...current, { sessionId, run: pending }])
      return pending
    },
    [sessionId]
  )

  const dismiss = useCallback((rowId: string) => {
    setStarted((current) => current.filter((entry) => entry.run.rowId !== rowId))
  }, [])

  // Another conversation's runs are not this one's: switching conversations
  // shows only what was started here.
  const runs = useMemo(
    () => started.filter((entry) => entry.sessionId === sessionId).map((entry) => entry.run),
    [sessionId, started]
  )

  return { available, runs, start, dismiss }
}
