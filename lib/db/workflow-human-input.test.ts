jest.mock("@/lib/db/seed", () => ({ seedBuiltIns: jest.fn().mockResolvedValue(undefined) }))
jest.mock("@/lib/workflow/runtime/tauri-bridge", () => ({
  createNativeWorkflowWaitpoint: jest.fn().mockResolvedValue(null),
  decideNativeWorkflowWaitpoint: jest.fn().mockResolvedValue(undefined),
  getNativeWorkflowWaitpoint: jest.fn().mockResolvedValue(null),
  listNativePendingWorkflowWaitpoints: jest.fn().mockResolvedValue(null),
  persistNativeWorkflowWaitEvent: jest.fn().mockResolvedValue(undefined),
  pruneNativeWorkflowWaitEvents: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("./action-review-receipts", () => ({
  ACTION_REVIEW_RETENTION_DAYS: 30,
  recordActionReviewReceipt: jest.fn().mockResolvedValue(undefined),
}))

import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import { getWorkflowWaitpoint } from "./workflow-waitpoints"
import {
  getHumanInputRequest,
  listHumanInputSubmissions,
  pruneExpiredHumanInputSensitiveValues,
  registerHumanInputRequest,
  submitHumanInput,
} from "./workflow-human-input"
import type { WorkflowHumanInputRequest } from "@/types/workflow/human-input"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().workflowWaitpoints.clear()
  await getDb().workflowHumanInputRequests.clear()
  await getDb().workflowHumanInputSubmissions.clear()
})
afterAll(dbFixture.dispose)

function request(overrides: Partial<WorkflowHumanInputRequest> = {}): WorkflowHumanInputRequest {
  return {
    id: "hir_run_1_step_1",
    accountId: "account_1",
    waitpointId: "hir_run_1_step_1",
    status: "pending",
    runId: "run_1",
    workflowId: "wf_1",
    stepId: "step_1",
    title: "Choose release",
    fields: [
      { id: "note", type: "short-text", label: "Note", required: true },
      {
        id: "environment",
        type: "single-select",
        label: "Environment",
        options: [
          { value: "staging", label: "Staging" },
          { value: "production", label: "Production" },
        ],
      },
    ],
    actions: [
      { id: "submit", label: "Submit" },
      { id: "cancel", label: "Cancel", tone: "destructive" },
    ],
    assignees: [{ kind: "member", id: "alice" }],
    completionPolicy: { mode: "any" },
    createdAt: 1_000,
    expiresAt: 2_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

describe("workflow Human Input repository", () => {
  it("persists a request and resolves its waitpoint with the submitted action and values", async () => {
    await registerHumanInputRequest(request())

    const result = await submitHumanInput({
      requestId: "hir_run_1_step_1",
      actor: { id: "alice" },
      actionId: "submit",
      values: { note: "Ready", environment: "production" },
      now: 1_500,
    })

    expect(result).toMatchObject({ ok: true, completed: true })
    expect(await getHumanInputRequest("hir_run_1_step_1")).toMatchObject({
      status: "completed",
      finalActionId: "submit",
      completedAt: 1_500,
    })
    expect(await getWorkflowWaitpoint("hir_run_1_step_1")).toMatchObject({
      status: "resolved",
      resolution: {
        outcome: "event",
        respondedBy: "alice",
        data: {
          actionId: "submit",
          submissionIds: ["hir_run_1_step_1:alice"],
        },
      },
    })
  })

  it("enforces frozen assignees, one submission per responder, and field validation", async () => {
    await registerHumanInputRequest(request())

    await expect(
      submitHumanInput({
        requestId: "hir_run_1_step_1",
        actor: { id: "mallory" },
        actionId: "submit",
        values: { note: "No" },
      })
    ).resolves.toMatchObject({ ok: false, reason: "not-assigned" })
    await expect(
      submitHumanInput({
        requestId: "hir_run_1_step_1",
        actor: { id: "alice" },
        actionId: "submit",
        values: {},
      })
    ).resolves.toMatchObject({ ok: false, reason: "invalid-values" })
    await submitHumanInput({
      requestId: "hir_run_1_step_1",
      actor: { id: "alice" },
      actionId: "submit",
      values: { note: "Ready" },
    })
    await expect(
      submitHumanInput({
        requestId: "hir_run_1_step_1",
        actor: { id: "alice" },
        actionId: "cancel",
        values: { note: "Again" },
      })
    ).resolves.toMatchObject({ ok: false, reason: "not-pending" })
  })

  it("keeps a quorum request pending until the threshold-crossing response", async () => {
    await registerHumanInputRequest(
      request({
        assignees: [
          { kind: "member", id: "alice" },
          { kind: "group", id: "reviewers" },
        ],
        completionPolicy: { mode: "quorum", count: 2 },
      })
    )

    await expect(
      submitHumanInput({
        requestId: "hir_run_1_step_1",
        actor: { id: "alice" },
        actionId: "submit",
        values: { note: "A" },
        now: 1_100,
      })
    ).resolves.toMatchObject({ ok: true, completed: false })
    expect((await getWorkflowWaitpoint("hir_run_1_step_1"))?.status).toBe("pending")

    await expect(
      submitHumanInput({
        requestId: "hir_run_1_step_1",
        actor: { id: "bob", groupIds: ["reviewers"] },
        actionId: "cancel",
        values: { note: "B" },
        now: 1_200,
      })
    ).resolves.toMatchObject({ ok: true, completed: true })
    expect(await getHumanInputRequest("hir_run_1_step_1")).toMatchObject({
      finalActionId: "cancel",
    })
  })

  it("encrypts sensitive values, decrypts authorized reads, and prunes ciphertext early", async () => {
    const submittedAt = Date.now()
    const cryptoDeps = { loadKey: async () => new Uint8Array(32).fill(9) }
    await registerHumanInputRequest(
      request({
        fields: [{ id: "secret", type: "short-text", label: "Secret", sensitive: true }],
        sensitiveRetentionDays: 1,
      })
    )

    await submitHumanInput(
      {
        requestId: "hir_run_1_step_1",
        actor: { id: "alice" },
        actionId: "submit",
        values: { secret: "classified" },
        now: submittedAt,
      },
      cryptoDeps
    )

    const stored = await getDb().workflowHumanInputSubmissions.get("hir_run_1_step_1:alice")
    expect(stored?.values).toEqual({ secret: null })
    expect(JSON.stringify(stored)).not.toContain("classified")
    expect(JSON.stringify(await getWorkflowWaitpoint("hir_run_1_step_1"))).not.toContain(
      "classified"
    )
    await expect(
      listHumanInputSubmissions("hir_run_1_step_1", cryptoDeps, submittedAt + 1)
    ).resolves.toMatchObject([{ values: { secret: "classified" } }])

    await expect(
      pruneExpiredHumanInputSensitiveValues(submittedAt + 24 * 60 * 60 * 1000)
    ).resolves.toBe(1)
    expect(
      (await getDb().workflowHumanInputSubmissions.get("hir_run_1_step_1:alice"))
        ?.encryptedSensitiveValues
    ).toBeUndefined()
    await expect(
      listHumanInputSubmissions("hir_run_1_step_1", cryptoDeps, submittedAt + 24 * 60 * 60 * 1000)
    ).resolves.toMatchObject([{ values: { secret: null }, sensitiveValuesExpired: true }])
  })
})
