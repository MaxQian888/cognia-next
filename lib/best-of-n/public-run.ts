import type { BestOfNGroup } from "@/types/best-of-n"
import { describeBestOfNAgent } from "./agents"
import type { BestOfNPublicRun } from "@cognia/plugin-contract/lib/best-of-n/public-run"
export type {
  BestOfNPublicCandidate,
  BestOfNPublicRun,
} from "@cognia/plugin-contract/lib/best-of-n/public-run"

/**
 * The ledger minus its authority fields: no owner lease, version, physical
 * roots or workspace ids, so nothing read here can be replayed as a mutation.
 */
export function toPublicBestOfNRun(group: BestOfNGroup): BestOfNPublicRun {
  return {
    groupId: group.groupId,
    phase: group.phase,
    n: group.n,
    baseSha: group.baseSha,
    targetRef: group.targetRef,
    targetIsNew: group.targetIsNew,
    selectedCandidateId: group.selectedCandidateId,
    archiveStatus: group.archiveStatus,
    error: group.error,
    createdAt: group.createdAt,
    candidates: group.candidates.map((candidate) => {
      const runtime = describeBestOfNAgent(candidate.agent)
      return {
        index: candidate.index + 1,
        candidateId: candidate.candidateId,
        status: candidate.status,
        runtime: runtime.kind,
        agent: runtime.kind === "external" ? (runtime.configId ?? "unknown") : runtime.agentId,
        model: candidate.agent.model ?? null,
        headSha: candidate.headSha,
        hasChanges: candidate.hasChanges,
        costUsd: candidate.costUsd,
        error: candidate.error,
      }
    }),
  }
}
