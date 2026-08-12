import type { ResourceRefV1 } from "@cognia/agent-config-types/governance"

export const RUN_RETROSPECTIVE_ANALYSIS_VERSION = 1

export type RunLearningTargetKind =
  "team-config" | "project-environment" | "memory-candidate" | "skill-draft" | "observation"

export type RunLearningProposalStatus =
  "pending" | "approved_pending_apply" | "applied" | "rejected" | "apply_failed"

export interface RunRetrospectiveTimelineItem {
  at: number
  summary: string
  eventRef?: ResourceRefV1
}

export interface RunRetrospective {
  id: string
  runId: string
  runKey: string
  analysisVersion: number
  status: "pending_review" | "resolved"
  issueTimeline: RunRetrospectiveTimelineItem[]
  contentHash: string
  createdAt: number
  updatedAt: number
}

export interface RunLearningProposal {
  id: string
  retrospectiveId: string
  runId: string
  targetKind: RunLearningTargetKind
  targetId?: string
  title: string
  before?: string
  after: string
  status: RunLearningProposalStatus
  evidenceRefs: ResourceRefV1[]
  effectRef?: ResourceRefV1
  applyError?: string
  createdAt: number
  updatedAt: number
  resolvedAt?: number
}

export interface RunRetrospectiveBundle {
  retrospective: RunRetrospective
  proposals: RunLearningProposal[]
}
