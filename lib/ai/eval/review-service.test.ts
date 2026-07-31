/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import {
  adjudicateEvalReview,
  createBlindReviewBatch,
  createEvalReviewBundle,
  importEvalReviewBundle,
  openBlindReviewBatch,
  reviewAgreement,
} from "./review-service"

describe("blind multi-reviewer evaluation", () => {
  beforeEach(async () => {
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
})
