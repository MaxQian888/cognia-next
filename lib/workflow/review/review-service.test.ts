/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { addContextComment, resolveContextComment } from "@/lib/db/context-comments"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { VisualWorkflow } from "@/types/workflow/visual"
import {
  applyStoredWorkflowSuggestion,
  approveWorkflowReview,
  assertWorkflowReviewGate,
  createWorkflowReview,
  createWorkflowReviewSuggestion,
  previewStoredWorkflowSuggestion,
  previewWorkflowSuggestionMerge,
  rejectStoredWorkflowSuggestion,
  requestWorkflowReviewChanges,
  startWorkflowReview,
} from "./review-service"

jest.setTimeout(20_000)

const owner = { subjectId: "owner", groupIds: ["authors"] }
const reviewer = { subjectId: "reviewer", groupIds: ["security"] }

function workflow(over: Partial<VisualWorkflow> = {}): VisualWorkflow {
  return {
    id: "workflow_1",
    schemaVersion: 2,
    name: "Review me",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "node_a",
        type: "io.output",
        position: { x: 0, y: 0 },
        data: { label: "Output", typeVersion: 1, params: {} },
      },
    ],
    edges: [],
    settings: {} as never,
    ...over,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  await getDb().workflowVersions.add({
    id: "version_1",
    accountId: "acct_a",
    workflowId: "workflow_1",
    sequence: 1,
    definition: workflow(),
    interface: { inputSchema: {}, outputSchema: {} },
    dependencyManifest: { nodeTypes: [], workflows: [], credentials: [] },
    configDefinition: { constants: {}, secretRefs: [] },
    digest: "digest_1",
    name: "Version 1",
    createdAt: 1,
  })
})

afterEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

it("enforces OIDC reviewers, change requests, quorum, and unresolved-comment gates", async () => {
  const review = await createWorkflowReview({
    accountId: "acct_a",
    workflowId: "workflow_1",
    versionId: "version_1",
    actor: owner,
    reviewerGroupIds: ["security"],
    requiredApprovals: 1,
  })
  await startWorkflowReview({ accountId: "acct_a", reviewId: review.id, actor: owner })
  await expect(
    approveWorkflowReview({
      accountId: "acct_a",
      reviewId: review.id,
      actor: { subjectId: "outsider", groupIds: [] },
    })
  ).rejects.toMatchObject({ code: "reviewer_denied" })

  await requestWorkflowReviewChanges({
    accountId: "acct_a",
    reviewId: review.id,
    actor: reviewer,
  })
  await startWorkflowReview({ accountId: "acct_a", reviewId: review.id, actor: owner })
  const comment = await addContextComment({
    resource: { kind: "workflow", id: "workflow_1" },
    anchor: { kind: "workflow-node", nodeId: "node_a", revision: "version_1" },
    authorId: "reviewer",
    authorName: "Reviewer",
    content: "Please verify this output.",
  })
  await expect(
    approveWorkflowReview({ accountId: "acct_a", reviewId: review.id, actor: reviewer })
  ).resolves.toMatchObject({ status: "in-review", approvals: [{ subjectId: "reviewer" }] })
  await resolveContextComment(comment.id, "owner")
  await expect(
    approveWorkflowReview({ accountId: "acct_a", reviewId: review.id, actor: reviewer })
  ).resolves.toMatchObject({ status: "approved" })
  await expect(
    assertWorkflowReviewGate({
      accountId: "acct_a",
      workflowId: "workflow_1",
      versionId: "version_1",
      policy: {
        enabled: true,
        requiredApprovals: 1,
        reviewerSubjectIds: [],
        reviewerGroupIds: ["security"],
        requireNoBlockingComments: true,
      },
    })
  ).resolves.toMatchObject({ id: review.id })
})

it("supersedes an open review when a newer immutable review is created", async () => {
  const first = await createWorkflowReview({
    accountId: "acct_a",
    workflowId: "workflow_1",
    versionId: "version_1",
    actor: owner,
  })
  const second = await createWorkflowReview({
    accountId: "acct_a",
    workflowId: "workflow_1",
    versionId: "version_1",
    actor: owner,
  })
  await expect(getDb().workflowReviews.get(first.id)).resolves.toMatchObject({
    status: "superseded",
    supersededByReviewId: second.id,
  })
})

it("previews independent edits and reports same-path three-way conflicts", async () => {
  const base = workflow()
  const suggested = workflow({ name: "Suggested name" })
  const current = workflow({ description: "Current description" })
  expect(previewWorkflowSuggestionMerge(base, suggested, current)).toMatchObject({
    conflicts: [],
    merged: { name: "Suggested name", description: "Current description" },
  })
  expect(
    previewWorkflowSuggestionMerge(
      base,
      workflow({ name: "Suggested name" }),
      workflow({ name: "Current name" })
    ).conflicts
  ).toEqual(["/name"])

  const review = await createWorkflowReview({
    accountId: "acct_a",
    workflowId: "workflow_1",
    versionId: "version_1",
    actor: owner,
    reviewerGroupIds: ["security"],
  })
  const stored = await createWorkflowReviewSuggestion({
    accountId: "acct_a",
    reviewId: review.id,
    actor: reviewer,
    suggested,
  })
  await expect(
    previewStoredWorkflowSuggestion({
      accountId: "acct_a",
      suggestionId: stored.id,
      current,
    })
  ).resolves.toMatchObject({ conflicts: [], merged: { name: "Suggested name" } })

  await expect(
    applyStoredWorkflowSuggestion({
      accountId: "acct_a",
      suggestionId: stored.id,
      actor: owner,
      current: workflow({ name: "Current name", description: "Keep this" }),
      resolutions: {},
      now: 10,
    })
  ).rejects.toMatchObject({ code: "merge_conflict" })
  await expect(getDb().workflowReviewSuggestions.get(stored.id)).resolves.toMatchObject({
    status: "conflicted",
    conflictPaths: ["/name"],
  })

  await expect(
    applyStoredWorkflowSuggestion({
      accountId: "acct_a",
      suggestionId: stored.id,
      actor: owner,
      current: workflow({ name: "Current name", description: "Keep this" }),
      resolutions: { "/name": "suggested" },
      now: 11,
    })
  ).resolves.toMatchObject({
    conflicts: [],
    merged: { name: "Suggested name", description: "Keep this" },
  })
  await expect(getDb().workflowReviewSuggestions.get(stored.id)).resolves.toMatchObject({
    status: "applied",
    appliedAt: 11,
  })

  const rejected = await createWorkflowReviewSuggestion({
    accountId: "acct_a",
    reviewId: review.id,
    actor: reviewer,
    suggested: workflow({ name: "Reject this" }),
  })
  await expect(
    rejectStoredWorkflowSuggestion({
      accountId: "acct_a",
      suggestionId: rejected.id,
      actor: owner,
      now: 12,
    })
  ).resolves.toMatchObject({ status: "rejected", updatedAt: 12 })
})
