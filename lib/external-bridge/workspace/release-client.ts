/**
 * What a revoked External Bridge client leaves behind (ADR-0203).
 *
 * Revoking a credential closes its sessions, but two things outlive it on the
 * Cognia side: the shell jobs it started (owned by the synthetic session
 * `external-bridge:jobs:<client>`, which no chat ever closes, so the job
 * supervisor's session-close reaping never fires for them) and its root grant.
 * A revoked client must not keep a build running on the user's machine, and a
 * re-issued credential that happened to reuse the id must not inherit roots.
 */

import { bridgeCallerForClientId } from "../bridge-caller"

export interface ReleaseClientDeps {
  listJobs(caller: string): Promise<Array<{ id: string; status: string }>>
  killJob(jobId: string): Promise<unknown>
  dropGrant(caller: string): Promise<void>
}

async function defaultDeps(): Promise<ReleaseClientDeps> {
  const [jobs, settings] = await Promise.all([
    import("@/lib/jobs/background-jobs"),
    import("@/lib/db/settings"),
  ])
  return {
    listJobs: (caller) => jobs.listBackgroundJobs(jobs.bridgeJobOwner(caller)),
    killJob: jobs.killBackgroundJob,
    dropGrant: async (caller) => {
      const bridge = (await settings.getSettings()).externalBridge
      if (!bridge?.workspaceGrants?.[caller]) return
      const grants = { ...bridge.workspaceGrants }
      delete grants[caller]
      await settings.saveSettings({ externalBridge: { ...bridge, workspaceGrants: grants } })
    },
  }
}

export interface ReleaseClientResult {
  stoppedJobs: number
  /** Jobs whose kill failed; they keep running until app exit. */
  failedJobs: number
}

export async function releaseBridgeClient(
  clientId: string,
  deps?: ReleaseClientDeps
): Promise<ReleaseClientResult> {
  const resolved = deps ?? (await defaultDeps())
  const caller = bridgeCallerForClientId(clientId)
  const running = (await resolved.listJobs(caller)).filter((job) => job.status === "running")
  const outcomes = await Promise.allSettled(running.map((job) => resolved.killJob(job.id)))
  await resolved.dropGrant(caller)
  const failedJobs = outcomes.filter((outcome) => outcome.status === "rejected").length
  return { stoppedJobs: running.length - failedJobs, failedJobs }
}
