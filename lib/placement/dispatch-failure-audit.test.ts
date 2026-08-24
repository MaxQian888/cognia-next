jest.mock("@/lib/notifications/runtime", () => ({ notify: jest.fn().mockResolvedValue("n1") }))
jest.mock("@/lib/workflow/runtime/event-log", () => ({
  appendEvent: jest.fn().mockResolvedValue(undefined),
}))

import { recordHostDispatchFailure } from "./dispatch-failure-audit"
import type { HostDispatchJobRow } from "@/types/placement/host-dispatch"

const notifyRuntime = jest.requireMock("@/lib/notifications/runtime") as {
  notify: jest.Mock
}
const eventLog = jest.requireMock("@/lib/workflow/runtime/event-log") as {
  appendEvent: jest.Mock
}

const NOW = 1_700_000_000_000

function job(overrides: Partial<HostDispatchJobRow> = {}): HostDispatchJobRow {
  return {
    id: "job-1",
    accountId: "acct",
    domain: "mobile-step",
    targetRef: "device:phone",
    kind: "action.mobile.camera",
    payload: {},
    status: "deadletter",
    attempts: 6,
    maxAttempts: 6,
    createdAt: NOW,
    updatedAt: NOW,
    nextAttemptAt: NOW,
    expiresAt: NOW + 60_000,
    idempotencyKey: "run:step:phone",
    runId: "run-1",
    stepId: "step-1",
    label: "wf-1",
    ...overrides,
  }
}

describe("recordHostDispatchFailure", () => {
  it("notifies and attaches the failure to the run journal", async () => {
    const notify = jest.fn().mockResolvedValue("n1")
    const appendRunEvent = jest.fn().mockResolvedValue(undefined)

    await recordHostDispatchFailure(
      job(),
      { kind: "deadletter", code: "transport", error: "socket closed", at: NOW },
      { notify, appendRunEvent }
    )

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "workflow",
        level: "error",
        directed: true,
        dedupeKey: "host-dispatch.deadletter:job-1",
        groupKey: "workflow-run:run-1",
        href: "/workflows/runs?id=wf-1",
        sourceRef: { kind: "host-dispatch", id: "job-1" },
      })
    )
    const notified = notify.mock.calls[0][0]
    expect(notified.title).toContain("6 attempts")
    expect(notified.body).toContain("device:phone")
    expect(notified.body).toContain("socket closed")
    expect(notified.meta).toMatchObject({
      dispatchId: "job-1",
      domain: "mobile-step",
      code: "transport",
      runId: "run-1",
      stepId: "step-1",
    })

    expect(appendRunEvent).toHaveBeenCalledWith({
      runId: "run-1",
      type: "run_log",
      level: "error",
      stepId: "step-1",
      payload: expect.objectContaining({
        kind: "host-dispatch.terminal",
        outcome: "deadletter",
        dispatchId: "job-1",
        code: "transport",
        error: "socket closed",
        attempts: 6,
      }),
    })
  })

  it("titles a non-retryable refusal differently from an exhausted budget", async () => {
    const notify = jest.fn().mockResolvedValue("n1")
    await recordHostDispatchFailure(
      job({ domain: "schedule-handoff", runId: undefined, stepId: undefined }),
      { kind: "failed", code: "timeout", error: "deadline expired", at: NOW },
      { notify, appendRunEvent: jest.fn() }
    )
    const notified = notify.mock.calls[0][0]
    expect(notified.title).toBe("Workflow handoff could not be delivered")
    expect(notified.dedupeKey).toBe("host-dispatch.failed:job-1")
    expect(notified.groupKey).toBeUndefined()
  })

  it("writes no run event for a handoff, which never had a local run", async () => {
    const appendRunEvent = jest.fn()
    await recordHostDispatchFailure(
      job({ domain: "schedule-handoff", runId: undefined, stepId: undefined, label: undefined }),
      { kind: "deadletter", code: "handoff_failed", error: "offline", at: NOW },
      { notify: jest.fn().mockResolvedValue("n1"), appendRunEvent }
    )
    expect(appendRunEvent).not.toHaveBeenCalled()
  })

  it("omits the href when the row carries no workflow label", async () => {
    const notify = jest.fn().mockResolvedValue("n1")
    await recordHostDispatchFailure(
      job({ label: undefined }),
      { kind: "deadletter", code: "transport", error: "gone", at: NOW },
      { notify, appendRunEvent: jest.fn() }
    )
    expect(notify.mock.calls[0][0].href).toBeUndefined()
  })

  it("never throws when either surface rejects", async () => {
    const appendRunEvent = jest.fn().mockRejectedValue(new Error("dexie closed"))
    await expect(
      recordHostDispatchFailure(
        job(),
        { kind: "deadletter", code: "transport", error: "gone", at: NOW },
        { notify: jest.fn().mockRejectedValue(new Error("center down")), appendRunEvent }
      )
    ).resolves.toBeUndefined()
    // The run event is still attempted after the notification fails — the two
    // surfaces are independent and a dead center must not hide the journal entry.
    expect(appendRunEvent).toHaveBeenCalled()
  })

  it("reaches the real notification center and run-event log with no deps injected", async () => {
    // The production call site passes no `deps`; without this the lazy-import
    // defaults would never execute outside the desktop shell.
    notifyRuntime.notify.mockClear()
    eventLog.appendEvent.mockClear()

    await recordHostDispatchFailure(job(), {
      kind: "deadletter",
      code: "transport",
      error: "socket closed",
      at: NOW,
    })

    expect(notifyRuntime.notify).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: "host-dispatch.deadletter:job-1" })
    )
    expect(eventLog.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", type: "run_log", level: "error" })
    )
  })
})
