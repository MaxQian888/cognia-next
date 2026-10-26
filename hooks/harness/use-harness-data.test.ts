/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"
import { makeRun, makeRunConfig } from "@/lib/harness/test-fixtures"
import type { HarnessEvolutionStep } from "@/types/harness/evolution"

// useLiveQuery mock resolves nothing asynchronously: it runs the querier and
// hands back a value the test placed in `resolved` for that querier's result.
const resolved = new Map<unknown, unknown>()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (querier: () => unknown, _deps: unknown[], fallback?: unknown) => {
    const result = querier()
    return resolved.has(result) ? resolved.get(result) : fallback
  },
}))

const db = {
  listHarnessRuns: jest.fn(),
  getHarnessRun: jest.fn(),
  listHarnessSteps: jest.fn(),
  getHarnessSnapshots: jest.fn(),
  listHarnessSnapshots: jest.fn(),
  listHarnessExperiences: jest.fn(),
}
jest.mock("@/lib/db/harness-evolution", () => ({
  listHarnessRuns: (...a: unknown[]) => db.listHarnessRuns(...a),
  getHarnessRun: (...a: unknown[]) => db.getHarnessRun(...a),
  listHarnessSteps: (...a: unknown[]) => db.listHarnessSteps(...a),
  getHarnessSnapshots: (...a: unknown[]) => db.getHarnessSnapshots(...a),
  listHarnessSnapshots: (...a: unknown[]) => db.listHarnessSnapshots(...a),
  listHarnessExperiences: (...a: unknown[]) => db.listHarnessExperiences(...a),
}))
const listUsageForSession = jest.fn()
jest.mock("@/lib/db/session-usage", () => ({
  listUsageForSession: (id: string) => listUsageForSession(id),
}))
let storedSettings: unknown
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: { harnessEvolution: storedSettings } }),
}))

import {
  useAgentHarnessSnapshots,
  useHarnessEvolutionSettings,
  useHarnessExperiences,
  useHarnessLiveLedger,
  useHarnessRun,
  useHarnessRuns,
  useHarnessSnapshots,
  useHarnessSteps,
} from "./use-harness-data"

/** Make `fn` return a token and resolve the live query to `value`. */
function answer(fn: jest.Mock, value: unknown) {
  const token = { token: fn.getMockName() }
  fn.mockReturnValue(token)
  resolved.set(token, value)
}

beforeEach(() => {
  resolved.clear()
  jest.clearAllMocks()
  storedSettings = undefined
})

describe("useHarnessEvolutionSettings", () => {
  it("normalises stored settings over the defaults", () => {
    storedSettings = { enabled: true, startMode: "manual" }
    const { result } = renderHook(() => useHarnessEvolutionSettings())
    expect(result.current).toMatchObject({ enabled: true, startMode: "manual" })
    storedSettings = undefined
    expect(renderHook(() => useHarnessEvolutionSettings()).result.current.enabled).toBe(false)
  })
})

describe("table hooks", () => {
  it("read runs, a run, steps and experiences with the right filters", () => {
    const run = makeRun({ id: "r1" })
    answer(db.listHarnessRuns, [run])
    expect(renderHook(() => useHarnessRuns("agent-1", 20)).result.current).toEqual([run])
    expect(db.listHarnessRuns).toHaveBeenCalledWith({ characterId: "agent-1", limit: 20 })
    renderHook(() => useHarnessRuns())
    expect(db.listHarnessRuns).toHaveBeenLastCalledWith({ limit: 100 })

    expect(renderHook(() => useHarnessSteps(undefined)).result.current).toEqual([])
    expect(db.listHarnessSteps).not.toHaveBeenCalled()
    answer(db.listHarnessSteps, ["step"])
    expect(renderHook(() => useHarnessSteps("r1")).result.current).toEqual(["step"])

    answer(db.listHarnessExperiences, ["exp"])
    expect(renderHook(() => useHarnessExperiences({ characterId: "a" })).result.current).toEqual([
      "exp",
    ])
    expect(db.listHarnessExperiences).toHaveBeenCalledWith({
      characterId: "a",
      includeDisabled: true,
    })
    renderHook(() => useHarnessExperiences({ includeDisabled: false }))
    expect(db.listHarnessExperiences).toHaveBeenLastCalledWith({ includeDisabled: false })
  })

  it("resolves a missing run to null and skips lookups without ids", async () => {
    db.getHarnessRun.mockResolvedValue(undefined)
    renderHook(() => useHarnessRun("gone"))
    expect(db.getHarnessRun).toHaveBeenCalledWith("gone")
    renderHook(() => useHarnessRun(undefined))
    expect(db.getHarnessRun).toHaveBeenCalledTimes(1)

    expect(renderHook(() => useAgentHarnessSnapshots(undefined)).result.current).toEqual([])
    answer(db.listHarnessSnapshots, ["snap"])
    expect(renderHook(() => useAgentHarnessSnapshots("a")).result.current).toEqual(["snap"])
  })

  it("looks up each snapshot id once, in a stable order", () => {
    const map = new Map([["s1", { id: "s1" }]])
    answer(db.getHarnessSnapshots, map)
    expect(renderHook(() => useHarnessSnapshots(["s2", "s1", "s2"])).result.current).toBe(map)
    expect(db.getHarnessSnapshots).toHaveBeenCalledWith(["s1", "s2"])
    expect(renderHook(() => useHarnessSnapshots([])).result.current.size).toBe(0)
    expect(db.getHarnessSnapshots).toHaveBeenCalledTimes(1)
  })
})

describe("useHarnessLiveLedger", () => {
  const step = (label: string, over: Partial<HarnessEvolutionStep> = {}): HarnessEvolutionStep => ({
    id: `r1:${label}`,
    runId: "r1",
    label,
    kind: "rollout",
    status: "succeeded",
    attempts: 1,
    inputTokens: 0,
    outputTokens: 0,
    modelCalls: 0,
    updatedAt: 1,
    ...over,
  })

  it("folds the run's usage rows as they land", () => {
    const run = makeRun({
      id: "r1",
      startedAt: 10,
      config: makeRunConfig({ mode: "parallel", k: 1 }),
    })
    answer(listUsageForSession, [
      {
        messageId: "harness-evolution:harness:r1:base1:1",
        inputTokens: 100,
        outputTokens: 10,
        costUsd: 0.5,
      },
      {
        messageId: "harness-evolution:harness:r1:inv1:1:1",
        inputTokens: 50,
        outputTokens: 5,
        costUsd: 0.25,
      },
      {
        messageId: "harness-evolution:harness:other:inv1:1",
        inputTokens: 9,
        outputTokens: 9,
        costUsd: 9,
      },
    ])
    const steps = [
      step("base1"),
      step("inv1", { kind: "propose" }),
      step("roll:inv1", { cacheHitOf: "r1:base1" }),
    ]
    const { result } = renderHook(() => useHarnessLiveLedger(run, steps))
    expect(listUsageForSession).toHaveBeenCalledWith("harness:r1")
    expect(result.current).toMatchObject({
      costUsd: 0.75,
      inputTokens: 150,
      outputTokens: 15,
      modelCalls: 1,
      rollouts: 1,
      sessions: 1,
      startedAt: 10,
    })
  })

  it("falls back to the stored ledger until rows load, and to nothing without a run", () => {
    const run = makeRun({ id: "r1" })
    listUsageForSession.mockReturnValue({ pending: true })
    expect(renderHook(() => useHarnessLiveLedger(run, [])).result.current).toBe(run.ledger)
    expect(renderHook(() => useHarnessLiveLedger(undefined, [])).result.current).toBeUndefined()
  })
})
