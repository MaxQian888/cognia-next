import type { BestOfNGroup } from "@/types/best-of-n"
import { describeBestOfNAgent } from "./agents"

/** One attempt as surfaces outside the desktop UI see it (CLI, plugins). */
export interface BestOfNPublicCandidate {
  /** 1-based, the number a person types. */
  index: number
  candidateId: string
  status: string
  runtime: "cognia" | "external"
  /** The Cognia agent id, or the external configuration id. */
  agent: string
  model: string | null
  headSha: string | null
  hasChanges: boolean
  /** Null is unknown, never free. */
  costUsd: number | null
  error: string | null
}

export interface BestOfNPublicRun {
  groupId: string
  phase: string
  n: number
  baseSha: string
  targetRef: string
  targetIsNew: boolean
  selectedCandidateId: string | null
  archiveStatus: string
  error: string | null
  createdAt: number
  candidates: BestOfNPublicCandidate[]
}

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
