/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { createDataset } from "@/lib/db/eval-datasets"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  createWorkflowAnnotationRevision,
  createWorkflowAnnotationSet,
  matchWorkflowAnnotation,
  openWorkflowFeedback,
  promoteWorkflowFeedbackToEval,
  publishWorkflowAnnotationRevision,
  reviewWorkflowFeedback,
  submitWorkflowFeedback,
} from "./quality-service"

jest.setTimeout(20_000)

const key = new Uint8Array(32).fill(7)
const deps = {
  loadKey: async () => key,
  embed: async (text: string) =>
    text.toLowerCase().includes("billing")
      ? [0, 1]
      : text.toLowerCase().includes("reset")
        ? [1, 0]
        : [0.7, 0.3],
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

afterEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

it("deduplicates encrypted feedback, requires human confirmation, redacts it, and promotes it to Eval", async () => {
  const submitted = await submitWorkflowFeedback(
    {
      accountId: "acct_a",
      appId: "app_1",
      appReleaseId: "release_1",
      externalSubjectKey: "visitor_1",
      rating: "dislike",
      runId: "run_1",
      payload: {
        input: "Email alice@example.com about the refund",
        output: "No refund",
        correction: "Approve the refund for alice@example.com",
        tags: ["refund", "refund"],
      },
      now: 1_000,
    },
    deps
  )
  await expect(
    submitWorkflowFeedback(
      {
        accountId: "acct_a",
        appId: "app_1",
        appReleaseId: "release_1",
        externalSubjectKey: "visitor_1",
        rating: "dislike",
        runId: "run_1",
        payload: {
          input: "Email alice@example.com about the refund",
          output: "No refund",
          tags: [],
        },
      },
      deps
    )
  ).resolves.toMatchObject({ id: submitted.id })
  await expect(
    promoteWorkflowFeedbackToEval(
      {
        accountId: "acct_a",
        feedbackId: submitted.id,
        datasetId: "missing",
        reviewerSubjectId: "reviewer",
      },
      deps
    )
  ).rejects.toMatchObject({ code: "invalid_transition" })

  await reviewWorkflowFeedback(
    {
      accountId: "acct_a",
      feedbackId: submitted.id,
      reviewerSubjectId: "reviewer",
      decision: "confirm",
      reason: "Useful corrected answer",
    },
    deps
  )
  await expect(openWorkflowFeedback("acct_a", submitted.id, deps)).resolves.toMatchObject({
    payload: {
      input: "Email <EMAIL_001> about the refund",
      correction: "Approve the refund for <EMAIL_001>",
      tags: ["refund"],
    },
  })
  const dataset = await createDataset({ name: "Portal feedback", capability: "chat.qa" })
  const promoted = await promoteWorkflowFeedbackToEval(
    {
      accountId: "acct_a",
      feedbackId: submitted.id,
      datasetId: dataset.id,
      reviewerSubjectId: "reviewer",
    },
    deps
  )
  expect(promoted.feedback.status).toBe("promoted")
  await expect(getDb().evalCases.get(promoted.caseId)).resolves.toMatchObject({
    input: "Email <EMAIL_001> about the refund",
    reference: { expectedOutput: "Approve the refund for <EMAIL_001>" },
    metadata: { workflowFeedbackId: submitted.id, appReleaseId: "release_1" },
  })
})

it("validates, encrypts, atomically publishes, matches, and rolls back annotation revisions", async () => {
  const set = await createWorkflowAnnotationSet({
    accountId: "acct_a",
    appId: "app_1",
    name: "Reviewed support answers",
    createdBy: "owner",
    now: 1_000,
  })
  const first = await createWorkflowAnnotationRevision(
    {
      accountId: "acct_a",
      appId: "app_1",
      setId: set.id,
      createdBy: "owner",
      entries: [
        {
          id: "reset",
          question: "How do I reset my password?",
          answer: "Use the verified reset page.",
          tags: ["account"],
        },
        {
          id: "billing",
          question: "Where is my billing invoice?",
          answer: "Open Billing, then Invoices.",
          tags: ["billing"],
        },
      ],
      embeddingProfileId: "annotation-support",
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      vectorBackend: "native",
      now: 2_000,
    },
    deps
  )
  expect(first.validation).toEqual({ valid: true, errors: [], validatedAt: 2_000 })
  expect(JSON.stringify(first.envelope)).not.toContain("reset my password")
  await publishWorkflowAnnotationRevision({
    accountId: "acct_a",
    setId: set.id,
    revisionId: first.id,
    actorSubjectId: "owner",
    now: 3_000,
  })
  await expect(
    matchWorkflowAnnotation(
      { accountId: "acct_a", revisionId: first.id, query: "reset password", threshold: 0.9 },
      deps
    )
  ).resolves.toMatchObject({
    revisionId: first.id,
    setId: set.id,
    entryId: "reset",
    answer: "Use the verified reset page.",
    score: 1,
  })

  const second = await createWorkflowAnnotationRevision(
    {
      accountId: "acct_a",
      appId: "app_1",
      setId: set.id,
      createdBy: "owner",
      entries: [
        {
          id: "reset",
          question: "How do I reset my password?",
          answer: "Ask an administrator.",
          tags: [],
        },
      ],
      embeddingProfileId: "annotation-support",
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      vectorBackend: "native",
    },
    deps
  )
  await publishWorkflowAnnotationRevision({
    accountId: "acct_a",
    setId: set.id,
    revisionId: second.id,
    actorSubjectId: "owner",
  })
  await publishWorkflowAnnotationRevision({
    accountId: "acct_a",
    setId: set.id,
    revisionId: first.id,
    actorSubjectId: "owner",
  })
  await expect(getDb().workflowAnnotationSets.get(set.id)).resolves.toMatchObject({
    currentRevisionId: first.id,
  })
})
