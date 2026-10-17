import type { BestOfNGroup } from "@/types/best-of-n"
import type { AgentChangeset, ChangesetCheck, IntegrationRun } from "@/lib/scm/types"
import type { ScmHost } from "@/lib/scm/host"
import type { ScmRuntime } from "@/lib/scm/runtime"
import type { ChangesetReviewResult } from "@/lib/scm/review/review-changeset"
import { approveChangeset, requiredChecksFor } from "@/lib/scm/review/review-changeset"
import { unmetChecks } from "@/lib/scm/verify/changeset-checks"

export interface BestOfNCheckResult {
  group: BestOfNGroup
  checks: ChangesetCheck[]
  requiredChecks: string[]
}

interface PublicationDeps {
  get(groupId: string): Promise<BestOfNGroup>
  select(groupId: string, candidateId: string, headSha: string): Promise<BestOfNGroup>
  cancel(groupId: string): Promise<BestOfNGroup>
  archive(groupId: string): Promise<BestOfNGroup>
  scm: ScmHost
  verify(
    group: BestOfNGroup,
    changeset: AgentChangeset,
    signal: AbortSignal
  ): Promise<ChangesetReviewResult>
  runtime(group: BestOfNGroup): Promise<ScmRuntime>
  archiveSession(id: string): Promise<void>
  project(group: BestOfNGroup, sessionArchiveError?: string | null): Promise<unknown>
}

/** Runs that still hold their changesets `integrating`; abort is legal from each. */
const HOLDING: ReadonlySet<IntegrationRun["state"]> = new Set([
  "preparing",
  "prepared",
  "stale",
  "conflicted",
])

function winner(group: BestOfNGroup) {
  const candidate = group.candidates.find((item) => item.candidateId === group.selectedCandidateId)
  if (
    !candidate ||
    !candidate.hasChanges ||
    candidate.status !== "succeeded" ||
    !candidate.headSha ||
    !candidate.changesetId ||
    candidate.headSha !== group.selectedHeadSha
  )
    throw new Error("Best-of-N has no publishable selected winner")
  return candidate
}

/** Interactive actions only. Host reads, never the synced summary, authorize a write. */
export function createBestOfNPublication(deps: PublicationDeps) {
  const active = new Set<string>()
  async function exclusive<T>(groupId: string, action: () => Promise<T>) {
    if (active.has(groupId)) throw new Error("Best-of-N action is already running")
    active.add(groupId)
    try {
      return await action()
    } finally {
      active.delete(groupId)
    }
  }
  async function exactChangeset(group: BestOfNGroup) {
    const selected = winner(group)
    const changeset = await deps.scm.getChangeset(selected.changesetId!)
    if (
      !changeset ||
      changeset.headSha !== group.selectedHeadSha ||
      changeset.baseSha !== group.baseSha ||
      changeset.targetRef !== group.targetRef ||
      changeset.sessionId !== selected.childSessionId
    )
      throw new Error("Best-of-N winner changeset no longer matches the recorded head and target")
    return changeset
  }
  /**
   * A refused publish (for example a dirty checked-out target) keeps its
   * prepared integration, and a Host restart can leave one behind. Either
   * leaves the winner `integrating`, which review refuses. Abort that run:
   * the Host returns a best-of-N winner to its reviewed state, so the retry
   * re-runs exact-head checks and prepares a fresh integration.
   */
  async function releaseHeldIntegration(group: BestOfNGroup, changeset: AgentChangeset) {
    if (changeset.state !== "integrating") return changeset
    const run = changeset.integrationId
      ? await deps.scm.getIntegration(changeset.integrationId)
      : null
    if (!run || !HOLDING.has(run.state))
      throw new Error(
        `Best-of-N winner is held by integration ${changeset.integrationId ?? "unknown"}` +
          (run ? ` (${run.state})` : "")
      )
    await deps.scm.abortIntegration(run.integrationId)
    const released = await exactChangeset(group)
    if (released.state === "integrating")
      throw new Error(`Best-of-N winner is still held by integration ${run.integrationId}`)
    return released
  }
  async function checks(groupId: string, signal: AbortSignal): Promise<BestOfNCheckResult> {
    const group = await deps.get(groupId)
    if (group.phase !== "publishing")
      throw new Error("Best-of-N winner is not awaiting publication")
    const changeset = await releaseHeldIntegration(group, await exactChangeset(group))
    const result = await deps.verify(group, changeset, signal)
    if (result.changeset.headSha !== group.selectedHeadSha)
      throw new Error("Best-of-N head changed while checks were running")
    if (!result.policy) throw new Error("Best-of-N target review policy is invalid")
    const current = await deps.get(groupId)
    await exactChangeset(current)
    if (
      current.selectedCandidateId !== group.selectedCandidateId ||
      current.selectedHeadSha !== group.selectedHeadSha
    )
      throw new Error("Best-of-N selection changed while checks were running")
    await deps.project(current)
    return {
      group: current,
      checks: result.checks,
      requiredChecks: requiredChecksFor(result.changeset, result.policy),
    }
  }
  async function archive(groupId: string) {
    let group = await deps.get(groupId)
    if (["preparing", "running", "awaitingSelection", "cancelling"].includes(group.phase))
      group = await deps.cancel(groupId)
    const errors: string[] = []
    try {
      group = await deps.archive(groupId)
      if (group.archiveError) errors.push(group.archiveError)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
    // A successful publication is never turned into a failed run by cleanup.
    // Session cleanup can be retried independently of Host workspace archival.
    const sessions = await Promise.allSettled(
      group.candidates
        .filter((candidate) => candidate.candidateId !== group.selectedCandidateId)
        .map((candidate) => deps.archiveSession(candidate.childSessionId))
    )
    for (const result of sessions)
      if (result.status === "rejected")
        errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason))
    const archiveError = errors.length ? errors.join("; ") : null
    await deps.project(group, archiveError)
    return { group, archiveError }
  }
  return {
    pick: (groupId: string, candidateId: string, signal = new AbortController().signal) =>
      exclusive(groupId, async () => {
        const current = await deps.get(groupId)
        const candidate = current.candidates.find((item) => item.candidateId === candidateId)
        if (
          !candidate?.headSha ||
          !candidate.changesetId ||
          !candidate.hasChanges ||
          candidate.status !== "succeeded"
        )
          throw new Error("Best-of-N candidate has no publishable changes")
        await deps.select(groupId, candidateId, candidate.headSha)
        return checks(groupId, signal)
      }),
    checks: (groupId: string, signal = new AbortController().signal) =>
      exclusive(groupId, () => checks(groupId, signal)),
    publish: (groupId: string, signal = new AbortController().signal) =>
      exclusive(groupId, async () => {
        // Re-run against the pinned head and current target policy, including on
        // retries/restarts. Cached green checks alone never authorize a publish.
        const checked = await checks(groupId, signal)
        signal.throwIfAborted()
        if (
          unmetChecks(checked.requiredChecks, checked.checks, checked.group.selectedHeadSha!).length
        )
          throw new Error("Best-of-N required checks did not pass at the selected head")
        const changeset = await exactChangeset(await deps.get(groupId))
        // Pressing Publish is the user's exact-head approval, not an AI verdict.
        await approveChangeset(deps.scm, changeset, "interactive-user")
        const runtime = await deps.runtime(checked.group)
        const outcome = await runtime.integrate({
          changesetIds: [changeset.changesetId],
          targetRef: checked.group.targetRef,
          strategy: "merge",
          onConflict: "stop",
          requiredChecks: checked.requiredChecks,
          signal,
        })
        if (outcome.kind !== "published") {
          // Give the winner back now so cancel and archive work while the
          // person fixes the refusal. If this fails, the next checks retry it.
          let releaseError: string | null = null
          if (outcome.run && HOLDING.has(outcome.run.state)) {
            try {
              await deps.scm.abortIntegration(outcome.run.integrationId)
            } catch (error) {
              releaseError = error instanceof Error ? error.message : String(error)
            }
          }
          const group = await deps.get(groupId)
          await deps.project(group)
          return { group, outcome, archiveError: null, releaseError }
        }
        let group = checked.group
        try {
          group = await deps.get(groupId)
          return { ...(await archive(groupId)), outcome, releaseError: null }
        } catch (error) {
          // In particular, a projection/database outage must not erase the
          // integration receipt. A subsequent refresh rebuilds it from Host.
          return {
            group,
            outcome,
            archiveError: error instanceof Error ? error.message : String(error),
            releaseError: null,
          }
        }
      }),
    archive: (groupId: string) => exclusive(groupId, () => archive(groupId)),
    /**
     * After a Host restart: give back an integration a publishing winner is
     * still held by, so the person can re-run checks and publish again.
     * `true` when one was released.
     */
    release: (groupId: string) =>
      exclusive(groupId, async () => {
        const group = await deps.get(groupId)
        if (group.phase !== "publishing") return false
        const changeset = await exactChangeset(group)
        if (changeset.state !== "integrating") return false
        await releaseHeldIntegration(group, changeset)
        return true
      }),
  }
}

