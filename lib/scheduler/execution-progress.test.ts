import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import {
  __resetExecutionProgressForTesting,
  appendProgressLog,
  forgetExecutionProgress,
  formatProgressMessage,
  MAX_PROGRESS_LOGS,
  normalizeProgressFraction,
  PROGRESS_LOG_KIND,
  PROGRESS_NOTIFY_INTERVAL_MS,
  PROGRESS_PERSIST_INTERVAL_MS,
  reportTaskProgress,
} from "./execution-progress"

function makeTask(onProgress: boolean): ScheduledTask {
  return {
    id: "task-1",
    name: "Nightly index",
    type: "plugin",
    notification: { onStart: false, onComplete: true, onError: true, onProgress },
  } as unknown as ScheduledTask
}

function makeExecution(id = "exec-1"): TaskExecution {
  return {
    id,
    taskId: "task-1",
    taskName: "Nightly index",
    taskType: "plugin",
    status: "running",
    retryAttempt: 0,
    startedAt: new Date(0),
    logs: [],
  } as unknown as TaskExecution
}

beforeEach(() => {
  __resetExecutionProgressForTesting()
})

describe("normalizeProgressFraction", () => {
  it("keeps a 0–1 fraction as-is", () => {
    expect(normalizeProgressFraction(0.42)).toBeCloseTo(0.42)
  })

  it("reads a value above 1 as a percentage", () => {
    expect(normalizeProgressFraction(50)).toBeCloseTo(0.5)
  })

  it("clamps out-of-range and rejects non-numbers", () => {
    expect(normalizeProgressFraction(-3)).toBe(0)
    expect(normalizeProgressFraction(500)).toBe(1)
    expect(normalizeProgressFraction(Number.NaN)).toBeUndefined()
    expect(normalizeProgressFraction(undefined)).toBeUndefined()
  })
})

describe("formatProgressMessage", () => {
  it("combines percent and message", () => {
    expect(formatProgressMessage(0.5, "indexing")).toBe("50% — indexing")
  })

  it("falls back to whichever half was reported", () => {
    expect(formatProgressMessage(0.25, undefined)).toBe("25%")
    expect(formatProgressMessage(undefined, "warming up")).toBe("warming up")
    expect(formatProgressMessage(undefined, undefined)).toBe("in progress")
  })
})

describe("appendProgressLog", () => {
  it("caps progress entries without touching ordinary logs", () => {
    const logs = [
      { id: "boot", timestamp: new Date(0), level: "info", message: "Starting" },
    ] as TaskExecution["logs"]

    for (let i = 0; i < MAX_PROGRESS_LOGS + 10; i += 1) {
      appendProgressLog(logs, {
        id: `p${i}`,
        timestamp: new Date(0),
        level: "info",
        message: `${i}`,
        data: { kind: PROGRESS_LOG_KIND, progress: 0 },
      })
    }

    const progressEntries = logs.filter(
      (row) => (row.data as { kind?: string } | undefined)?.kind === PROGRESS_LOG_KIND
    )
    expect(progressEntries).toHaveLength(MAX_PROGRESS_LOGS)
    // The oldest progress entries went, the boot log stayed, and the newest
    // report survived.
    expect(logs[0].id).toBe("boot")
    expect(progressEntries.at(-1)!.id).toBe(`p${MAX_PROGRESS_LOGS + 9}`)
  })
})

describe("reportTaskProgress", () => {
  it("records the report on the execution and persists it", async () => {
    const persist = jest.fn(async () => {})
    const execution = makeExecution()

    reportTaskProgress(
      makeTask(false),
      execution,
      { progress: 0.5, message: "half" },
      {
        now: () => 10_000,
        persist,
        notify: jest.fn(async () => {}),
      }
    )

    expect(execution.logs).toHaveLength(1)
    expect(execution.logs[0].message).toBe("50% — half")
    expect(execution.logs[0].data).toEqual({ kind: PROGRESS_LOG_KIND, progress: 0.5 })
    expect(persist).toHaveBeenCalledWith(execution)
  })

  it("does not notify when the task did not opt in", () => {
    const notify = jest.fn(async () => {})
    reportTaskProgress(
      makeTask(false),
      makeExecution(),
      { progress: 1 },
      {
        now: () => 10_000,
        persist: jest.fn(async () => {}),
        notify,
      }
    )
    expect(notify).not.toHaveBeenCalled()
  })

  it("notifies once per rate-limit window when the task opted in", () => {
    const notify = jest.fn(async () => {})
    const persist = jest.fn(async () => {})
    const task = makeTask(true)
    const execution = makeExecution()
    let clock = 1_000_000

    const tick = () =>
      reportTaskProgress(
        task,
        execution,
        { progress: 0.1 },
        {
          now: () => clock,
          persist,
          notify,
        }
      )

    tick()
    expect(notify).toHaveBeenCalledTimes(1)

    clock += PROGRESS_NOTIFY_INTERVAL_MS - 1
    tick()
    expect(notify).toHaveBeenCalledTimes(1)

    clock += 2
    tick()
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it("coalesces writes instead of hitting storage on every report", () => {
    jest.useFakeTimers()
    try {
      const persist = jest.fn(async () => {})
      const task = makeTask(false)
      const execution = makeExecution("exec-burst")
      const start = 5_000_000
      let clock = start

      reportTaskProgress(task, execution, { progress: 0.1 }, { now: () => clock, persist })
      expect(persist).toHaveBeenCalledTimes(1)

      // Three more reports inside the window collapse into ONE trailing write.
      clock += 50
      reportTaskProgress(task, execution, { progress: 0.2 }, { now: () => clock, persist })
      clock += 50
      reportTaskProgress(task, execution, { progress: 0.3 }, { now: () => clock, persist })
      expect(persist).toHaveBeenCalledTimes(1)

      jest.advanceTimersByTime(PROGRESS_PERSIST_INTERVAL_MS)
      expect(persist).toHaveBeenCalledTimes(2)
      // …and the trailing write carries the newest state, not the stale one.
      expect(execution.logs.at(-1)!.message).toBe("30%")
    } finally {
      jest.useRealTimers()
    }
  })

  it("starts a fresh rate-limit window after the execution is forgotten", () => {
    const notify = jest.fn(async () => {})
    const task = makeTask(true)
    const execution = makeExecution("exec-cycle")

    reportTaskProgress(
      task,
      execution,
      { progress: 0.1 },
      {
        now: () => 2_000_000,
        persist: jest.fn(async () => {}),
        notify,
      }
    )
    forgetExecutionProgress(execution.id)
    reportTaskProgress(
      task,
      execution,
      { progress: 0.2 },
      {
        now: () => 2_000_100,
        persist: jest.fn(async () => {}),
        notify,
      }
    )

    expect(notify).toHaveBeenCalledTimes(2)
  })
})
