import { fixture, TRIGGER } from "./comment-bot.test-helpers"
import type { CommandSourceV1 } from "./command-source"
import { startTracking, trackingKey, updateTracking, type TrackingRecord } from "./tracking"

const source = {
  repository: "acme/widgets",
  threadKind: "issue",
  threadNumber: 7,
} as CommandSourceV1
const input = {
  source,
  resourceId: "acme/widgets#7:issue_comment:11",
  eventId: "gh-cmd:1:issue_comment:11:r",
  ref: "0a1b2c3d",
  rev: "deadbeef",
  trigger: TRIGGER,
}

it("creates one marked tracking comment in automatic mode and remembers it", async () => {
  const f = fixture()
  const record = await startTracking(f.context, f.run, f.config, input)
  expect(record).toMatchObject({
    commentId: 5001,
    markerId: "t-0a1b2c3d-deadbeef",
    phase: "running",
  })
  const call = f.mocks.action.mock.calls[0][0] as {
    actionId: string
    input: Record<string, string>
  }
  expect(call.actionId).toBe("commentIssue")
  expect(call.input.body).toContain("Task `0a1b2c3d`: working on it.")
  expect(call.input.body).toContain("<!-- cognia-command:v1:t-0a1b2c3d-deadbeef -->")
  expect(call.input.marker).toBe("<!-- cognia-command:v1:t-0a1b2c3d-deadbeef -->")
  // A replay finds the record instead of writing again.
  await startTracking(f.context, f.run, f.config, input)
  expect(f.mocks.action).toHaveBeenCalledTimes(1)
})

it("never posts progress in approval mode", async () => {
  const f = fixture({ config: { publicationMode: "approval" } })
  await expect(startTracking(f.context, f.run, f.config, input)).resolves.toBeUndefined()
  expect(f.mocks.approval).not.toHaveBeenCalled()
})

it("moves forward only, edits by marker, and never fails the answer over a tracking edit", async () => {
  const f = fixture()
  await startTracking(f.context, f.run, f.config, input)
  const update = (kind: "completed" | "failed", step: string) =>
    updateTracking(f.context, f.run, f.config, {
      resourceId: input.resourceId,
      phase: { kind } as never,
      step,
      idempotencyKey: `k-${step}`,
      trigger: TRIGGER,
    })
  f.mocks.action.mockRejectedValueOnce(new Error("GitHub down"))
  await expect(update("completed", "s1")).resolves.toBeUndefined()
  expect(f.run.log).toHaveBeenCalledWith(
    "warn",
    "Tracking comment update failed",
    expect.anything()
  )
  await update("completed", "s2")
  const edit = f.mocks.action.mock.calls.at(-1)![0] as {
    actionId: string
    input: Record<string, unknown>
  }
  expect(edit).toMatchObject({
    actionId: "updateComment",
    input: {
      commentId: 5001,
      kind: "issue",
      marker: "<!-- cognia-command:v1:t-0a1b2c3d-deadbeef -->",
    },
  })
  const calls = f.mocks.action.mock.calls.length
  await update("failed", "s3")
  expect(f.mocks.action.mock.calls.length).toBe(calls)
  const record = await f.context.storage.get<TrackingRecord>(
    trackingKey("install", input.resourceId)
  )
  expect(record?.phase).toBe("completed")
})

it("lets a retried run resume a failed comment and finish it, writing each failure afresh", async () => {
  const f = fixture()
  await startTracking(f.context, f.run, f.config, input)
  const update = (kind: "completed" | "failed", step: string) =>
    updateTracking(f.context, f.run, f.config, {
      resourceId: input.resourceId,
      phase: { kind } as never,
      step,
      idempotencyKey: `k-${step}`,
      trigger: TRIGGER,
    })
  const bodies = () =>
    f.mocks.action.mock.calls.map(
      (call) => (call[0] as { input: { body?: string } }).input.body ?? ""
    )
  const record = () =>
    f.context.storage.get<TrackingRecord>(trackingKey("install", input.resourceId))

  await update("failed", "tracking-failed")
  expect(await record()).toMatchObject({ phase: "failed", failures: 1 })
  // The host retries the run: the comment says it is working again.
  await startTracking(f.context, f.run, f.config, input)
  expect(bodies().at(-1)).toContain("working on it")
  expect(await record()).toMatchObject({ phase: "running", failures: 1 })
  // A second failure is its own step, so it is written rather than replayed.
  await update("failed", "tracking-failed")
  expect(bodies().at(-1)).toContain("failed")
  expect(await record()).toMatchObject({ phase: "failed", failures: 2 })
  await startTracking(f.context, f.run, f.config, input)
  await update("completed", "tracking-completed")
  expect(bodies().at(-1)).toContain("answered")
  expect(await record()).toMatchObject({ phase: "completed" })
  const steps = f.mocks.action.mock.calls.map(
    (call) => (call[0] as unknown as { idempotencyKey: string }).idempotencyKey
  )
  expect(new Set(steps).size).toBe(steps.length)
})

it("lets the host park a run waiting for a tracking decision", async () => {
  const f = fixture()
  await startTracking(f.context, f.run, f.config, input)
  f.mocks.approval.mockRejectedValueOnce(
    Object.assign(new Error("parked"), { name: "BotRunParkedError" })
  )
  await expect(
    updateTracking(f.context, f.run, f.config, {
      resourceId: input.resourceId,
      phase: { kind: "completed" },
      step: "park",
      idempotencyKey: "k",
      trigger: TRIGGER,
    })
  ).rejects.toThrow("parked")
})
