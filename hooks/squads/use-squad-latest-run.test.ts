/** @jest-environment jsdom */

// The newest Squad run and its durable record. The read is tested directly
// against a fake table chain; the hook only adds the loading answer.

import { renderHook } from "@testing-library/react"

import type { ExecutionRun } from "@/types/execution/run"

let liveValue: unknown = undefined
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: () => liveValue,
}))

const getRecord = jest.fn()
let teamRuns: ExecutionRun[] = []
let throwOnDb = false
jest.mock("@/lib/db/schema", () => ({
  getDb: () => {
    if (throwOnDb) throw new Error("locked")
    return {
      executionRuns: {
        where: (index: string) => ({
          equals: (value: string) => ({
            filter: (predicate: (row: ExecutionRun) => boolean) => ({
              sortBy: async (key: keyof ExecutionRun) =>
                teamRuns
                  .filter((row) => (row as unknown as Record<string, unknown>)[index] === value)
                  .filter(predicate)
                  .sort((a, b) => Number(a[key]) - Number(b[key])),
            }),
          }),
        }),
      },
      agentTeamRuns: { get: (id: string) => getRecord(id) },
    }
  },
}))

import { readSquadLatestRun, useSquadLatestRun } from "./use-squad-latest-run"

function run(id: string, teamId: string, updatedAt: number, kind = "team"): ExecutionRun {
  return {
    id,
    kind,
    sourceId: id,
    title: id,
    status: "running",
    currentRevision: 1,
    startedAt: 1,
    updatedAt,
    latestSnapshot: { teamId } as ExecutionRun["latestSnapshot"],
  } as ExecutionRun
}

beforeEach(() => {
  liveValue = undefined
  teamRuns = []
  throwOnDb = false
  getRecord.mockReset().mockResolvedValue(undefined)
})

describe("readSquadLatestRun", () => {
  it("picks this Squad's most recently updated team run", async () => {
    teamRuns = [
      run("execution:team:old", "a", 10),
      run("execution:team:new", "a", 30),
      run("execution:team:other", "b", 50),
      run("execution:goal:x", "a", 99, "goal"),
    ]
    const result = await readSquadLatestRun("a")
    expect(result.run?.id).toBe("execution:team:new")
  })

  /** The durable record is keyed by the run id without the journal prefix. */
  it("reads the durable record behind the run", async () => {
    teamRuns = [run("execution:team:r1", "a", 10)]
    const record = { id: "r1", objective: "Ship it" }
    getRecord.mockResolvedValue(record)
    const result = await readSquadLatestRun("a")
    expect(getRecord).toHaveBeenCalledWith("r1")
    expect(result.record).toBe(record)
  })

  it("answers no record when this device does not carry one", async () => {
    teamRuns = [run("execution:team:r1", "a", 10)]
    expect((await readSquadLatestRun("a")).record).toBeNull()
  })

  it("answers nothing for a Squad that has never run", async () => {
    expect(await readSquadLatestRun("a")).toEqual({ run: null, record: null })
    expect(getRecord).not.toHaveBeenCalled()
  })

  /** A locked account has no database; a thrown read would pin a skeleton. */
  it("reads a locked database as no run", async () => {
    throwOnDb = true
    expect(await readSquadLatestRun("a")).toEqual({ run: null, record: null })
  })
})

describe("useSquadLatestRun", () => {
  it("is loading until the first read lands", () => {
    const { result } = renderHook(() => useSquadLatestRun("a"))
    expect(result.current).toEqual({ run: null, record: null, loading: true })
  })

  it("passes the read through once it lands", () => {
    const latest = run("execution:team:r1", "a", 10)
    liveValue = { run: latest, record: null }
    const { result } = renderHook(() => useSquadLatestRun("a"))
    expect(result.current).toEqual({ run: latest, record: null, loading: false })
  })
})
