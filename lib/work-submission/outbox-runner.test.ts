/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { webcrypto } from "node:crypto"

import { WORK_SUBMISSION_CONTRACT_VERSION } from "@cognia/agent-config-types/work-submission"
import type { WorkSubmissionIntentV1 } from "@cognia/agent-config-types/work-submission"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { runEventJournal, semanticRunEvent } from "@/lib/db/execution-runs"
import { getWorkSubmission, type WorkSubmissionRow } from "@/lib/db/work-submissions"

import { acceptWorkSubmission } from "./service"
import {
  backoffForAttempt,
  runWorkOutboxPass,
  startWorkOutboxRunner,
  WORK_OUTBOX_BASE_BACKOFF_MS,
  WORK_OUTBOX_MAX_BACKOFF_MS,
  type WorkDispatchOutcome,
  type WorkOutboxDeps,
} from "./outbox-runner"

interface HeartbeatTestDeps {
  onLeaseLost?: () => void
}

let heartbeatDeps: HeartbeatTestDeps | undefined
const stopHeartbeatMock = jest.fn()
const startHeartbeatMock = jest.fn(
  (_submissionId: string, _leaseOwner: string, deps?: HeartbeatTestDeps) => {
    heartbeatDeps = deps
    return stopHeartbeatMock
  }
)
jest.mock("./lease-heartbeat", () => ({
  startWorkSubmissionLeaseHeartbeat: (
    submissionId: string,
    leaseOwner: string,
    deps?: HeartbeatTestDeps
  ) => startHeartbeatMock(submissionId, leaseOwner, deps),
}))

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true })
  }
})

const NOW = 1_755_000_000_000
const cryptoDeps = { loadKey: async () => new Uint8Array(32).fill(5) }

function intent(overrides: Partial<WorkSubmissionIntentV1> = {}): WorkSubmissionIntentV1 {
  return {
    contractVersion: WORK_SUBMISSION_CONTRACT_VERSION,
    idempotencyKey: "chat:session-1:action-1",
    source: { kind: "chat", sourceId: "session-1" },
    scope: { accountId: "account-1", runtimeTargetId: "target-1", sessionId: "session-1" },
    availabilityPolicy: "wait",
    ...overrides,
  }
}

async function seedSubmission(
  overrides: { intent?: WorkSubmissionIntentV1; id?: string } = {}
): Promise<void> {
  const id = overrides.id ?? "submission-1"
  await acceptWorkSubmission(
    {
      intent: overrides.intent ?? intent(),
      runId: `run-${id}`,
      turnId: `turn-${id}`,
      inputBatchId: `batch-${id}`,
      submissionId: id,
      input: { content: "hello", visibleMessageIds: ["message-1"], attachments: [] },
      now: NOW,
    },
    cryptoDeps
  )
  // Most runner tests exercise rows whose live assembly window has already
  // elapsed. The acceptance grace itself is covered in service.test.ts.
  await getDb().workSubmissions.update(id, { nextAttemptAt: NOW })
}

function deps(
  dispatch: (row: WorkSubmissionRow) => Promise<WorkDispatchOutcome>,
  overrides: Partial<WorkOutboxDeps> = {}
): WorkOutboxDeps {
  return {
    runnerId: "runner-a",
    dispatch,
    abort: async () => {},
    now: () => NOW + 1,
    readEnvelopes: async () => [],
    ...overrides,
  }
}

describe("backoffForAttempt", () => {
  it("starts at the base delay on the first attempt", () => {
    expect(backoffForAttempt(1)).toBe(WORK_OUTBOX_BASE_BACKOFF_MS)
  })

  it("doubles per attempt", () => {
    expect(backoffForAttempt(2)).toBe(WORK_OUTBOX_BASE_BACKOFF_MS * 2)
    expect(backoffForAttempt(3)).toBe(WORK_OUTBOX_BASE_BACKOFF_MS * 4)
  })

  it("caps so a stuck target still retries", () => {
    expect(backoffForAttempt(1000)).toBe(WORK_OUTBOX_MAX_BACKOFF_MS)
  })

  it("treats a zero attempt count as the first attempt", () => {
    expect(backoffForAttempt(0)).toBe(WORK_OUTBOX_BASE_BACKOFF_MS)
  })
})

