/** @jest-environment jsdom */
import "fake-indexeddb/auto"

jest.mock("@/lib/db/seed", () => ({ seedBuiltIns: jest.fn().mockResolvedValue(undefined) }))
jest.mock("@/lib/workflow/runtime/tauri-bridge", () => ({
  createNativeWorkflowWaitpoint: jest.fn().mockResolvedValue(null),
  decideNativeWorkflowWaitpoint: jest.fn().mockResolvedValue(undefined),
  getNativeWorkflowWaitpoint: jest.fn().mockResolvedValue(null),
  listNativePendingWorkflowWaitpoints: jest.fn().mockResolvedValue(null),
  persistNativeWorkflowWaitEvent: jest.fn().mockResolvedValue(undefined),
  pruneNativeWorkflowWaitEvents: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/db/action-review-receipts", () => ({
  ACTION_REVIEW_RETENTION_DAYS: 30,
  recordActionReviewReceipt: jest.fn().mockResolvedValue(undefined),
}))

const notifyRequested = jest.fn(async (..._args: unknown[]) => undefined)
const notifyResolved = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/workflow/runtime/human-input-notify", () => ({
  notifyHumanInputRequested: (...args: unknown[]) => notifyRequested(...args),
  notifyHumanInputResolved: (...args: unknown[]) => notifyResolved(...args),
}))

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { getHumanInputRequest, submitHumanInput } from "@/lib/db/workflow-human-input"
import type { StepExecutionContext } from "@/types/workflow/visual"
import { runHumanInputRequest } from "./human-input"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().workflowWaitpoints.clear()
  await getDb().workflowHumanInputRequests.clear()
  await getDb().workflowHumanInputSubmissions.clear()
  jest.clearAllMocks()
})
afterAll(dbFixture.dispose)

const params = {
  title: "Release decision",
  fields: [{ id: "note", type: "long-text", label: "Note", required: true }],
  actions: [
    { id: "ship", label: "Ship" },
    { id: "revise", label: "Revise" },
  ],
  assignees: [{ kind: "member", id: "alice" }],
  completionPolicy: { mode: "any" },
}

function context(
  overrides: Record<string, unknown> = {},
  signal = new AbortController().signal
): StepExecutionContext {
  return {
    runId: "run_hir",
    workflowId: "wf_hir",
    stepId: "ask",
    params: { ...params, ...overrides },
    upstream: {},
    trigger: { workflowId: "wf_hir", kind: "trigger.manual", payload: {}, originAt: 0 },
    signal,
    log: jest.fn(),
    resolveSecret: async () => undefined,
  } as unknown as StepExecutionContext
}

async function waitForRequest() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const request = await getHumanInputRequest("hir_run_hir_ask")
    if (request) return request
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Human Input request was not persisted")
}

async function waitForNotification() {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (notifyRequested.mock.calls.length > 0) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Human Input notification was not emitted")
}

describe("runHumanInputRequest", () => {
  it("persists, notifies, waits, and routes through the selected stable action handle", async () => {
    const running = runHumanInputRequest(context())
    const request = await waitForRequest()
    await waitForNotification()
    expect(request.expiresAt - request.createdAt).toBe(3 * 24 * 60 * 60 * 1000)
    expect(notifyRequested).toHaveBeenCalledWith(expect.objectContaining({ id: request.id }))

    await submitHumanInput({
      requestId: request.id,
      actor: { id: "alice" },
      actionId: "ship",
      values: { note: "Ready" },
      now: request.createdAt + 10,
    })

    await expect(running).resolves.toMatchObject({
      decision: "ship",
      output: {
        requestId: request.id,
        actionId: "ship",
        values: { note: "Ready" },
        respondedBy: "alice",
      },
    })
    expect(notifyResolved).toHaveBeenCalledWith(expect.anything(), "completed")
  })

  it("does not re-notify when a persisted request is resumed", async () => {
    const first = runHumanInputRequest(context())
    const request = await waitForRequest()
    await waitForNotification()
    const resumed = runHumanInputRequest(context())
    expect(notifyRequested).toHaveBeenCalledTimes(1)
    await submitHumanInput({
      requestId: request.id,
      actor: { id: "alice" },
      actionId: "revise",
      values: { note: "Needs work" },
    })
    await expect(first).resolves.toMatchObject({ decision: "revise" })
    await expect(resumed).resolves.toMatchObject({ decision: "revise" })
  })

  it("cancels the durable request when the run is aborted", async () => {
    const controller = new AbortController()
    const running = runHumanInputRequest(context({}, controller.signal))
    const request = await waitForRequest()
    controller.abort()
    await expect(running).rejects.toThrow("cancelled")
    await expect(getHumanInputRequest(request.id)).resolves.toMatchObject({ status: "cancelled" })
  })

  it("supports an action-only request with no data fields", async () => {
    const controller = new AbortController()
    const running = runHumanInputRequest(context({ fields: [] }, controller.signal))
    const request = await waitForRequest()
    expect(request.fields).toEqual([])
    controller.abort()
    await expect(running).rejects.toThrow("cancelled")
  })

  it("freezes an anonymous Portal subject as the initiator assignee", async () => {
    await getDb().workflowRuns.put({
      id: "run_hir",
      workflowId: "wf_hir",
      versionId: "version_1",
      status: "running",
      triggerKind: "trigger.manual",
      triggerPayload: {},
      triggeredBy: {
        source: "api",
        initiator: { authenticated: false, externalSubjectKey: "anonymous:portal-1" },
      },
      startedAt: Date.now(),
      workflowSnapshot: { id: "wf_hir", nodes: [], edges: [] },
    } as never)
    const controller = new AbortController()
    const running = runHumanInputRequest(
      context({ assignees: [{ kind: "initiator" }] }, controller.signal)
    )
    const request = await waitForRequest()
    expect(request.initiatorId).toBe("anonymous:portal-1")
    controller.abort()
    await expect(running).rejects.toThrow("cancelled")
  })

  it("rejects incomplete runtime params even if an unvalidated caller bypasses authoring", async () => {
    await expect(runHumanInputRequest(context({ fields: undefined }))).rejects.toThrow(
      "params.fields is required"
    )
    await expect(runHumanInputRequest(context({ actions: [] }))).rejects.toThrow(
      "params.actions is required"
    )
    await expect(runHumanInputRequest(context({ assignees: [] }))).rejects.toThrow(
      "params.assignees is required"
    )
  })
})
