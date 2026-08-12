/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { putRunRetrospectiveBundle } from "@/lib/db/run-retrospectives"
import {
  approveRunLearningProposal,
  rejectRunLearningProposal,
  retryRunLearningProposal,
} from "./run-learning-materializer"

async function seed(proposalId: string) {
  await putRunRetrospectiveBundle({
    retrospective: {
      id: `retro-${proposalId}`,
      runId: "run-1",
      runKey: `run-1:${proposalId}`,
      analysisVersion: 1,
      status: "pending_review",
      issueTimeline: [],
      contentHash: "a".repeat(64),
      createdAt: 1,
      updatedAt: 1,
    },
    proposals: [
      {
        id: proposalId,
        retrospectiveId: `retro-${proposalId}`,
        runId: "run-1",
        targetKind: "memory-candidate",
        title: "Sensitive proposal title",
        after: "Sensitive proposal body",
        status: "pending",
        evidenceRefs: [{ namespace: "cognia", type: "run-event", id: "event-1" }],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  })
}

describe("run learning materializer", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("records content-free approval governance and an idempotent effect", async () => {
    await seed("proposal-apply")
    const apply = jest.fn(async () => ({
      namespace: "cognia",
      type: "memory",
      id: "memory-1",
    }))

    const applied = await approveRunLearningProposal("proposal-apply", { apply, now: () => 10 })
    expect(applied).toMatchObject({ status: "applied", effectRef: { id: "memory-1" } })
    const duplicate = await approveRunLearningProposal("proposal-apply", {
      apply,
      now: () => 20,
    })
    expect(duplicate).toEqual(applied)
    expect(apply).toHaveBeenCalledTimes(1)

    const decision = await getDb().governanceDecisions.get("run-learning:proposal-apply")
    expect(decision).toMatchObject({ kind: "human-approval", state: "executed" })
    expect(JSON.stringify(decision)).not.toContain("Sensitive proposal")
    expect(await getDb().governanceLineage.get("run-learning-effect:proposal-apply")).toMatchObject(
      {
        to: { id: "memory-1" },
        relation: "resulted-in",
      }
    )
  })

  it("keeps failed applications retryable without repeating approval", async () => {
    await seed("proposal-retry")
    const apply = jest
      .fn()
      .mockRejectedValueOnce(new Error("Failed for jane@example.com"))
      .mockResolvedValueOnce({ namespace: "cognia", type: "skill", id: "skill-1" })

    const failed = await approveRunLearningProposal("proposal-retry", { apply, now: () => 10 })
    expect(failed).toMatchObject({
      status: "apply_failed",
      applyError: expect.stringContaining("<EMAIL_001>"),
    })
    const applied = await retryRunLearningProposal("proposal-retry", { apply, now: () => 20 })
    expect(applied).toMatchObject({ status: "applied", effectRef: { id: "skill-1" } })
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it("rejects without invoking an effect adapter", async () => {
    await seed("proposal-reject")
    const rejected = await rejectRunLearningProposal("proposal-reject", 10)
    expect(rejected.status).toBe("rejected")
  })
})