describe("runWorkOutboxPass", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    heartbeatDeps = undefined
    startHeartbeatMock.mockClear()
    stopHeartbeatMock.mockClear()
  }, 30_000)

  it("dispatches claimable work and moves the run to running", async () => {
    await seedSubmission()
    const dispatch = jest.fn(async () => ({ status: "dispatched" }) as WorkDispatchOutcome)

    const result = await runWorkOutboxPass(deps(dispatch))

    expect(result).toMatchObject({ claimed: 1, dispatched: 1 })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect((await getWorkSubmission("submission-1"))?.dispatchState).toBe("dispatched")
    expect((await getDb().executionRuns.get("run-submission-1"))?.status).toBe("running")
  }, 30_000)

  it("keeps the heartbeat alive after dispatch until terminal settlement", async () => {
    await seedSubmission()
    await runWorkOutboxPass(deps(async () => ({ status: "dispatched" })))

    expect(startHeartbeatMock).toHaveBeenCalledWith(
      "submission-1",
      "runner-a",
      expect.objectContaining({ onLeaseLost: expect.any(Function) })
    )
    expect(stopHeartbeatMock).not.toHaveBeenCalled()
  }, 30_000)

  it("stops mutating the ledger without a late session abort when ownership is lost", async () => {
    await seedSubmission()
    let resolveDispatch: ((outcome: WorkDispatchOutcome) => void) | undefined
    const dispatch = jest.fn(
      () =>
        new Promise<WorkDispatchOutcome>((resolve) => {
          resolveDispatch = resolve
        })
    )
    const abort = jest.fn(async () => {})
    const pass = runWorkOutboxPass(deps(dispatch, { abort }))
    for (let attempt = 0; attempt < 100 && dispatch.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(dispatch).toHaveBeenCalledTimes(1)
    await getDb().workSubmissions.update("submission-1", { leaseOwner: "runner-b" })

    heartbeatDeps?.onLeaseLost?.()
    resolveDispatch!({ status: "dispatched" })
    const result = await pass

    expect(abort).not.toHaveBeenCalled()
    expect(result.dispatched).toBe(0)
    expect(await getWorkSubmission("submission-1")).toMatchObject({
      dispatchState: "claimed",
      leaseOwner: "runner-b",
    })
  }, 30_000)

  it("stops an expired dispatched runtime before replacement handoff", async () => {
    await seedSubmission()
    await getDb().workSubmissions.update("submission-1", {
      dispatchState: "dispatched",
      attemptCount: 1,
      leaseOwner: "runner-old",
      leaseExpiresAt: NOW,
    })
    const order: string[] = []
    const abort = jest.fn(async () => {
      order.push("abort-old")
    })
    const dispatch = jest.fn(async () => {
      order.push("dispatch-new")
      return { status: "dispatched" } as WorkDispatchOutcome
    })

    const result = await runWorkOutboxPass(deps(dispatch, { abort }), {
      includeDispatched: true,
    })

    expect(result.dispatched).toBe(1)
    expect(order).toEqual(["abort-old", "dispatch-new"])
    expect(startHeartbeatMock.mock.invocationCallOrder[0]).toBeLessThan(
      abort.mock.invocationCallOrder[0]
    )
  }, 30_000)

  it("parks an expired dispatched runtime when the old run cannot be stopped", async () => {
    await seedSubmission()
    await getDb().workSubmissions.update("submission-1", {
      dispatchState: "dispatched",
      attemptCount: 1,
      leaseOwner: "runner-old",
      leaseExpiresAt: NOW,
    })
    const abortError = new Error("interrupt unavailable")
    const abort = jest.fn(async () => {
      throw abortError
    })
    const dispatch = jest.fn(async () => ({ status: "dispatched" }) as WorkDispatchOutcome)
    const onError = jest.fn()

    const result = await runWorkOutboxPass(deps(dispatch, { abort, onError }), {
      includeDispatched: true,
    })

    expect(dispatch).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(abortError, "submission-1")
    expect(result).toMatchObject({ recoveryRequired: 1, dispatched: 0 })
    expect(await getWorkSubmission("submission-1")).toMatchObject({
      dispatchState: "settled",
      terminalOutcome: "recovery_required",
      errorCode: "takeover_abort_failed",
    })
  }, 30_000)

  it("does not settle a replacement owner when takeover abort fails after lease loss", async () => {
    await seedSubmission()
    await getDb().workSubmissions.update("submission-1", {
      dispatchState: "dispatched",
      attemptCount: 1,
      leaseOwner: "runner-old",
      leaseExpiresAt: NOW,
    })
    let rejectAbort: ((error: Error) => void) | undefined
    const abort = jest.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectAbort = reject
        })
    )
    const dispatch = jest.fn(async () => ({ status: "dispatched" }) as WorkDispatchOutcome)
    const pass = runWorkOutboxPass(deps(dispatch, { abort, onError: () => {} }), {
      includeDispatched: true,
    })
    for (let attempt = 0; attempt < 100 && abort.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await getDb().workSubmissions.update("submission-1", {
      dispatchState: "claimed",
      leaseOwner: "runner-b",
      leaseExpiresAt: NOW + 60_000,
    })
    rejectAbort?.(new Error("late interrupt failure"))

    const result = await pass

    expect(dispatch).not.toHaveBeenCalled()
    expect(result.recoveryRequired).toBe(0)
    expect(await getWorkSubmission("submission-1")).toMatchObject({
      dispatchState: "claimed",
      leaseOwner: "runner-b",
    })
  }, 30_000)

  it("does nothing when there is no claimable work", async () => {
    const dispatch = jest.fn(async () => ({ status: "dispatched" }) as WorkDispatchOutcome)
    const result = await runWorkOutboxPass(deps(dispatch))
    expect(result).toEqual({
      claimed: 0,
      dispatched: 0,
      deferred: 0,
      failed: 0,
      recoveryRequired: 0,
    })
    expect(dispatch).not.toHaveBeenCalled()
  }, 30_000)

  it("parks work as recovery_required without ever re-dispatching it after a tool ran", async () => {
    // The core safety property: replaying a turn that already reached a tool
    // could double-fire a side effect, so the runner must not even claim it.
    await seedSubmission()
    await getDb().workSubmissions.update("submission-1", {
      dispatchState: "claimed",
      attemptCount: 1,
    })
    await runEventJournal.append(
      "run-submission-1",
      semanticRunEvent("tool.started", { toolName: "write_file" }, { ts: NOW })
    )

    const dispatch = jest.fn(async () => ({ status: "dispatched" }) as WorkDispatchOutcome)
    const result = await runWorkOutboxPass(deps(dispatch))

    expect(dispatch).not.toHaveBeenCalled()
    expect(result).toMatchObject({ recoveryRequired: 1, dispatched: 0 })
    expect(await getWorkSubmission("submission-1")).toMatchObject({
      dispatchState: "settled",
      terminalOutcome: "recovery_required",
      errorCode: "observed-tool-activity",
    })
  }, 30_000)

  it("re-dispatches a stranded attempt that recorded no tool activity", async () => {
    await seedSubmission()
    await getDb().workSubmissions.update("submission-1", {
      dispatchState: "claimed",
      attemptCount: 1,
    })
    const dispatch = jest.fn(async () => ({ status: "dispatched" }) as WorkDispatchOutcome)

    const result = await runWorkOutboxPass(deps(dispatch))
    expect(result).toMatchObject({ dispatched: 1 })
  }, 30_000)

  it("blocks and backs off when the target is away and the policy is wait", async () => {
    await seedSubmission()
    const dispatch = async () =>
      ({ status: "unavailable", errorCode: "host_offline" }) as WorkDispatchOutcome

    const result = await runWorkOutboxPass(deps(dispatch))

    expect(result).toMatchObject({ deferred: 1 })
    expect(await getWorkSubmission("submission-1")).toMatchObject({
      dispatchState: "blocked",
      errorCode: "host_offline",
      nextAttemptAt: NOW + 1 + WORK_OUTBOX_BASE_BACKOFF_MS,
    })
  }, 30_000)

  it("fails an unavailable target when the policy is not wait", async () => {
    // Anything that is not waiting must surface the failure rather than grow a
    // backlog nobody is watching.
    await seedSubmission({ intent: intent({ availabilityPolicy: "fail" }) })
    const dispatch = async () => ({ status: "unavailable" }) as WorkDispatchOutcome

    const result = await runWorkOutboxPass(deps(dispatch))

    expect(result).toMatchObject({ failed: 1 })
    expect(await getWorkSubmission("submission-1")).toMatchObject({
      dispatchState: "settled",
      terminalOutcome: "failed",
      errorCode: "target_unavailable",
    })
  }, 30_000)

  it("retries a transient failure with backoff", async () => {
    await seedSubmission()
    const dispatch = async () =>
      ({ status: "retry", errorCode: "socket_reset" }) as WorkDispatchOutcome

    const result = await runWorkOutboxPass(deps(dispatch))

    expect(result).toMatchObject({ deferred: 1 })
    expect(await getWorkSubmission("submission-1")).toMatchObject({
      dispatchState: "pending",
      errorCode: "socket_reset",
    })
  }, 30_000)

  it("settles a terminal dispatch failure without retrying", async () => {
    await seedSubmission()
    const dispatch = async () =>
      ({ status: "failed", errorCode: "capability_missing" }) as WorkDispatchOutcome

    const result = await runWorkOutboxPass(deps(dispatch))

    expect(result).toMatchObject({ failed: 1 })
    expect(await getWorkSubmission("submission-1")).toMatchObject({
      dispatchState: "settled",
      terminalOutcome: "failed",
      errorCode: "capability_missing",
    })
  }, 30_000)

  it("parks work when the dispatcher cannot prove a faithful replay", async () => {
    await seedSubmission()
    const dispatch = async () =>
      ({
        status: "recovery_required",
        errorCode: "missing_frozen_context",
      }) as WorkDispatchOutcome

    const result = await runWorkOutboxPass(deps(dispatch))

    expect(result).toMatchObject({ recoveryRequired: 1, dispatched: 0 })
    expect(await getWorkSubmission("submission-1")).toMatchObject({
      dispatchState: "settled",
      terminalOutcome: "recovery_required",
      errorCode: "missing_frozen_context",
    })
  }, 30_000)

  it("treats a thrown dispatch as retryable and reports it", async () => {
    await seedSubmission()
    const onError = jest.fn()
    const dispatch = async () => {
      throw new TypeError("transport exploded")
    }

    const result = await runWorkOutboxPass(deps(dispatch, { onError }))

    expect(result).toMatchObject({ deferred: 1 })
    expect(onError).toHaveBeenCalledWith(expect.any(TypeError), "submission-1")
    expect((await getWorkSubmission("submission-1"))?.dispatchState).toBe("pending")
  }, 30_000)

  it("labels a non-Error throw rather than losing it", async () => {
    await seedSubmission()
    const dispatch = async () => {
      throw "just a string"
    }
    await runWorkOutboxPass(deps(dispatch, { onError: () => {} }))
    expect((await getWorkSubmission("submission-1"))?.errorCode).toBe("dispatch_threw")
  }, 30_000)

  it("falls back to the wall clock when no clock is injected", async () => {
    await seedSubmission()
    const dispatch = jest.fn(async () => ({ status: "dispatched" }) as WorkDispatchOutcome)
    const result = await runWorkOutboxPass({
      runnerId: "runner-a",
      dispatch,
      abort: async () => {},
      readEnvelopes: async () => [],
    })
    expect(result).toMatchObject({ dispatched: 1 })
  }, 30_000)

  it("keeps sweeping after one submission fails", async () => {
    // One poisoned row must not stop other stranded work from recovering.
    await seedSubmission({ id: "submission-1" })
    await seedSubmission({
      id: "submission-2",
      intent: intent({ idempotencyKey: "chat:session-1:action-2" }),
    })

    const seen: string[] = []
    const dispatch = jest.fn(async (row: WorkSubmissionRow) => {
      seen.push(row.id)
      if (row.id === "submission-1") throw new Error("boom")
      return { status: "dispatched" } as WorkDispatchOutcome
    })

    const result = await runWorkOutboxPass(deps(dispatch, { onError: () => {} }))

    expect(seen).toHaveLength(2)
    expect(result).toMatchObject({ dispatched: 1, deferred: 1 })
  }, 30_000)

  it("parks an unreadable journal and continues the rest of the sweep", async () => {
    await seedSubmission({ id: "submission-1" })
    await seedSubmission({
      id: "submission-2",
      intent: intent({ idempotencyKey: "chat:session-1:action-2" }),
    })
    await getDb().workSubmissions.update("submission-1", {
      dispatchState: "claimed",
      attemptCount: 1,
    })

    const onError = jest.fn()
    const dispatch = jest.fn(async () => ({ status: "dispatched" }) as WorkDispatchOutcome)
    const result = await runWorkOutboxPass(
      deps(dispatch, {
        onError,
        readEnvelopes: async (runId: string) => {
          if (runId === "run-submission-1") throw new Error("journal unreadable")
          return []
        },
      })
    )

    expect(onError).not.toHaveBeenCalled()
    // The healthy row still went out.
    expect(result).toMatchObject({ dispatched: 1, recoveryRequired: 1 })
  }, 30_000)

  it("respects the batch size so one sweep cannot monopolise the host", async () => {
    await seedSubmission({ id: "submission-1" })
    await seedSubmission({
      id: "submission-2",
      intent: intent({ idempotencyKey: "chat:session-1:action-2" }),
    })
    const dispatch = jest.fn(async () => ({ status: "dispatched" }) as WorkDispatchOutcome)

    await runWorkOutboxPass(deps(dispatch, { batchSize: 1 }))
    expect(dispatch).toHaveBeenCalledTimes(1)
  }, 30_000)

  it("skips a row another runner claimed first", async () => {
    await seedSubmission()
    const dispatch = jest.fn(async () => ({ status: "dispatched" }) as WorkDispatchOutcome)

    // Simulate the race by handing the runner a stale row while a live lease
    // already exists on disk.
    await getDb().workSubmissions.update("submission-1", {
      dispatchState: "claimed",
      leaseOwner: "runner-b",
      leaseExpiresAt: NOW + 60_000,
    })
    const stale = (await getWorkSubmission("submission-1"))!

    const result = await runWorkOutboxPass(deps(dispatch, { listClaimable: async () => [stale] }))

    expect(dispatch).not.toHaveBeenCalled()
    expect(result.claimed).toBe(0)
  }, 30_000)
})

