/** @jest-environment jsdom */

jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn(async () => ({ providerSettings: {} })),
}))
jest.mock("@/lib/scheduler/task-scheduler", () => ({
  registerTaskExecutor: jest.fn(),
  getTaskScheduler: jest.fn(),
}))

import type { ProviderDiagnosticsRefreshState } from "@cognia/provider-types"

import {
  installProviderDiagnosticsRefreshSchedule,
  nextProviderDiagnosticsRefreshState,
  providerDiagnosticsNotificationTransition,
  registerProviderDiagnosticsRefreshExecutor,
  runProviderDiagnosticsRefreshClock,
} from "./refresh"

const STATE: ProviderDiagnosticsRefreshState = {
  sourceId: "provider-balance:stepfun:primary",
  providerId: "stepfun",
  status: "running",
  nextDueAt: 0,
  consecutiveFailures: 0,
}

describe("provider diagnostics refresh clock", () => {
  it("honors Retry-After and exponential backoff capped at 24 hours", () => {
    expect(
      nextProviderDiagnosticsRefreshState(STATE, {
        kind: "failure",
        now: 1_000,
        intervalMs: 30 * 60_000,
        retryAfterMs: 7_200_000,
      }).nextDueAt
    ).toBe(7_201_000)

    const backedOff = nextProviderDiagnosticsRefreshState(
      { ...STATE, consecutiveFailures: 20 },
      { kind: "failure", now: 1_000, intervalMs: 30 * 60_000 }
    )
    expect(backedOff.nextDueAt).toBe(1_000 + 24 * 60 * 60_000)
  })

  it("pauses authentication failures until manual retry or credential change", () => {
    expect(
      nextProviderDiagnosticsRefreshState(STATE, {
        kind: "authentication",
        now: 1_000,
        intervalMs: 30 * 60_000,
      })
    ).toEqual(
      expect.objectContaining({ status: "paused-auth", nextDueAt: Number.MAX_SAFE_INTEGER })
    )
  })

  it("pauses all due sources offline and never invokes a paid benchmark", async () => {
    const states = [{ ...STATE, nextDueAt: 0 }]
    const putState = jest.fn(async () => undefined)
    const runFreeSource = jest.fn()

    const result = await runProviderDiagnosticsRefreshClock({
      now: () => 1_000,
      isOnline: () => false,
      isVaultAvailable: () => true,
      listDueStates: async () => states,
      putState,
      runFreeSource,
    })

    expect(result).toEqual({ scanned: 1, refreshed: 0, paused: 1 })
    expect(putState).toHaveBeenCalledWith(expect.objectContaining({ status: "paused-offline" }))
    expect(runFreeSource).not.toHaveBeenCalled()
  })

  it("uses a resumable vault pause instead of classifying a lock as bad authentication", async () => {
    const putState = jest.fn(async () => undefined)
    await runProviderDiagnosticsRefreshClock({
      now: () => 1_000,
      isOnline: () => true,
      isVaultAvailable: () => false,
      listDueStates: async () => [{ ...STATE, nextDueAt: 0 }],
      putState,
      runFreeSource: jest.fn(),
    })
    expect(putState).toHaveBeenCalledWith(expect.objectContaining({ status: "paused-vault" }))
  })

  it("refreshes due sources once and maps authentication outcomes", async () => {
    const putState = jest.fn(async () => undefined)
    const runFreeSource = jest.fn(async () => ({ code: "authentication" as const }))
    const result = await runProviderDiagnosticsRefreshClock({
      now: () => 1_000,
      isOnline: () => true,
      isVaultAvailable: () => true,
      listDueStates: async () => [{ ...STATE, nextDueAt: 0 }],
      putState,
      runFreeSource,
    })

    expect(result.refreshed).toBe(1)
    expect(putState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "paused-auth" }))
  })

  it("notifies only on authentication, repeat-failure, zero, and threshold transitions", () => {
    expect(
      providerDiagnosticsNotificationTransition({
        state: STATE,
        now: 1_000,
        failureCode: "authentication",
      })
    ).toBe("authentication")
    expect(
      providerDiagnosticsNotificationTransition({
        state: { ...STATE, lastObservedRemaining: 11 },
        now: 1_000,
        remaining: 9,
        threshold: 10,
      })
    ).toBe("low-balance")
    expect(
      providerDiagnosticsNotificationTransition({
        state: { ...STATE, lastObservedRemaining: 0, lastNotificationAt: 900 },
        now: 1_000,
        remaining: 0,
      })
    ).toBeUndefined()
  })

  it("persists notification cooldown state after a balance transition", async () => {
    const putState = jest.fn(async () => undefined)
    const notifyTransition = jest.fn(async () => undefined)
    await runProviderDiagnosticsRefreshClock({
      now: () => 1_000,
      isOnline: () => true,
      isVaultAvailable: () => true,
      listDueStates: async () => [{ ...STATE, lastObservedRemaining: 5 }],
      putState,
      runFreeSource: async () => ({ remaining: 0, balanceSourceId: "source-1" }),
      getThreshold: async () => undefined,
      notifyTransition,
    })

    expect(notifyTransition).toHaveBeenCalledWith(
      "zero-balance",
      expect.objectContaining({ lastNotificationAt: 1_000, lastObservedRemaining: 0 })
    )
  })
})

