"use client"

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"

import {
  onSandboxPlacementReport,
  sandboxPlacementReport,
  subscribeSandboxPlacements,
  type SandboxPlacementReport,
} from "@/lib/sandbox/placement-report"
import { onRunEnvironmentOutcome, runEnvironmentOutcome } from "@/lib/sandbox/run-environment"
import type { SandboxPlacementOutcome } from "@/lib/sandbox/environment-placement"
import { onTauriEvent } from "@/lib/tauri/events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

/**
 * What one agent's run asked for and what it actually got (ADR-0182).
 *
 * Two halves, deliberately not merged:
 *
 * - `requested` is the brain's own verdict — `off`, `placed`, `fallback` or
 *   `refused` — and it exists for every run, including one the Host never saw.
 * - `report` is the Host's answer, and it exists only once a placed spawn has
 *   started. It is the only honest source for the tier, the user and the
 *   digests, because all three can differ from the request: a driver attests
 *   the tier it has, `remoteUser` is remapped, and an image that declares no
 *   user gets the tier default.
 *
 * A surface that rendered `requested` as if it were the outcome would claim a
 * gVisor sandbox for a run the daemon gave a plain container.
 */
export interface SandboxPlacementState {
  requested: SandboxPlacementOutcome | undefined
  report: SandboxPlacementReport | undefined
}

/**
 * Subscribe to the Host's placement channel for the lifetime of the mount.
 *
 * Idempotent across mounts by construction: `subscribeSandboxPlacements`
 * records into the module-scoped report map, so several panels mounting at
 * once each open a listener and every one of them sees the same reports. The
 * alternative — one process-wide subscription started at boot — would report
 * placements nobody is looking at and is what `components/providers` is for
 * once a second surface needs it.
 */
function useSandboxPlacementChannel(): void {
  useEffect(() => {
    let stop: (() => void) | undefined
    let cancelled = false
    void subscribeSandboxPlacements(async (channel, handler) => {
      const unlisten = await onTauriEvent<unknown>(channel, handler)
      return () => safeUnlisten(unlisten)
    })
      .then((unsubscribe) => {
        if (cancelled) unsubscribe()
        else stop = unsubscribe
      })
      .catch(() => {
        // No placement channel on this host — a browser with no companion, or
        // a Host older than ADR-0182. The requested half still renders.
      })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [])
}

/**
 * One agent's placement, request and answer, kept current.
 *
 * `agentId` may be `undefined` while a surface has no run selected; the hook
 * still subscribes, so the first report for the agent it is later given is not
 * missed.
 */
export function useSandboxPlacement(agentId: string | undefined): SandboxPlacementState {
  useSandboxPlacementChannel()

  // Both halves live in module-scoped stores that hand back the recorded
  // object itself, so each read is a stable snapshot and a render only
  // follows a record for this agent. Reading them at render time also covers
  // an id change: whatever already arrived for the new agent is shown at once.
  const subscribeRequested = useCallback(
    (notify: () => void) =>
      onRunEnvironmentOutcome((id) => {
        if (id === agentId) notify()
      }),
    [agentId]
  )
  const requested = useSyncExternalStore(
    subscribeRequested,
    () => (agentId ? runEnvironmentOutcome(agentId) : undefined),
    () => undefined
  )

  const subscribeReport = useCallback(
    (notify: () => void) =>
      onSandboxPlacementReport((report) => {
        if (report.agentId === agentId) notify()
      }),
    [agentId]
  )
  const report = useSyncExternalStore(
    subscribeReport,
    () => (agentId ? sandboxPlacementReport(agentId) : undefined),
    () => undefined
  )

  return useMemo(() => ({ requested, report }), [requested, report])
}
