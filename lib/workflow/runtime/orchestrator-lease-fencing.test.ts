/**
 * @jest-environment jsdom
 *
 * A run whose lease renewal finds another owner is fenced: it stops at once and
 * leaves the run row to the executor that took it over (ADR-0217 follow-up).
 */
import "fake-indexeddb/auto"

let capturedLeaseLost: (() => void) | undefined
jest.mock("./run-lease", () => {
  const actual = jest.requireActual("./run-lease")
  return {
    ...actual,
    startLeaseHeartbeat: (runId: string, opts: { onLeaseLost?: () => void }) => {
      capturedLeaseLost = opts.onLeaseLost
      return actual.startLeaseHeartbeat(runId, { ...opts, ttlMs: 600_000 })
    },
  }
})
const mockEmitCompletionFanout = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("./workflow-completion-fanout", () => ({
  emitWorkflowCompletedFanout: (...args: unknown[]) => mockEmitCompletionFanout(...args),
}))

import { runWorkflow } from "./orchestrator"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import type { VisualWorkflow } from "@/types/workflow/visual"

jest.setTimeout(30_000)

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().workflowRuns.clear()
  capturedLeaseLost = undefined
  mockEmitCompletionFanout.mockClear()
})
afterAll(dbFixture.dispose)

function waitingWorkflow(): VisualWorkflow {
  return {
    id: "wf_fence",
    schemaVersion: 1,
    name: "Fenced",
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      {
        id: "t",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "start", params: {} },
      },
      {
        id: "wait",
        type: "flow.wait",
        typeVersion: 1,
        position: { x: 0, y: 100 },
        data: { label: "wait", params: { mode: "duration", durationMs: 20_000 } },
      },
    ],
    edges: [{ id: "e", source: "t", target: "wait" }],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
  } as VisualWorkflow
}

describe("runWorkflow lease fencing", () => {
  it("stops a run that lost its lease and leaves the row to the new owner", async () => {
    const pending = runWorkflow({
      workflow: waitingWorkflow(),
      trigger: { workflowId: "wf_fence", kind: "trigger.manual", payload: {}, originAt: 1 },
      runId: "run_fence",
    })
    for (let i = 0; i < 100 && !capturedLeaseLost; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(capturedLeaseLost).toBeDefined()
    // Another executor took the run over and is driving it now.
    await getDb().workflowRuns.update("run_fence", {
      lease: { ownerId: "exec-other", claimedAt: Date.now(), expiresAt: Date.now() + 60_000 },
    })
    capturedLeaseLost!()

    await expect(pending).resolves.toEqual({ runId: "run_fence", status: "running" })
    const row = await getDb().workflowRuns.get("run_fence")
    expect(row?.status).toBe("running")
    expect(row?.lease?.ownerId).toBe("exec-other")
    expect(mockEmitCompletionFanout).not.toHaveBeenCalled()
  })
})
