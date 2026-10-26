/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb } from "@/lib/db/schema"
import { getSettings } from "@/lib/db/settings"

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
  ensureProviderDiagnosticsRefreshStates,
  resumeProviderReachabilityRefresh,
  resumeProviderBalanceRefresh,
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

it.each(["paused-auth", "scheduled"] as const)(
  "preserves %s state, backoff and notification cooldown across boot",
  async (status) => {
    const table = getDb().providerDiagnosticsRefreshState
    await table.clear()
    jest.mocked(getSettings).mockResolvedValue({
      providerSettings: { stepfun: { enabled: true } },
    } as never)
    const paused: ProviderDiagnosticsRefreshState = {
      ...STATE,
      sourceId: "provider-reachability:stepfun",
      status,
      nextDueAt: status === "paused-auth" ? Number.MAX_SAFE_INTEGER : Date.now() + 7_200_000,
      retryAfterMs: 7_200_000,
      consecutiveFailures: 4,
      lastNotificationAt: 100,
      lastNotifiedReason: "authentication",
    }
    await table.put(paused)
    await ensureProviderDiagnosticsRefreshStates()
    await ensureProviderDiagnosticsRefreshStates()
    expect(await table.get(paused.sourceId)).toEqual(paused)
    jest.mocked(getSettings).mockResolvedValue({ providerSettings: {} } as never)
    await table.clear()
  }
)

describe("provider diagnostics refresh clock", () => {
  it("resumes only a manually verified balance credential, retaining other authentication pauses", async () => {
    const table = getDb().providerDiagnosticsRefreshState
    await table.clear()
    await table.bulkPut([
      { ...STATE, status: "paused-auth", nextDueAt: Number.MAX_SAFE_INTEGER },
      {
        ...STATE,
        sourceId: "provider-reachability:stepfun",
        status: "paused-auth",
        nextDueAt: Number.MAX_SAFE_INTEGER,
      },
    ])
    await resumeProviderBalanceRefresh({
      id: "stepfun:other:adapter",
      providerId: "stepfun",
      credentialId: "other",
      kind: "official",
    } as never)
    expect((await table.get(STATE.sourceId))?.status).toBe("paused-auth")
    await resumeProviderBalanceRefresh({
      id: "stepfun:primary:adapter",
      providerId: "stepfun",
      credentialId: "primary",
      kind: "official",
    } as never)
    expect(await table.get(STATE.sourceId)).toMatchObject({
      status: "scheduled",
      lastOutcome: "succeeded",
      consecutiveFailures: 0,
    })
    expect((await table.get("provider-reachability:stepfun"))?.status).toBe("paused-auth")
    await table.clear()
  })
  it("reports source outcomes separately from orchestration attempts and ignores observer errors", async () => {
    const putState = jest.fn(async () => undefined)
    const outcomes = [
      {},
      { code: "capability-unsupported" },
      { code: "authentication" },
      { code: "network" },
    ]
    const result = await runProviderDiagnosticsRefreshClock({
      now: () => 1000,
      isOnline: () => true,
      isVaultAvailable: () => true,
      listDueStates: async () => outcomes.map((_, i) => ({ ...STATE, sourceId: `s${i}` })),
      putState,
      runFreeSource: jest.fn(async () => outcomes.shift() as never),
      getThreshold: async () => undefined,
      notifyTransition: async () => {
        throw new Error("observer failed")
      },
    })
    expect(result).toMatchObject({
      attempted: 4,
      succeeded: 1,
      refreshed: 1,
      skipped: 1,
      blocked: 1,
      failed: 1,
    })
    expect(putState).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "s0", lastSuccessAt: 1000, lastOutcome: "succeeded" })
    )
    expect(putState).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "s1", lastOutcome: "skipped" })
    )
    expect(putState).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "s2", lastOutcome: "blocked" })
    )
  })
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

    expect(result).toMatchObject({
      scanned: 1,
      refreshed: 0,
      paused: 1,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      blocked: 1,
      skipped: 0,
    })
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

    expect(result).toMatchObject({
      attempted: 1,
      refreshed: 0,
      succeeded: 0,
      failed: 0,
      blocked: 1,
      skipped: 0,
    })
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
        notification: expect.objectContaining({ dueReminder: false, onError: false }),
      })
    )
  })

  it("migrates an unspecified reminder while keeping explicit desktop failure preferences", async () => {
    const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
    const updateTask = jest.fn().mockResolvedValue(undefined)
    jest.mocked(getTaskScheduler).mockReturnValue({
      getAllTasks: async () => [
        {
          id: "legacy",
          type: "provider-diagnostics-refresh",
          notification: { channels: ["desktop"], onError: true },
        },
      ],
      updateTask,
    } as never)
    await installProviderDiagnosticsRefreshSchedule()
    expect(updateTask).toHaveBeenCalledTimes(1)
    expect(updateTask).toHaveBeenCalledWith("legacy", { notification: { dueReminder: false } })
  })

  it("keeps an explicit due reminder opt-in", async () => {
    const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
    const updateTask = jest.fn().mockResolvedValue(undefined)
    jest.mocked(getTaskScheduler).mockReturnValue({
      getAllTasks: async () => [
        {
          id: "opted-in",
          type: "provider-diagnostics-refresh",
          notification: { channels: ["desktop"], onError: true, dueReminder: true },
        },
      ],
      updateTask,
    } as never)
    await installProviderDiagnosticsRefreshSchedule()
    expect(updateTask).not.toHaveBeenCalled()
  })
})

it("resumes only the manually verified reachability source without resetting balance pauses", async () => {
  const table = getDb().providerDiagnosticsRefreshState
  await table.clear()
  const reachability = {
    ...STATE,
    sourceId: "provider-reachability:stepfun",
    status: "paused-auth" as const,
    nextDueAt: Number.MAX_SAFE_INTEGER,
  }
  const balance = { ...STATE, status: "paused-auth" as const, nextDueAt: Number.MAX_SAFE_INTEGER }
  await table.bulkPut([reachability, balance])
  await resumeProviderReachabilityRefresh("stepfun")
  expect(await table.get(reachability.sourceId)).toMatchObject({
    status: "scheduled",
    consecutiveFailures: 0,
  })
  expect(await table.get(balance.sourceId)).toEqual(balance)
  await table.clear()
})