describe("refresh executor registration", () => {
  it("registers the refresh clock under the task type without touching the schedule", async () => {
    const { getTaskScheduler, registerTaskExecutor } =
      await import("@/lib/scheduler/task-scheduler")
    jest.mocked(registerTaskExecutor).mockClear()
    jest.mocked(getTaskScheduler).mockClear()

    registerProviderDiagnosticsRefreshExecutor()

    expect(registerTaskExecutor).toHaveBeenCalledTimes(1)
    expect(registerTaskExecutor).toHaveBeenCalledWith(
      "provider-diagnostics-refresh",
      expect.any(Function)
    )
    // The on-demand path (`lib/scheduler/executor-owners.ts`) must not seed or
    // migrate rows: only the boot install owns the schedule.
    expect(getTaskScheduler).not.toHaveBeenCalled()
  })

  it("registers the executor at install before reading the schedule", async () => {
    const { getTaskScheduler, registerTaskExecutor } =
      await import("@/lib/scheduler/task-scheduler")
    const order: string[] = []
    jest.mocked(registerTaskExecutor).mockImplementationOnce(() => {
      order.push("register")
    })
    jest.mocked(getTaskScheduler).mockReturnValue({
      getAllTasks: async () => {
        order.push("read-schedule")
        return [{ id: "existing", type: "provider-diagnostics-refresh", notification: {} }]
      },
      updateTask: jest.fn().mockResolvedValue(undefined),
    } as never)

    await installProviderDiagnosticsRefreshSchedule()

    expect(order).toEqual(["register", "read-schedule"])
  })
})

describe("diagnostics schedule reminders", () => {
  it("disables due reminders for new internal tasks", async () => {
    const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
    const createTask = jest.fn().mockResolvedValue(undefined)
    jest
      .mocked(getTaskScheduler)
      .mockReturnValue({ getAllTasks: async () => [], createTask } as never)
    await installProviderDiagnosticsRefreshSchedule()
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        notification: expect.objectContaining({ dueReminder: false, onError: true }),
      })
    )
  })

  it("migrates only an unspecified reminder while keeping failure preferences", async () => {
    const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
    const updateTask = jest.fn().mockResolvedValue(undefined)
    jest.mocked(getTaskScheduler).mockReturnValue({
      getAllTasks: async () => [
        { id: "legacy", type: "provider-diagnostics-refresh", notification: { onError: true } },
        {
          id: "opted-in",
          type: "provider-diagnostics-refresh",
          notification: { dueReminder: true },
        },
      ],
      updateTask,
    } as never)
    await installProviderDiagnosticsRefreshSchedule()
    expect(updateTask).toHaveBeenCalledTimes(1)
    expect(updateTask).toHaveBeenCalledWith("legacy", {
      notification: { onError: true, dueReminder: false },
    })
  })
})
