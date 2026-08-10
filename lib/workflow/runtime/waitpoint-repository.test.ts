jest.mock("@/lib/db/seed", () => ({ seedBuiltIns: jest.fn().mockResolvedValue(undefined) }))

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createWorkflowWaitpoint, decideWorkflowWaitpoint } from "@/lib/db/workflow-waitpoints"
import { waitForWorkflowWaitpoint } from "./waitpoint-repository"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().workflowWaitpoints.clear()
})
afterAll(dbFixture.dispose)

function createPending(id: string, expiresAt?: number) {
  const now = Date.now()
  return createWorkflowWaitpoint({
    id,
    kind: "approval",
    status: "pending",
    runId: "run_1",
    workflowId: "wf_1",
    stepId: "step_1",
    key: `approval:${id}`,
    createdAt: now,
    notBefore: now,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    updatedAt: now,
  })
}

describe("waitForWorkflowWaitpoint", () => {
  it("rejects when the durable row does not exist", async () => {
    await expect(waitForWorkflowWaitpoint("wp_missing")).rejects.toThrow(
      "workflow waitpoint not found: wp_missing"
    )
  })

  it("returns a decision already persisted before the executor resumes", async () => {
    await createPending("wp_decided")
    await decideWorkflowWaitpoint("wp_decided", {
      outcome: "approved",
      respondedBy: "device:a",
      resolvedAt: Date.now(),
    })

    await expect(waitForWorkflowWaitpoint("wp_decided")).resolves.toMatchObject({
      status: "resolved",
      resolution: { outcome: "approved", respondedBy: "device:a" },
    })
  })

  it("uses the original absolute deadline after restart", async () => {
    await createPending("wp_expired", Date.now() - 1)
    await expect(waitForWorkflowWaitpoint("wp_expired")).resolves.toMatchObject({
      status: "timed_out",
      resolution: { outcome: "timed_out" },
    })
  })

  it("refreshes the winner when two resumed executors race the same timeout", async () => {
    await createPending("wp_expired_race", Date.now() - 1)

    const [first, second] = await Promise.all([
      waitForWorkflowWaitpoint("wp_expired_race"),
      waitForWorkflowWaitpoint("wp_expired_race"),
    ])

    expect(first).toMatchObject({ status: "timed_out" })
    expect(second).toMatchObject({ status: "timed_out" })
  })

  it("observes the first concurrent device decision", async () => {
    await createPending("wp_live")
    const waiting = waitForWorkflowWaitpoint("wp_live", { pollIntervalMs: 10 })
    await decideWorkflowWaitpoint("wp_live", {
      outcome: "rejected",
      respondedBy: "device:b",
      resolvedAt: Date.now(),
    })
    await expect(waiting).resolves.toMatchObject({
      status: "rejected",
      resolution: { outcome: "rejected" },
    })
  })

  it("uses a future absolute deadline without resetting the timeout budget", async () => {
    await createPending("wp_future_timeout", Date.now() + 30)

    await expect(
      waitForWorkflowWaitpoint("wp_future_timeout", { pollIntervalMs: 10 })
    ).resolves.toMatchObject({
      status: "timed_out",
      resolution: { outcome: "timed_out", respondedBy: "timeout" },
    })
  })

  it("rejects an aborted wait without mutating the durable checkpoint", async () => {
    await createPending("wp_abort")
    const controller = new AbortController()
    const waiting = waitForWorkflowWaitpoint("wp_abort", {
      signal: controller.signal,
      pollIntervalMs: 10,
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()

    await expect(waiting).rejects.toThrow("workflow waitpoint: aborted")
    await expect(getDb().workflowWaitpoints.get("wp_abort")).resolves.toMatchObject({
      status: "pending",
    })
  })

  it("durably cancels a checkpoint when its owning run is aborted", async () => {
    await createPending("wp_cancel")
    const controller = new AbortController()
    const waiting = waitForWorkflowWaitpoint("wp_cancel", {
      signal: controller.signal,
      cancelOnAbort: true,
      pollIntervalMs: 10,
    })

    controller.abort()

    await expect(waiting).resolves.toMatchObject({
      status: "cancelled",
      resolution: { outcome: "cancelled", respondedBy: "run-cancelled" },
    })
  })

  it("rejects if the durable row disappears while a renderer is waiting", async () => {
    await createPending("wp_removed")
    const waiting = waitForWorkflowWaitpoint("wp_removed", { pollIntervalMs: 10 })

    await new Promise((resolve) => setTimeout(resolve, 10))
    await getDb().workflowWaitpoints.delete("wp_removed")

    await expect(waiting).rejects.toThrow("workflow waitpoint not found: wp_removed")
  })

  it("polls a terminal decision written without an in-process notification", async () => {
    await createPending("wp_polled")
    const waiting = waitForWorkflowWaitpoint("wp_polled", { pollIntervalMs: 10 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const current = (await getDb().workflowWaitpoints.get("wp_polled"))!
    await getDb().workflowWaitpoints.put({
      ...current,
      status: "resolved",
      resolution: { outcome: "approved", respondedBy: "native", resolvedAt: Date.now() },
      updatedAt: Date.now(),
    })

    await expect(waiting).resolves.toMatchObject({
      status: "resolved",
      resolution: { outcome: "approved", respondedBy: "native" },
    })
  })

  it("surfaces a repository failure observed by the recovery poll", async () => {
    await createPending("wp_db_closed")
    const waiting = waitForWorkflowWaitpoint("wp_db_closed", { pollIntervalMs: 10 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    getDb().close()

    try {
      await expect(waiting).rejects.toThrow()
    } finally {
      await getDb().open()
    }
  })

  it("surfaces a repository failure while durably committing a timeout", async () => {
    await createPending("wp_timeout_db_closed", Date.now() + 40)
    const waiting = waitForWorkflowWaitpoint("wp_timeout_db_closed", { pollIntervalMs: 1_000 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    getDb().close()

    try {
      await expect(waiting).rejects.toThrow()
    } finally {
      await getDb().open()
    }
  })
})