let production: ReturnType<typeof createBestOfNPublication> | undefined
async function publication() {
  const { canManageBestOfNRuns } = await import("./projection")
  if (!canManageBestOfNRuns())
    throw new Error("Best-of-N actions require the executing desktop Host")
  if (production) return production
  const [
    { bestOfNService },
    { createBestOfNHost },
    { getSourceControlService },
    { createScmRuntime },
    { checkBestOfNHead },
    { getBestOfNRun, projectBestOfNGroup },
    { setSessionsArchived },
  ] = await Promise.all([
    import("./service"),
    import("./host"),
    import("@/lib/scm/service"),
    import("@/lib/scm/runtime"),
    import("./checks"),
    import("./projection"),
    import("@/lib/chat/session-archive-writes"),
  ])
  if (production) return production
  const host = createBestOfNHost()
  const service = bestOfNService()
  const scm = getSourceControlService().changesets
  production = createBestOfNPublication({
    get: host.get,
    select: service.select,
    cancel: service.cancel,
    archive: service.archive,
    scm,
    verify: async (group, changeset, signal) =>
      checkBestOfNHead(
        group,
        changeset,
        (await getBestOfNRun(group.groupId))?.projectId ?? null,
        scm,
        signal
      ),
    runtime: async (group) =>
      createScmRuntime({
        projectId: (await getBestOfNRun(group.groupId))?.projectId ?? null,
        configRoot: group.sourceRoot,
        appSettings: null,
        host: scm,
      }),
    archiveSession: (id) => setSessionsArchived([id], true),
    project: (group, sessionArchiveError) =>
      projectBestOfNGroup(
        group,
        sessionArchiveError === undefined ? undefined : { sessionArchiveError }
      ),
  })
  return production
}
export async function pickBestOfNCandidate(groupId: string, candidateId: string) {
  return (await publication()).pick(groupId, candidateId)
}
export async function runChecksBestOfNCandidate(groupId: string) {
  return (await publication()).checks(groupId)
}
export async function publishBestOfNCandidate(groupId: string) {
  return (await publication()).publish(groupId)
}
export async function archiveBestOfN(groupId: string) {
  return (await publication()).archive(groupId)
}
export async function releaseBestOfNIntegration(groupId: string) {
  return (await publication()).release(groupId)
}
