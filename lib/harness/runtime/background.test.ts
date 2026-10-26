import type { AppSettings } from "@cognia/agent-config-types"
import type { HarnessEvolutionRun } from "@/types/harness/evolution"
import { makeRun } from "../test-fixtures"
import {
  QUEUED_RUN_MAX_AGE_MS,
  runHarnessEvolutionSweep,
  installHarnessEvolutionSweepSchedule,
  type HarnessSweepDependencies,
} from "./background"

const HOUR = 60 * 60_000
const NOW = 100 * 24 * HOUR

function settings(over: Record<string, unknown> = {}): AppSettings {
  return {
    harnessEvolution: {
      enabled: true,
      startMode: "background",
      backgroundIntervalHours: 6,
      backgroundMaxRunsPerSweep: 2,
      ...over,
    },
  } as unknown as AppSettings
}

function deps(runs: HarnessEvolutionRun[], over: Partial<HarnessSweepDependencies> = {}) {
  const launched: string[] = []
  const stored = new Map(runs.map((r) => [r.id, r]))
  const d: HarnessSweepDependencies = {
    now: () => NOW,
    getSettings: async () => settings(),
    hostOwnsSessions: () => false,
    listRuns: async () => [...stored.values()],
    saveRun: async (next, expected) => {
      if (stored.get(next.id)?.version !== expected) throw new Error("conflict")
      stored.set(next.id, next)
      return next
    },
    launch: (id) => void launched.push(id),
    ...over,
  }
  return { d, launched, stored }
}

const queued = (id: string, createdAt: number, over: Partial<HarnessEvolutionRun> = {}) =>
  makeRun({ id, trigger: "background", status: "queued", createdAt, ...over })

describe("runHarnessEvolutionSweep", () => {
  it("launches the oldest queued background runs up to the per-sweep limit", async () => {
    const { d, launched } = deps([
      queued("b", NOW - 2 * HOUR),
      queued("a", NOW - 3 * HOUR),
      queued("c", NOW - HOUR),
      makeRun({ id: "manual", trigger: "manual", status: "queued" }),
    ])
    expect(await runHarnessEvolutionSweep(d)).toEqual({
      queued: 3,
      launched: ["a", "b"],
      expired: [],
    })
    expect(launched).toEqual(["a", "b"])
  })

  it("waits for its interval and for room", async () => {
    const recent = makeRun({
      id: "done",
      trigger: "background",
      status: "completed",
      startedAt: NOW - HOUR,
    })
    expect(await runHarnessEvolutionSweep(deps([queued("a", NOW - HOUR), recent]).d)).toMatchObject(
      {
        launched: [],
        skipped: "interval",
      }
    )
    const busy = [
      makeRun({ id: "x", trigger: "background", status: "probing", startedAt: NOW - 10 * HOUR }),
      makeRun({ id: "y", trigger: "background", status: "proposing", startedAt: NOW - 10 * HOUR }),
    ]
    expect(
      await runHarnessEvolutionSweep(deps([queued("a", NOW - HOUR), ...busy]).d)
    ).toMatchObject({
      launched: [],
      skipped: "busy",
    })
    const old = makeRun({
      id: "done",
      trigger: "background",
      status: "completed",
      startedAt: NOW - 7 * HOUR,
    })
    expect(
      (await runHarnessEvolutionSweep(deps([queued("a", NOW - HOUR), old]).d)).launched
    ).toEqual(["a"])
  })

  it("cancels runs queued for more than a week", async () => {
    const { d, stored } = deps([
      queued("stale", NOW - QUEUED_RUN_MAX_AGE_MS - 1),
      queued("fresh", NOW - HOUR),
    ])
    const outcome = await runHarnessEvolutionSweep(d)
    expect(outcome).toMatchObject({ expired: ["stale"], launched: ["fresh"] })
    expect(stored.get("stale")).toMatchObject({
      status: "cancelled",
      error: expect.stringMatching(/Expired/),
    })
  })

  it("does nothing when off, not in background mode, or on a client whose Host owns the conversations", async () => {
    const runs = [queued("a", NOW - HOUR)]
    for (const over of [{ enabled: false }, { startMode: "failure-triggered" }]) {
      const { d, launched } = deps(runs, { getSettings: async () => settings(over) })
      expect((await runHarnessEvolutionSweep(d)).skipped).toBe("off")
      expect(launched).toEqual([])
    }
    const { d } = deps(runs, { hostOwnsSessions: () => true })
    expect((await runHarnessEvolutionSweep(d)).skipped).toBe("host-owned")
  })
})

jest.mock("@/lib/scheduler/task-scheduler", () => ({
  registerTaskExecutor: jest.fn(),
  getTaskScheduler: jest.fn(),
}))

it("installs the background sweep as a silent managed singleton", async () => {
  const { getTaskScheduler, registerTaskExecutor } = await import("@/lib/scheduler/task-scheduler")
  const createTask = jest.fn()
  jest
    .mocked(getTaskScheduler)
    .mockReturnValue({ getAllTasks: async () => [], createTask } as never)
  await installHarnessEvolutionSweepSchedule()
  expect(registerTaskExecutor).toHaveBeenCalledWith("harness-evolution-sweep", expect.any(Function))
  expect(createTask).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "system:harness-evolution-sweep",
      type: "harness-evolution-sweep",
      notification: expect.objectContaining({
        channels: ["none"],
        dueReminder: false,
        onError: false,
      }),
    })
  )
})
