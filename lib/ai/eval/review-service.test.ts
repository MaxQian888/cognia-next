/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import {
  adjudicateEvalReview,
  createEvalReviewService,
  buildBlindReviewPairs,
  createBlindReviewBatch,
  createEvalReviewBundle,
  importEvalReviewBundle,
  openBlindReviewBatch,
  reviewAgreement,
} from "./review-service"

const refreshRecommendation = jest.fn(async () => {})
jest.mock("./finalization", () => ({
  refreshEvalRecommendationAfterReview: (...args: unknown[]) =>
    refreshRecommendation(...(args as [])),
}))

function reviewCases() {
  return ["a", "b", "c"].map((variantId) => ({
    case: {
      id: "case-1",
      datasetId: "dataset",
      input: "Question",
      capability: "chat.qa",
      source: "handwritten",
      createdAt: 1,
      updatedAt: 1,
    },
    sample: {
      output: variantId,
      latencyMs: 1,
      costUsd: 0,
      toolCalls: [],
      retrievedChunks: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stepCount: 0,
      degraded: false,
    },
    variantId,
    repetition: 1,
    sampleId: `sample-${variantId}`,
    taskId: `task-${variantId}`,
    scores: [],
    status: "passed",
  })) as import("./report-view").EvalReportCaseEvidence[]
}

