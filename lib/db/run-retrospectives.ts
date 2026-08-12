import type {
  RunLearningProposal,
  RunRetrospective,
  RunRetrospectiveBundle,
} from "@/types/execution/retrospective"

import { getDb, withDbReopenRetry } from "./schema"

const RESOLVED_PROPOSAL_STATUSES = new Set<RunLearningProposal["status"]>(["applied", "rejected"])

export async function getRunRetrospectiveByKey(
  runId: string,
  analysisVersion: number
): Promise<RunRetrospective | undefined> {
  return getDb().runRetrospectives.where("runKey").equals(`${runId}:${analysisVersion}`).first()
}

export async function getRunRetrospectiveBundle(
  retrospectiveId: string
): Promise<RunRetrospectiveBundle | undefined> {
  const db = getDb()
  const retrospective = await db.runRetrospectives.get(retrospectiveId)
  if (!retrospective) return undefined
  const proposals = await db.runLearningProposals
    .where("retrospectiveId")
    .equals(retrospectiveId)
    .sortBy("createdAt")
  return { retrospective, proposals }
}

export async function getRunRetrospectiveBundleByRun(
  runId: string,
  analysisVersion: number
): Promise<RunRetrospectiveBundle | undefined> {
  const retrospective = await getRunRetrospectiveByKey(runId, analysisVersion)
  return retrospective ? getRunRetrospectiveBundle(retrospective.id) : undefined
}

export async function putRunRetrospectiveBundle(
  bundle: RunRetrospectiveBundle
): Promise<RunRetrospectiveBundle> {
  return withDbReopenRetry(async () => {
    const db = getDb()
    return db.transaction("rw", db.runRetrospectives, db.runLearningProposals, async () => {
      const existing = await db.runRetrospectives
        .where("runKey")
        .equals(bundle.retrospective.runKey)
        .first()
      if (existing) {
        const proposals = await db.runLearningProposals
          .where("retrospectiveId")
          .equals(existing.id)
          .sortBy("createdAt")
        return { retrospective: existing, proposals }
      }
      if (
        bundle.proposals.some((proposal) => proposal.retrospectiveId !== bundle.retrospective.id)
      ) {
        throw new Error("Run learning proposal retrospective mismatch")
      }
      await db.runRetrospectives.add(bundle.retrospective)
      if (bundle.proposals.length > 0) await db.runLearningProposals.bulkAdd(bundle.proposals)
      return bundle
    })
  })
}

async function refreshRetrospectiveStatus(retrospectiveId: string, now: number): Promise<void> {
  const db = getDb()
  const proposals = await db.runLearningProposals
    .where("retrospectiveId")
    .equals(retrospectiveId)
    .toArray()
  if (proposals.every((proposal) => RESOLVED_PROPOSAL_STATUSES.has(proposal.status))) {
    await db.runRetrospectives.update(retrospectiveId, { status: "resolved", updatedAt: now })
  }
}

export async function transitionRunLearningProposal(
  proposalId: string,
  expected: RunLearningProposal["status"][],
  patch: Pick<RunLearningProposal, "status"> &
    Partial<Pick<RunLearningProposal, "effectRef" | "applyError" | "resolvedAt">>,
  now = Date.now()
): Promise<RunLearningProposal> {
  return withDbReopenRetry(async () => {
    const db = getDb()
    return db.transaction("rw", db.runRetrospectives, db.runLearningProposals, async () => {
      const current = await db.runLearningProposals.get(proposalId)
      if (!current) throw new Error(`Unknown run learning proposal: ${proposalId}`)
      if (!expected.includes(current.status)) {
        if (current.status === patch.status) return current
        throw new Error(`Run learning proposal is ${current.status}`)
      }
      const next: RunLearningProposal = {
        ...current,
        ...patch,
        updatedAt: now,
      }
      await db.runLearningProposals.put(next)
      await refreshRetrospectiveStatus(current.retrospectiveId, now)
      return next
    })
  })
}

export async function listSessionRunRetrospectives(
  sessionId: string
): Promise<RunRetrospectiveBundle[]> {
  const db = getDb()
  const runs = await db.executionRuns.where("sessionId").equals(sessionId).toArray()
  if (runs.length === 0) return []
  const rows = await db.runRetrospectives
    .where("runId")
    .anyOf(runs.map((run) => run.id))
    .toArray()
  const bundles = await Promise.all(rows.map((row) => getRunRetrospectiveBundle(row.id)))
  return bundles
    .filter((bundle): bundle is RunRetrospectiveBundle => Boolean(bundle))
    .sort((a, b) => b.retrospective.createdAt - a.retrospective.createdAt)
}

export async function countPendingSessionRunLearningProposals(sessionId: string): Promise<number> {
  const bundles = await listSessionRunRetrospectives(sessionId)
  return bundles.reduce(
    (count, bundle) =>
      count + bundle.proposals.filter((proposal) => proposal.status === "pending").length,
    0
  )
}
