/** Host-owned wire contract; renderer state is a disposable projection. */
export type BestOfNPhase =
  | "preparing"
  | "running"
  | "awaitingSelection"
  | "publishing"
  | "published"
  | "cancelling"
  | "cancelled"
  | "recoveryRequired"
export type BestOfNCandidateStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelRequested"
  | "cancelled"
  | "recoveryRequired"
export interface BestOfNAgent {
  agentId: string
  model?: string | null
  provider?: string | null
}
export interface BestOfNBudget {
  maxCostUsd?: number | null
  maxDurationMs?: number | null
}
export interface BestOfNCandidate {
  candidateId: string
  index: number
  agent: BestOfNAgent
  childSessionId: string
  workspaceBundleId: string | null
  physicalRoot: string | null
  changesetId: string | null
  headSha: string | null
  status: BestOfNCandidateStatus
  hasChanges: boolean
  costUsd: number | null
  startedAt: number | null
  finishedAt: number | null
  error: string | null
}
export interface BestOfNGroup {
  groupId: string
  requestId: string
  repositoryId: string
  repoCommonDir: string
  sourceRoot: string
  baseSha: string
  checkoutHadUncommittedChanges: boolean
  targetRef: string
  targetIsNew: boolean
  n: number
  budgetPolicy: BestOfNBudget
  teamRunId: string
  phase: BestOfNPhase
  selectedCandidateId: string | null
  selectedHeadSha: string | null
  integrationId: string | null
  version: number
  ownerId: string
  ownerLeaseExpiresAt: number
  archiveStatus: string
  archiveError: string | null
  error: string | null
  createdAt: number
  updatedAt: number
  candidates: BestOfNCandidate[]
}
export interface StartBestOfN {
  requestId: string
  repositoryId: string
  sourceRoot: string
  baseRef?: string
  targetRef?: string
  targetIsNew: boolean
  budgetPolicy: BestOfNBudget
  candidates: BestOfNAgent[]
  ownerId: string
  leaseDurationMs: number
}
export interface BestOfNMutation {
  groupId: string
  expectedVersion: number
  ownerId: string
  leaseDurationMs: number
}
export interface BestOfNProgress {
  mutation: BestOfNMutation
  candidateId: string
  status: BestOfNCandidateStatus
  workspaceBundleId?: string
  physicalRoot?: string
  changesetId?: string
  headSha?: string
  hasChanges: boolean
  costUsd?: number | null
  error?: string
  teamRunId?: string
}