describe("startWorkOutboxRunner", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    jest.useFakeTimers()
  }, 30_000)

  afterEach(() => {
    jest.useRealTimers()
  })

  it("sweeps immediately, because a restart is when stranded work matters most", () => {
    const listClaimable = jest.fn(async () => [])
    const stop = startWorkOutboxRunner(
      deps(async () => ({ status: "dispatched" }), { listClaimable })
    )
    expect(listClaimable).toHaveBeenCalledTimes(1)
    stop()
  })

  it("keeps considering dispatched rows so leases that expire after startup are recovered", () => {
    const listClaimable = jest.fn(async () => [])
    const stop = startWorkOutboxRunner(
      deps(async () => ({ status: "dispatched" }), { listClaimable })
    )

    expect(listClaimable).toHaveBeenNthCalledWith(1, NOW + 1, 25, {
      includeDispatched: true,
    })
    jest.advanceTimersByTime(30_000)
    expect(listClaimable).toHaveBeenLastCalledWith(NOW + 1, 25, {
      includeDispatched: true,
    })
    stop()
  })

  it("stops sweeping once unsubscribed", () => {
    const listClaimable = jest.fn(async () => [])
    const stop = startWorkOutboxRunner(
      deps(async () => ({ status: "dispatched" }), { listClaimable })
    )
    stop()
    jest.advanceTimersByTime(10 * 60_000)
    expect(listClaimable).toHaveBeenCalledTimes(1)
  })

  it("keeps sweeping on the interval", () => {
    const listClaimable = jest.fn(async () => [])
    const stop = startWorkOutboxRunner(
      deps(async () => ({ status: "dispatched" }), { listClaimable })
    )
    jest.advanceTimersByTime(90_000)
    expect(listClaimable.mock.calls.length).toBeGreaterThan(1)
    stop()
  })

  it("survives a sweep that rejects", () => {
    const onError = jest.fn()
    const stop = startWorkOutboxRunner(
      deps(async () => ({ status: "dispatched" }), {
        listClaimable: async () => {
          throw new Error("db gone")
        },
        onError,
      })
    )
    expect(() => jest.advanceTimersByTime(60_000)).not.toThrow()
    stop()
  })
})
