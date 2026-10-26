/**
 * The plugin contract's share of `lib/best-of-n/public-run.ts`, which re-exports these.
 */
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
