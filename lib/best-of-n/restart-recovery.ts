import type { BestOfNGroup } from "@/types/best-of-n"

/** Settled groups need only a fresh projection; an interrupted archive is reported by the Host. */
function settled(group: BestOfNGroup) {
  return ["published", "cancelled"].includes(group.phase) && group.archiveStatus !== "archiving"
}

/** The longest a restart waits for the previous process's owner lease to lapse. */
export const MAX_LEASE_WAIT_MS = 5 * 60_000

export interface BestOfNRestartRecoveryDeps {
  canManage(): boolean
  list(): Promise<BestOfNGroup[]>
  /** Claims the lapsed lease and parks interrupted attempts (`service.recover`). */
  recover(groupId: string): Promise<BestOfNGroup>
  /** Gives back an integration a publishing winner is still held by. */
  release(groupId: string): Promise<boolean>
  project(group: BestOfNGroup): Promise<unknown>
  sleep(ms: number): Promise<void>
  now(): number
}

export interface BestOfNRestartReport {
  recovered: string[]
  released: string[]
  failed: Array<{ groupId: string; error: string }>
}

/**
 * Rebind every unfinished run to this Host process from the ledger. Running
 * attempts are never replayed: the Host parks them as `recoveryRequired`
 * (their workspaces are kept for inspection, and a missing one is reported).
 * A winner left inside an integration is released so publishing can resume
 * through fresh exact-head checks. One group's failure never stops the rest.
 */
export async function recoverBestOfNAfterRestart(
  deps: BestOfNRestartRecoveryDeps
): Promise<BestOfNRestartReport> {
  const report: BestOfNRestartReport = { recovered: [], released: [], failed: [] }
  if (!deps.canManage()) return report
  const groups = await deps.list()
  const open = groups.filter((group) => !settled(group))
  for (const group of groups.filter(settled)) await deps.project(group).catch(() => undefined)
  // The previous process may still hold a live lease for a few seconds; a
  // claim before it lapses is refused, so wait once for the latest one.
  const wait = Math.max(0, ...open.map((group) => group.ownerLeaseExpiresAt - deps.now()))
  if (open.length && wait > 0) await deps.sleep(Math.min(wait + 50, MAX_LEASE_WAIT_MS))
  for (const group of open) {
    try {
      const current = await deps.recover(group.groupId)
      if (current.phase === "publishing" && (await deps.release(group.groupId)))
        report.released.push(group.groupId)
      await deps.project(current)
      report.recovered.push(group.groupId)
    } catch (error) {
      report.failed.push({
        groupId: group.groupId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return report
}

/** Production wiring, run once per desktop Host process. */
export async function recoverBestOfNRunsOnStartup(): Promise<BestOfNRestartReport> {
  const [projection, { createBestOfNHost }, { recoverBestOfN }, { releaseBestOfNIntegration }] =
    await Promise.all([
      import("./projection"),
      import("./host"),
      import("./service"),
      import("./publication"),
    ])
  return recoverBestOfNAfterRestart({
    canManage: projection.canManageBestOfNRuns,
    list: () => createBestOfNHost().list(),
    recover: recoverBestOfN,
    release: releaseBestOfNIntegration,
    project: (group) => projection.refreshBestOfNRun(group.groupId),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  })
}
