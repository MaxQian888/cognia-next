/**
 * Who drives an orchestrated run in this process (ADR-0188 D9, B3).
 *
 * An orchestrated run (`FusionRunRow.driver === "orchestrator"`) is executed by
 * `executeFusionRun` from its stored input. It is started after the request
 * that created it has been answered (`POST /v1/runs` is a 202; a chat fusion
 * turn returns to the composer), and it is started again by the boot sweep
 * when the worker that had it went away. Either way the run's lease is what
 * keeps two processes from executing it at once; this module only keeps one
 * process from starting it twice.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import type { RouterFusionSurface } from "@cognia/router-fusion/settings/switches"

import { liveSettingsReader } from "../calls/live-settings"
import { windowLeaseOwner } from "../chat/chat-run-deps"
import { currentFusionStore } from "../chat/store-provider"
import { accountDatabaseAppliers } from "../db/outbox-appliers"
import type { FusionRunRow } from "../db/types"
import { executeFusionRun } from "./orchestrator-host"

/** Runs this process is driving; a second start of the same run joins nothing. */
const driving = new Set<string>()

/** Start driving a run in this process unless it already is. */
export function driveRun(runId: string, appSettings: () => AppSettings | undefined): void {
  if (driving.has(runId)) return
  driving.add(runId)
  void executeFusionRun(
    {
      store: () => currentFusionStore(),
      appliers: accountDatabaseAppliers,
      leaseOwner: windowLeaseOwner(),
      appSettings,
    },
    { runId }
  )
    .catch((error: unknown) => {
      console.error(`[router-fusion] run ${runId} could not be executed`, error)
    })
    .finally(() => driving.delete(runId))
}

export function isDrivingRun(runId: string): boolean {
  return driving.has(runId)
}

/**
 * The boot sweep's hook for an orchestrated run whose worker went away. A run
 * whose surface is switched on is driven again here, from the ledger: steps
 * that finished replay, and the new lease holder settles whatever was in
 * flight before anything is sent (REC-03). A run on a surface that is off is
 * refused, so the sweep seals it instead of resuming work the user stopped.
 *
 * `snapshot` is the settings the sweep read; the desktop window's live store
 * wins once it is loaded (see `liveSettingsReader`).
 */
export function orchestratedRunResumer(
  snapshot: AppSettings | null | undefined,
  liveSurfaces: readonly RouterFusionSurface[]
): (run: FusionRunRow) => boolean {
  const appSettings = liveSettingsReader(snapshot)
  return (run) => {
    if (run.driver !== "orchestrator" || !liveSurfaces.includes(run.surface)) return false
    driveRun(run.runId, appSettings)
    return true
  }
}
