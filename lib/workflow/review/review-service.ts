import { getDb } from "@/lib/db/schema"
import { listUnresolvedContextComments } from "@/lib/db/context-comments"
import type { WorkflowAppDraft } from "@/types/workflow/app"
import type {
  WorkflowReview,
  WorkflowReviewActor,
  WorkflowReviewSuggestion,
  WorkflowThreeWayMerge,
} from "@/types/workflow/review"
import type { VisualWorkflow } from "@/types/workflow/visual"

export class WorkflowReviewError extends Error {
  constructor(
    readonly code:
      | "authentication_required"
      | "review_not_found"
      | "version_not_found"
      | "reviewer_denied"
      | "invalid_transition"
      | "review_gate_failed"
      | "suggestion_not_found"
      | "merge_conflict",
    message: string
  ) {
    super(message)
    this.name = "WorkflowReviewError"
  }
}

const ABSENT = Symbol("absent")

function equal(left: unknown, right: unknown): boolean {
  if (left === ABSENT || right === ABSENT) return left === right
  return JSON.stringify(left) === JSON.stringify(right)
}

function cloneValue(value: unknown | typeof ABSENT): unknown | typeof ABSENT {
  return value === ABSENT ? ABSENT : structuredClone(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function keyedArray(value: unknown): value is Array<Record<string, unknown> & { id: string }> {
  return (
    Array.isArray(value) &&
    value.every((item) => isRecord(item) && typeof item.id === "string") &&
    new Set(value.map((item) => item.id)).size === value.length
  )
}

function mergeValue(
  base: unknown | typeof ABSENT,
  suggested: unknown | typeof ABSENT,
  current: unknown | typeof ABSENT,
  path: string,
  conflicts: string[],
  resolutions: Readonly<Record<string, "current" | "suggested">>
): unknown | typeof ABSENT {
  if (equal(current, base)) return cloneValue(suggested)
  if (equal(suggested, base) || equal(current, suggested)) return cloneValue(current)

  if (base !== ABSENT && suggested !== ABSENT && current !== ABSENT) {
    if (isRecord(base) && isRecord(suggested) && isRecord(current)) {
      const merged: Record<string, unknown> = {}
      const keys = new Set([
        ...Object.keys(base),
        ...Object.keys(suggested),
        ...Object.keys(current),
      ])
      for (const key of [...keys].sort()) {
        const value = mergeValue(
          key in base ? base[key] : ABSENT,
          key in suggested ? suggested[key] : ABSENT,
          key in current ? current[key] : ABSENT,
          `${path}/${key}`,
          conflicts,
          resolutions
        )
        if (value !== ABSENT) merged[key] = value
      }
      return merged
    }
    if (keyedArray(base) && keyedArray(suggested) && keyedArray(current)) {
      const byId = (items: Array<Record<string, unknown> & { id: string }>) =>
        new Map(items.map((item) => [item.id, item]))
      const baseById = byId(base)
      const suggestedById = byId(suggested)
      const currentById = byId(current)
      const orderedIds = [
        ...current.map((item) => item.id),
        ...suggested.map((item) => item.id).filter((id) => !currentById.has(id)),
      ]
      return orderedIds.flatMap((id) => {
        const value = mergeValue(
          baseById.get(id) ?? ABSENT,
          suggestedById.get(id) ?? ABSENT,
          currentById.get(id) ?? ABSENT,
          `${path}/${id}`,
          conflicts,
          resolutions
        )
        return value === ABSENT ? [] : [value]
      })
    }
  }

  const conflictPath = path || "/"
  const resolution = resolutions[conflictPath]
  if (resolution === "suggested") return cloneValue(suggested)
  if (resolution === "current") return cloneValue(current)
  conflicts.push(conflictPath)
  return cloneValue(current)
}

export function previewWorkflowSuggestionMerge(
  base: VisualWorkflow,
  suggested: VisualWorkflow,
  current: VisualWorkflow,
  resolutions: Readonly<Record<string, "current" | "suggested">> = {}
): WorkflowThreeWayMerge {
  if (base.id !== suggested.id || base.id !== current.id) {
    return { merged: structuredClone(current), conflicts: ["/id"] }
  }
  const conflicts: string[] = []
  const merged = mergeValue(base, suggested, current, "", conflicts, resolutions)
  return { merged: merged as VisualWorkflow, conflicts }
}

function assertActor(actor: WorkflowReviewActor): void {
  if (!actor.subjectId.trim()) {
    throw new WorkflowReviewError("authentication_required", "OIDC authentication is required")
  }
}

function actorAllowed(review: WorkflowReview, actor: WorkflowReviewActor): boolean {
  if (review.reviewerSubjectIds.length === 0 && review.reviewerGroupIds.length === 0) return true
  return (
    review.reviewerSubjectIds.includes(actor.subjectId) ||
    actor.groupIds.some((groupId) => review.reviewerGroupIds.includes(groupId))
  )
}

async function ownedReview(accountId: string, reviewId: string): Promise<WorkflowReview> {
  const review = await getDb().workflowReviews.get(reviewId)
  if (!review || review.accountId !== accountId) {
    throw new WorkflowReviewError("review_not_found", "Workflow review was not found")
  }
  return review
}

async function hasBlockingComments(review: WorkflowReview): Promise<boolean> {
  if (!review.requireNoBlockingComments) return false
  const comments = await listUnresolvedContextComments("workflow", review.workflowId)
  return comments.some(
    (comment) => !comment.anchor.revision || comment.anchor.revision === review.versionId
  )
}

export async function createWorkflowReview(input: {
  accountId: string
  workflowId: string
  versionId: string
  actor: WorkflowReviewActor
  requiredApprovals?: number
  reviewerSubjectIds?: string[]
  reviewerGroupIds?: string[]
  requireNoBlockingComments?: boolean
  now?: number
}): Promise<WorkflowReview> {
  assertActor(input.actor)
  const requiredApprovals = input.requiredApprovals ?? 1
  if (!Number.isInteger(requiredApprovals) || requiredApprovals < 1) {
    throw new WorkflowReviewError("invalid_transition", "Required approvals must be positive")
  }
  const db = getDb()
  const version = await db.workflowVersions.get(input.versionId)
  if (
    !version ||
    version.accountId !== input.accountId ||
    version.workflowId !== input.workflowId
  ) {
    throw new WorkflowReviewError("version_not_found", "Workflow version was not found")
  }
  const now = input.now ?? Date.now()
  return db.transaction("rw", db.workflowReviews, async () => {
    const open = await db.workflowReviews
      .where("[accountId+workflowId]")
      .equals([input.accountId, input.workflowId])
      .filter((review) => !["superseded", "published"].includes(review.status))
      .toArray()
    const review: WorkflowReview = {
      id: `wfr_${crypto.randomUUID()}`,
      accountId: input.accountId,
      workflowId: input.workflowId,
      versionId: input.versionId,
      status: "draft",
      requiredApprovals,
      reviewerSubjectIds: [...new Set(input.reviewerSubjectIds ?? [])],
      reviewerGroupIds: [...new Set(input.reviewerGroupIds ?? [])],
      requireNoBlockingComments: input.requireNoBlockingComments ?? true,
      approvals: [],
      requestedChangesBy: [],
      createdBy: input.actor.subjectId,
      createdAt: now,
      updatedAt: now,
    }
    await db.workflowReviews.bulkPut([
      ...open.map((prior) => ({
        ...prior,
        status: "superseded" as const,
        supersededByReviewId: review.id,
        updatedAt: now,
      })),
      review,
    ])
    return review
  })
}

export async function startWorkflowReview(input: {
  accountId: string
  reviewId: string
  actor: WorkflowReviewActor
  now?: number
}): Promise<WorkflowReview> {
  assertActor(input.actor)
  const review = await ownedReview(input.accountId, input.reviewId)
  if (
    review.createdBy !== input.actor.subjectId ||
    !["draft", "changes-requested"].includes(review.status)
  ) {
    throw new WorkflowReviewError(
      "invalid_transition",
      "Only the review owner can submit this review"
    )
  }
  const updated: WorkflowReview = {
    ...review,
    status: "in-review",
    approvals: [],
    requestedChangesBy: [],
    updatedAt: input.now ?? Date.now(),
  }
  await getDb().workflowReviews.put(updated)
  return updated
}

export async function approveWorkflowReview(input: {
  accountId: string
  reviewId: string
  actor: WorkflowReviewActor
  now?: number
}): Promise<WorkflowReview> {
  assertActor(input.actor)
  const review = await ownedReview(input.accountId, input.reviewId)
  if (review.status !== "in-review") {
    throw new WorkflowReviewError("invalid_transition", "Review is not accepting approvals")
  }
  if (!actorAllowed(review, input.actor)) {
    throw new WorkflowReviewError("reviewer_denied", "Actor is not an assigned reviewer")
  }
  const now = input.now ?? Date.now()
  const approvals = [
    ...review.approvals.filter((approval) => approval.subjectId !== input.actor.subjectId),
    { subjectId: input.actor.subjectId, at: now },
  ]
  const blocking = await hasBlockingComments(review)
  const updated: WorkflowReview = {
    ...review,
    approvals,
    status: approvals.length >= review.requiredApprovals && !blocking ? "approved" : "in-review",
    updatedAt: now,
  }
  await getDb().workflowReviews.put(updated)
  return updated
}

export async function requestWorkflowReviewChanges(input: {
  accountId: string
  reviewId: string
  actor: WorkflowReviewActor
  now?: number
}): Promise<WorkflowReview> {
  assertActor(input.actor)
  const review = await ownedReview(input.accountId, input.reviewId)
  if (review.status !== "in-review" || !actorAllowed(review, input.actor)) {
    throw new WorkflowReviewError("reviewer_denied", "Review is not accepting this decision")
  }
  const updated: WorkflowReview = {
    ...review,
    status: "changes-requested",
    approvals: [],
    requestedChangesBy: [...new Set([...review.requestedChangesBy, input.actor.subjectId])],
    updatedAt: input.now ?? Date.now(),
  }
  await getDb().workflowReviews.put(updated)
  return updated
}

export async function createWorkflowReviewSuggestion(input: {
  accountId: string
  reviewId: string
  actor: WorkflowReviewActor
  suggested: VisualWorkflow
  now?: number
}): Promise<WorkflowReviewSuggestion> {
  assertActor(input.actor)
  const review = await ownedReview(input.accountId, input.reviewId)
  if (!actorAllowed(review, input.actor)) {
    throw new WorkflowReviewError("reviewer_denied", "Actor is not an assigned reviewer")
  }
  const version = await getDb().workflowVersions.get(review.versionId)
  if (!version) throw new WorkflowReviewError("version_not_found", "Workflow version was not found")
  if (input.suggested.id !== version.definition.id) {
    throw new WorkflowReviewError("merge_conflict", "Suggestion targets another workflow")
  }
  const now = input.now ?? Date.now()
  const suggestion: WorkflowReviewSuggestion = {
    id: `wfrs_${crypto.randomUUID()}`,
    reviewId: review.id,
    accountId: review.accountId,
    workflowId: review.workflowId,
    baseVersionId: review.versionId,
    authorSubjectId: input.actor.subjectId,
    status: "proposed",
    base: structuredClone(version.definition),
    suggested: structuredClone(input.suggested),
    conflictPaths: [],
    createdAt: now,
    updatedAt: now,
  }
  await getDb().workflowReviewSuggestions.add(suggestion)
  return suggestion
}

export async function previewStoredWorkflowSuggestion(input: {
  accountId: string
  suggestionId: string
  current: VisualWorkflow
}): Promise<WorkflowThreeWayMerge> {
  const suggestion = await getDb().workflowReviewSuggestions.get(input.suggestionId)
  if (!suggestion || suggestion.accountId !== input.accountId) {
    throw new WorkflowReviewError("suggestion_not_found", "Workflow suggestion was not found")
  }
  return previewWorkflowSuggestionMerge(suggestion.base, suggestion.suggested, input.current)
}

async function ownedSuggestion(input: {
  accountId: string
  suggestionId: string
  actor: WorkflowReviewActor
}): Promise<{ suggestion: WorkflowReviewSuggestion; review: WorkflowReview }> {
  assertActor(input.actor)
  const suggestion = await getDb().workflowReviewSuggestions.get(input.suggestionId)
  if (!suggestion || suggestion.accountId !== input.accountId) {
    throw new WorkflowReviewError("suggestion_not_found", "Workflow suggestion was not found")
  }
  const review = await ownedReview(input.accountId, suggestion.reviewId)
  if (review.createdBy !== input.actor.subjectId) {
    throw new WorkflowReviewError("reviewer_denied", "Only the review owner can apply suggestions")
  }
  return { suggestion, review }
}

export async function applyStoredWorkflowSuggestion(input: {
  accountId: string
  suggestionId: string
  actor: WorkflowReviewActor
  current: VisualWorkflow
  resolutions: Readonly<Record<string, "current" | "suggested">>
  now?: number
}): Promise<WorkflowThreeWayMerge> {
  const { suggestion } = await ownedSuggestion(input)
  if (!["proposed", "conflicted"].includes(suggestion.status)) {
    throw new WorkflowReviewError("invalid_transition", "Workflow suggestion is already closed")
  }
  const merge = previewWorkflowSuggestionMerge(
    suggestion.base,
    suggestion.suggested,
    input.current,
    input.resolutions
  )
  const now = input.now ?? Date.now()
  if (merge.conflicts.length > 0) {
    await getDb().workflowReviewSuggestions.put({
      ...suggestion,
      status: "conflicted",
      conflictPaths: merge.conflicts,
      updatedAt: now,
    })
    throw new WorkflowReviewError(
      "merge_conflict",
      `Workflow suggestion has unresolved conflicts: ${merge.conflicts.join(", ")}`
    )
  }
  await getDb().workflowReviewSuggestions.put({
    ...suggestion,
    status: "applied",
    conflictPaths: [],
    appliedAt: now,
    updatedAt: now,
  })
  return merge
}

export async function rejectStoredWorkflowSuggestion(input: {
  accountId: string
  suggestionId: string
  actor: WorkflowReviewActor
  now?: number
}): Promise<WorkflowReviewSuggestion> {
  const { suggestion } = await ownedSuggestion(input)
  if (!["proposed", "conflicted"].includes(suggestion.status)) {
    throw new WorkflowReviewError("invalid_transition", "Workflow suggestion is already closed")
  }
  const updated: WorkflowReviewSuggestion = {
    ...suggestion,
    status: "rejected",
    updatedAt: input.now ?? Date.now(),
  }
  await getDb().workflowReviewSuggestions.put(updated)
  return updated
}

export async function assertWorkflowReviewGate(input: {
  accountId: string
  workflowId: string
  versionId: string
  policy: WorkflowAppDraft["reviewGate"]
}): Promise<WorkflowReview | undefined> {
  if (!input.policy.enabled) return undefined
  const reviews = await getDb()
    .workflowReviews.where("[accountId+workflowId]")
    .equals([input.accountId, input.workflowId])
    .filter((review) => review.versionId === input.versionId && review.status === "approved")
    .toArray()
  const review = reviews.sort((left, right) => right.updatedAt - left.updatedAt)[0]
  const policyMatches =
    review &&
    review.requiredApprovals >= input.policy.requiredApprovals &&
    input.policy.reviewerSubjectIds.every((id) => review.reviewerSubjectIds.includes(id)) &&
    input.policy.reviewerGroupIds.every((id) => review.reviewerGroupIds.includes(id)) &&
    review.approvals.length >= input.policy.requiredApprovals
  if (
    !review ||
    !policyMatches ||
    (input.policy.requireNoBlockingComments && (await hasBlockingComments(review)))
  ) {
    throw new WorkflowReviewError(
      "review_gate_failed",
      "Workflow version has not passed its deployment review gate"
    )
  }
  return review
}

export async function markWorkflowReviewPublished(
  reviewId: string,
  now = Date.now()
): Promise<void> {
  const review = await getDb().workflowReviews.get(reviewId)
  if (!review || review.status !== "approved") return
  await getDb().workflowReviews.put({
    ...review,
    status: "published",
    publishedAt: now,
    updatedAt: now,
  })
}
