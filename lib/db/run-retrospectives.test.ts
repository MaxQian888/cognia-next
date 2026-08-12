/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "./schema"
import {
  getRunRetrospectiveBundleByRun,
  putRunRetrospectiveBundle,
  transitionRunLearningProposal,
} from "./run-retrospectives"
import type { RunRetrospectiveBundle } from "@/types/execution/retrospective"

describe("run retrospective persistence", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("writes a run/version bundle once and transitions proposals idempotently", async () => {
    const bundle: RunRetrospectiveBundle = {
      retrospective: {
        id: "retro-1",
        runId: "run-1",
        runKey: "run-1:1",
        analysisVersion: 1,
        status: "pending_review",
        issueTimeline: [],
        contentHash: "hash",
        createdAt: 1,
        updatedAt: 1,
      },
      proposals: [
        {
          id: "proposal-1",
          retrospectiveId: "retro-1",
          runId: "run-1",
          targetKind: "memory-candidate",
          title: "Remember a safe fact",
          after: "safe",
          status: "pending",
          evidenceRefs: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }

    await expect(putRunRetrospectiveBundle(bundle)).resolves.toEqual(bundle)
    await expect(
      putRunRetrospectiveBundle({
        ...bundle,
        retrospective: { ...bundle.retrospective, id: "retro-duplicate" },
      })
    ).resolves.toEqual(bundle)

    await transitionRunLearningProposal(
      "proposal-1",
      ["pending"],
      { status: "approved_pending_apply" },
      2
    )
    const applied = await transitionRunLearningProposal(
      "proposal-1",
      ["approved_pending_apply", "apply_failed"],
      {
        status: "applied",
        effectRef: { namespace: "cognia", type: "memory", id: "memory-1" },
        resolvedAt: 3,
      },
      3
    )
    expect(applied.effectRef?.id).toBe("memory-1")
    await expect(
      transitionRunLearningProposal("proposal-1", ["approved_pending_apply"], {
        status: "applied",
      })
    ).resolves.toEqual(applied)
    await expect(getRunRetrospectiveBundleByRun("run-1", 1)).resolves.toMatchObject({
      retrospective: { status: "resolved" },
      proposals: [{ status: "applied" }],
    })
  })
})
