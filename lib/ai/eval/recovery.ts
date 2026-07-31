import type { EvalExperimentState } from "@cognia/eval-core"
import { recoverInterruptedEvalWork } from "@/lib/db/eval-lab"
import { getDb } from "@/lib/db/schema"

interface RecoveryCandidate {
  id: string
  state: EvalExperimentState
  updatedAt: number
}

export interface EvalStartupRecoveryDependencies {
  listCandidates(): Promise<RecoveryCandidate[]>
  recover: typeof recoverInterruptedEvalWork
}

const defaultDependencies: EvalStartupRecoveryDependencies = {
  async listCandidates() {
    const rows = await getDb()
      .evalExperiments.filter((item) =>
        ["queued", "running", "paused", "interrupted"].includes(item.state)
      )
      .toArray()
    return rows.map(({ id, state, updatedAt }) => ({ id, state, updatedAt }))
  },
  recover: recoverInterruptedEvalWork,
}

/**
 * Reconcile renderer termination without silently repeating ambiguous spend.
 * Only tasks carrying a provider-verified idempotency key return to `queued`;
 * every other in-flight request becomes an explicit interrupted review item.
 */
export async function recoverEvalQueueOnStartup(
  dependencies: EvalStartupRecoveryDependencies = defaultDependencies
): Promise<Array<{ experimentId: string; state: EvalExperimentState }>> {
  const candidates = (await dependencies.listCandidates()).sort(
    (left, right) => right.updatedAt - left.updatedAt
  )
  const recovered: Array<{ experimentId: string; state: EvalExperimentState }> = []
  for (const candidate of candidates) {
    if (candidate.state !== "running") {
      recovered.push({ experimentId: candidate.id, state: candidate.state })
      continue
    }
    const result = await dependencies.recover(candidate.id)
    recovered.push({
      experimentId: candidate.id,
      state: result.interruptedTaskIds.length > 0 ? "interrupted" : "queued",
    })
  }
  return recovered
}
