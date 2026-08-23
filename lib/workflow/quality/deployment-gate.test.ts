/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { EvalReport } from "@/types/eval/eval"
import type { WorkflowAppDraft } from "@/types/workflow/app"
import { assertWorkflowDeploymentQuality, WorkflowDeploymentQualityError } from "./deployment-gate"

jest.setTimeout(20_000)

const policy: WorkflowAppDraft["qualityGate"] = {
  enabled: true,
  datasetId: "dataset_1",
  thresholds: { minPassAt1: 0.9, maxTotalCostUsd: 1, maxUngradedRatio: 0.1 },
  maxAvgLatencyMs: 2_000,
  maxRunAgeMs: 60_000,
}

function report(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    runId: "eval_1",
    datasetId: "dataset_1",
    datasetVersion: 2,
    targetLabel: "Pinned workflow",
    k: 1,
    caseCount: 10,
    gradedCaseCount: 10,
    ungradedCaseCount: 0,
    scorers: {},
    passAt1: 1,
    passHatK: 1,
    totalCostUsd: 0.5,
    avgLatencyMs: 1_000,
    createdAt: 9_000,
    scoringVersion: 2,
    status: "completed",
    config: {
      targetKind: "workflow",
      targetId: "workflow_1",
      targetVersionId: "version_1",
      scorerIds: [],
      k: 1,
    },
    ...overrides,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  await getDb().evalDatasets.put({
    id: "dataset_1",
    name: "Release gate",
    capability: "workflow",
    version: 2,
    createdAt: 1,
    updatedAt: 1,
  })
})

afterEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

it("accepts only fresh completed evidence for the exact workflow and dataset versions", async () => {
  await getDb().evalRuns.put(report())

  await expect(
    assertWorkflowDeploymentQuality({
      workflowId: "workflow_1",
      versionId: "version_1",
      policy,
      now: 10_000,
    })
  ).resolves.toEqual({
    runId: "eval_1",
    datasetId: "dataset_1",
    datasetVersion: 2,
    evaluatedAt: 10_000,
    failures: [],
  })

  await getDb().evalRuns.put(
    report({
      runId: "eval_wrong",
      config: {
        targetKind: "workflow",
        targetId: "workflow_1",
        targetVersionId: "other",
        scorerIds: [],
        k: 1,
      },
    })
  )
  await getDb().evalRuns.delete("eval_1")
  await expect(
    assertWorkflowDeploymentQuality({
      workflowId: "workflow_1",
      versionId: "version_1",
      policy,
      now: 10_000,
    })
  ).rejects.toBeInstanceOf(WorkflowDeploymentQualityError)
})

it("requires verified admin authority and freezes the override reason", async () => {
  await expect(
    assertWorkflowDeploymentQuality({
      workflowId: "workflow_1",
      versionId: "version_1",
      policy,
      now: 10_000,
      override: { actorSubjectId: "member", isAdmin: false, reason: "Please release this" },
    })
  ).rejects.toMatchObject({ code: "quality_override_denied" })

  await expect(
    assertWorkflowDeploymentQuality({
      workflowId: "workflow_1",
      versionId: "version_1",
      policy,
      now: 10_000,
      override: {
        actorSubjectId: "admin",
        isAdmin: true,
        reason: " Incident mitigation approved ",
      },
    })
  ).resolves.toMatchObject({
    failures: expect.arrayContaining([expect.stringContaining("No completed Eval run")]),
    override: {
      actorSubjectId: "admin",
      reason: "Incident mitigation approved",
      at: 10_000,
    },
  })
})