describe("blind multi-reviewer evaluation", () => {
  beforeEach(async () => {
    refreshRecommendation.mockReset().mockResolvedValue(undefined)
    await getDb().delete()
    __resetDbForTesting()
    getDb()
    await whenSeeded()
    await getDb().evalReviewBatches.clear()
    await getDb().evalReviewVotes.clear()
    await getDb().evalAdjudications.clear()
  }, 30_000)

  it("encrypts assignments/mapping, exports portable work, merges votes, and adjudicates", async () => {
    const artifactKey = crypto.getRandomValues(new Uint8Array(32))
    const batch = await createBlindReviewBatch({
      experimentId: "experiment",
      seed: 42,
      artifactKey,
      pairs: [
        {
          pairId: "case-1",
          first: { variantId: "a", sampleId: "a-1", output: "alpha" },
          second: { variantId: "b", sampleId: "b-1", output: "beta" },
        },
      ],
    })

    expect(batch).not.toHaveProperty("publicAssignments")
    expect(batch.encryptedAssignments?.ciphertext).not.toContain("alpha")
    const opened = await openBlindReviewBatch(batch.id, artifactKey)
    expect(opened.assignments[0]).not.toHaveProperty("variantId")

    const bundle = await createEvalReviewBundle(
      batch.id,
      artifactKey,
      [
        {
          id: "vote-1",
          batchId: batch.id,
          experimentId: "experiment",
          pairId: "case-1",
          reviewerId: "reviewer-a",
          preference: "a",
          rubric: { correctness: 1 },
          createdAt: 10,
        },
      ],
      "bundle-password"
    )
    expect(JSON.stringify(bundle)).not.toContain("alpha")
    await expect(importEvalReviewBundle(bundle, "wrong-password")).rejects.toThrow()
    await expect(importEvalReviewBundle(bundle, "bundle-password")).resolves.toBe(1)
    await expect(importEvalReviewBundle(bundle, "bundle-password")).resolves.toBe(0)

    await adjudicateEvalReview({
      batchId: batch.id,
      pairId: "case-1",
      adjudicatorId: "lead",
      decision: "a",
      reasoning: "reference-aligned",
      artifactKey,
    })
    expect(await getDb().evalAdjudications.count()).toBe(1)
  })

  it("reports agreement only across comparable non-abstaining reviewer votes", () => {
    expect(
      reviewAgreement([
        { pairId: "p1", reviewerId: "a", preference: "a" },
        { pairId: "p1", reviewerId: "b", preference: "a" },
        { pairId: "p2", reviewerId: "a", preference: "a" },
        { pairId: "p2", reviewerId: "b", preference: "b" },
        { pairId: "p3", reviewerId: "a", preference: "abstain" },
      ])
    ).toEqual({ eligiblePairs: 2, agreedPairs: 1, agreementRate: 0.5 })
  })
  it("builds all variant pairs in the application service", () => {
    expect(buildBlindReviewPairs(reviewCases()).map((pair) => pair.pairId)).toEqual([
      "case-1:1:a:b",
      "case-1:1:a:c",
      "case-1:1:b:c",
    ])
  })

  it("reuses a batch on retries/concurrent opens and restores its public snapshot", async () => {
    const service = createEvalReviewService({
      artifactKey: crypto.getRandomValues(new Uint8Array(32)),
      assertActive: () => {},
    })
    const input = { experimentId: "experiment", cases: reviewCases(), seed: 42 }
    const [first, second] = await Promise.all([service.open(input), service.open(input)])
    expect(first.batchId).toBe(second.batchId)
    expect(await getDb().evalReviewBatches.count()).toBe(1)
    await expect(service.load({ experimentId: "experiment" })).resolves.toEqual(first)
    expect(first).not.toHaveProperty("privateMapping")
    await expect(service.load({ experimentId: "other" })).resolves.toBeNull()
  })

  it("keeps a saved vote retryable after recommendation failure without duplicate rows", async () => {
    const service = createEvalReviewService({
      artifactKey: crypto.getRandomValues(new Uint8Array(32)),
      assertActive: () => {},
    })
    const opened = await service.open({
      experimentId: "experiment",
      cases: reviewCases(),
      seed: 42,
    })
    const input = {
      experimentId: "experiment",
      batchId: opened.batchId,
      pairId: opened.assignments[0].pairId,
      reviewerId: " reviewer ",
      preference: "a" as const,
    }
    refreshRecommendation.mockRejectedValueOnce(new Error("refresh offline"))
    const saved = await service.vote(input)
    expect(saved.recommendation).toEqual({ status: "pending", message: "refresh offline" })
    // The persisted marker does not depend on the UI retaining its promise.
    expect(await getDb().evalReviewBatches.get(opened.batchId)).toMatchObject({ reviewRevision: 1 })
    await expect(service.load({ experimentId: "experiment" })).resolves.toMatchObject({
      recommendationPending: true,
    })
    expect(saved.snapshot.votes).toEqual([
      expect.objectContaining({ reviewerId: "reviewer", preference: "a" }),
    ])
    await expect(service.refreshRecommendation(input)).resolves.toMatchObject({
      recommendation: { status: "updated" },
    })
    await expect(service.load({ experimentId: "experiment" })).resolves.toMatchObject({
      recommendationPending: false,
    })
    await Promise.all([service.vote(input), service.vote(input)])
    expect(await getDb().evalReviewVotes.count()).toBe(1)
    await service.vote({ ...input, preference: "b" })
    expect(await getDb().evalReviewVotes.count()).toBe(1)
    expect((await getDb().evalReviewVotes.toArray())[0].preference).toBe("b")
  })

  it("opens a current batch when matching historical assignments were superseded", async () => {
    const service = createEvalReviewService({
      artifactKey: crypto.getRandomValues(new Uint8Array(32)),
      assertActive: () => {},
    })
    const input = { experimentId: "experiment", cases: reviewCases(), seed: 42 }
    const first = await service.open(input)
    await service.open({ ...input, cases: reviewCases().slice(0, 2) })
    const reopened = await service.open(input)
    expect(reopened.batchId).not.toBe(first.batchId)
    await expect(service.load({ experimentId: "experiment" })).resolves.toEqual(reopened)
  })

  it("does not clear a later review revision when an older refresh completes", async () => {
    const service = createEvalReviewService({
      artifactKey: crypto.getRandomValues(new Uint8Array(32)),
      assertActive: () => {},
    })
    const opened = await service.open({
      experimentId: "experiment",
      cases: reviewCases(),
      seed: 42,
    })
    const input = {
      experimentId: "experiment",
      batchId: opened.batchId,
      pairId: opened.assignments[0].pairId,
      reviewerId: "first",
      preference: "a" as const,
    }
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    refreshRecommendation.mockImplementationOnce(async () => {
      started()
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    const first = service.vote(input)
    await entered
    refreshRecommendation.mockRejectedValueOnce(new Error("new refresh failed"))
    await service.vote({ ...input, reviewerId: "second" })
    release()
    await expect(first).resolves.toMatchObject({ recommendation: { status: "pending" } })
    const batch = await getDb().evalReviewBatches.get(opened.batchId)
    expect(batch?.reviewRevision).toBe(2)
    expect(batch?.recommendationRevision ?? 0).toBe(0)
    await expect(service.load({ experimentId: "experiment" })).resolves.toMatchObject({
      recommendationPending: true,
    })
  })

  it("keeps retry status pending when a new vote lands after refresh commits but before its snapshot", async () => {
    const service = createEvalReviewService({
      artifactKey: crypto.getRandomValues(new Uint8Array(32)),
      assertActive: () => {},
    })
    const opened = await service.open({
      experimentId: "experiment",
      cases: reviewCases(),
      seed: 42,
    })
    const input = {
      experimentId: "experiment",
      batchId: opened.batchId,
      pairId: opened.assignments[0].pairId,
      reviewerId: "first",
      preference: "a" as const,
    }
    let release!: () => void
    let enter!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const table = getDb().evalReviewBatches
    const originalGet = table.get.bind(table)
    let held = false
    const get = jest.spyOn(table, "get").mockImplementation((key) =>
      originalGet(key).then(async (row) => {
        if (!held && row?.reviewRevision === 1 && row.recommendationRevision === 1) {
          held = true
          enter()
          await paused
        }
        return row
      })
    )
    try {
      const first = service.vote(input)
      await entered
      // A second window persists a vote after the first refresh's revision transaction.
      refreshRecommendation.mockRejectedValueOnce(new Error("new refresh offline"))
      await service.vote({ ...input, reviewerId: "second" })
      release()
      await expect(first).resolves.toMatchObject({
        snapshot: {
          recommendationPending: true,
          votes: expect.arrayContaining([expect.objectContaining({ reviewerId: "second" })]),
        },
        recommendation: { status: "pending" },
      })
    } finally {
      release()
      get.mockRestore()
    }
  })

  it("validates batch/pair identity and imports only into the selected batch", async () => {
    const service = createEvalReviewService({
      artifactKey: crypto.getRandomValues(new Uint8Array(32)),
      assertActive: () => {},
    })
    const opened = await service.open({
      experimentId: "experiment",
      cases: reviewCases(),
      seed: 42,
    })
    const vote = {
      experimentId: "experiment",
      batchId: opened.batchId,
      pairId: opened.assignments[0].pairId,
      reviewerId: "r",
      preference: "a" as const,
    }
    await expect(service.vote({ ...vote, experimentId: "other" })).rejects.toThrow(
      "selected experiment"
    )
    await expect(service.vote({ ...vote, pairId: "unknown" })).rejects.toThrow("pair")
    await service.vote(vote)
    const text = await service.exportBundle({ ...vote, password: "secret" })
    await service.importBundle({ ...vote, text, password: "secret" })
    expect(await getDb().evalReviewVotes.count()).toBe(1)
    const other = await service.open({ experimentId: "other", cases: reviewCases(), seed: 42 })
    await expect(
      service.importBundle({
        experimentId: "other",
        batchId: other.batchId,
        text,
        password: "secret",
      })
    ).rejects.toThrow("selected evaluation batch")
    await expect(service.exportBundle({ ...vote, password: "" })).rejects.toThrow("password")
    await expect(
      service.importBundle({ ...vote, text: "{bad", password: "secret" })
    ).rejects.toThrow()
  })

  it("does not duplicate adjudications on repeated submission", async () => {
    const service = createEvalReviewService({
      artifactKey: crypto.getRandomValues(new Uint8Array(32)),
      assertActive: () => {},
    })
    const opened = await service.open({
      experimentId: "experiment",
      cases: reviewCases(),
      seed: 42,
    })
    const input = {
      experimentId: "experiment",
      batchId: opened.batchId,
      pairId: opened.assignments[0].pairId,
      adjudicatorId: " lead ",
      decision: "a" as const,
      reasoning: "reference-aligned",
    }
    await Promise.all([service.adjudicate(input), service.adjudicate(input)])
    expect(await getDb().evalAdjudications.count()).toBe(1)
    expect((await getDb().evalAdjudications.toArray())[0].adjudicatorId).toBe("lead")
  })

  it("rejects async work after scope invalidation before writing encrypted data", async () => {
    let active = true
    const service = createEvalReviewService({
      artifactKey: crypto.getRandomValues(new Uint8Array(32)),
      assertActive: () => {
        if (!active) throw new Error("scope expired")
      },
    })
    const pending = service.open({ experimentId: "experiment", cases: reviewCases(), seed: 42 })
    active = false
    await expect(pending).rejects.toThrow("scope expired")
    expect(await getDb().evalReviewBatches.count()).toBe(0)
    await expect(service.load({ experimentId: "experiment" })).rejects.toThrow("scope expired")
  })
})
