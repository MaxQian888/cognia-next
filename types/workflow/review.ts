import type { VisualWorkflow } from "./visual"

export type WorkflowReviewStatus =
  "draft" | "in-review" | "changes-requested" | "approved" | "superseded" | "published"

export interface WorkflowReviewApproval {
  subjectId: string
  at: number
}

export interface WorkflowReview {
  id: string
  accountId: string
  workflowId: string
  versionId: string
  status: WorkflowReviewStatus
  requiredApprovals: number
  reviewerSubjectIds: string[]
  reviewerGroupIds: string[]
  requireNoBlockingComments: boolean
  approvals: WorkflowReviewApproval[]
  requestedChangesBy: string[]
  createdBy: string
  createdAt: number
  updatedAt: number
  supersededByReviewId?: string
  publishedAt?: number
}

export interface WorkflowReviewSuggestion {
  id: string
  reviewId: string
  accountId: string
  workflowId: string
  baseVersionId: string
  authorSubjectId: string
  status: "proposed" | "applied" | "rejected" | "conflicted"
  base: VisualWorkflow
  suggested: VisualWorkflow
  conflictPaths: string[]
  createdAt: number
  updatedAt: number
  appliedAt?: number
}

export interface WorkflowReviewActor {
  subjectId: string
  groupIds: string[]
}

export interface WorkflowThreeWayMerge {
  merged: VisualWorkflow
  conflicts: string[]
}
