/**
 * Tests for the calibration runner. A scripted fake judge stands in for the LLM
 * so the run is deterministic and offline; the default-deps (real
 * `buildRendererLlmClient`) path is exercised separately via mock.
 */

import type { Scorer, Score } from "@/types/eval/eval"
import type { CalibrationItemRow } from "@/lib/db/calibration-items"
import type { CalibrationRunRow } from "@/lib/db/calibration-runs"
import {
  runCalibration,
  buildCalibrationRunDeps,
  CalibrationNoJudgeError,
  type CalibrationRunDeps,
} from "./runner"

jest.mock("@/lib/ai/renderer-llm-client", () => ({
  buildRendererLlmClient: jest.fn(),
}))
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"

function item(overrides: Partial<CalibrationItemRow> = {}): CalibrationItemRow {
  return {
    id: "i1",
    setId: "set-a",
    criterion: "task completion",
    rubric: "Pass only if complete.",
    input: "q",
    output: "a",
    goldLabel: "pass",
    source: "handwritten",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/** A judge that returns a scripted verdict per item id. */
function scriptedJudge(
  verdicts: Record<string, { passed?: boolean; error?: string; reasoning?: string }>
): Scorer {
  return {
    id: "judge-task-completion",
    dimension: "response-quality",
    requiresLlm: true,
    score(_sample, evalCase): Score {
      const v = verdicts[evalCase.id] ?? { passed: false }
      return {
        scorerId: "judge-task-completion",
        dimension: "response-quality",
        value: v.passed ? 1 : 0,
        passed: v.passed ?? false,
        ...(v.reasoning ? { reasoning: v.reasoning } : {}),
        ...(v.error ? { error: v.error } : {}),
      }
    },
  }
}

function makeDeps(
  items: CalibrationItemRow[],
  judge: Scorer,
  saved: CalibrationRunRow[]
): CalibrationRunDeps {
  return {
    loadItems: async () => items,
    saveRun: async (row) => {
      saved.push(row)
    },
    makeJudge: () => judge,
    judgeModel: "claude-sonnet-4-6",
    now: () => 1000,
    newRunId: () => "calrun_test",
  }
}

describe("runCalibration", () => {
  it("scores each item, builds metrics, and persists the run", async () => {
    const items = [
      item({ id: "i1", goldLabel: "pass" }),
      item({ id: "i2", goldLabel: "fail" }),
      item({ id: "i3", goldLabel: "pass" }),
      item({ id: "i4", goldLabel: "fail" }),
    ]
    // judge agrees on i1/i2, disagrees on i3 (gold pass, judge fail) and i4 (gold fail, judge pass)
    const judge = scriptedJudge({
      i1: { passed: true },
      i2: { passed: false },
      i3: { passed: false, reasoning: "missed a step" },
      i4: { passed: true },
    })
    const saved: CalibrationRunRow[] = []
    const row = await runCalibration({
      setId: "set-a",
      appSettings: null,
      deps: makeDeps(items, judge, saved),
    })

    expect(saved).toHaveLength(1)
    expect(row.runId).toBe("calrun_test")
    expect(row.itemCount).toBe(4)
    expect(row.scoredCount).toBe(4)
    expect(row.erroredCount).toBe(0)
    expect(row.metrics.matrix).toEqual({ tp: 1, fp: 1, tn: 1, fn: 1 })
    expect(row.criterion).toBe("task completion")
    expect(row.judgeModel).toBe("claude-sonnet-4-6")
    // disagreement reasoning is preserved
    expect(row.verdicts.find((v) => v.itemId === "i3")?.reasoning).toBe("missed a step")
  })

  it("excludes errored (fail-open) verdicts from metrics but records them", async () => {
    const items = [
      item({ id: "i1", goldLabel: "pass" }),
      item({ id: "i2", goldLabel: "fail" }),
      item({ id: "i3", goldLabel: "pass" }),
    ]
    const judge = scriptedJudge({
      i1: { passed: true },
      i2: { passed: false },
      i3: { error: "judge parse error" },
    })
    const saved: CalibrationRunRow[] = []
    const row = await runCalibration({
      setId: "set-a",
      appSettings: null,
      deps: makeDeps(items, judge, saved),
    })

    expect(row.itemCount).toBe(3)
    expect(row.scoredCount).toBe(2)
    expect(row.erroredCount).toBe(1)
    expect(row.metrics.n).toBe(2)
    const erroredVerdict = row.verdicts.find((v) => v.itemId === "i3")
    expect(erroredVerdict).toMatchObject({
      errored: true,
      error: "judge parse error",
      judgePassed: false,
    })
  })

  it("handles an empty set with null metrics and no throw", async () => {
    const saved: CalibrationRunRow[] = []
    const row = await runCalibration({
      setId: "set-a",
      appSettings: null,
      deps: makeDeps([], scriptedJudge({}), saved),
    })
    expect(row.itemCount).toBe(0)
    expect(row.metrics.n).toBe(0)
    expect(row.metrics.cohenKappa).toBeNull()
    expect(row.criterion).toBe("")
    expect(saved).toHaveLength(1)
  })

  it("reports progress per item", async () => {
    const items = [item({ id: "i1" }), item({ id: "i2" })]
    const progress: Array<{ done: number; total: number }> = []
    await runCalibration({
      setId: "set-a",
      appSettings: null,
      onProgress: (p) => progress.push(p),
      deps: makeDeps(items, scriptedJudge({ i1: { passed: true }, i2: { passed: true } }), []),
    })
    expect(progress).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ])
  })

  it("throws AbortError and saves nothing when the signal is already aborted", async () => {
    const saved: CalibrationRunRow[] = []
    const controller = new AbortController()
    controller.abort()
    await expect(
      runCalibration({
        setId: "set-a",
        appSettings: null,
        signal: controller.signal,
        deps: makeDeps([item()], scriptedJudge({ i1: { passed: true } }), saved),
      })
    ).rejects.toThrow("aborted")
    expect(saved).toHaveLength(0)
  })
})

describe("buildCalibrationRunDeps", () => {
  const mockBuild = buildRendererLlmClient as jest.MockedFunction<typeof buildRendererLlmClient>
  afterEach(() => mockBuild.mockReset())

  it("throws CalibrationNoJudgeError when no judge client resolves", () => {
    mockBuild.mockReturnValue(null)
    expect(() => buildCalibrationRunDeps(null)).toThrow(CalibrationNoJudgeError)
  })

  it("wires a judge-backed deps bundle when a client resolves", () => {
    mockBuild.mockReturnValue({ complete: jest.fn() } as never)
    const deps = buildCalibrationRunDeps(null, "claude-sonnet-4-6")
    expect(deps.judgeModel).toBe("claude-sonnet-4-6")
    const judge = deps.makeJudge("task completion", "rubric")
    expect(judge.id).toBe("judge-task-completion")
    expect(mockBuild).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: "eval-calibration", modelOverride: "claude-sonnet-4-6" })
    )
  })

  it("defaults the judgeModel label when none is given", () => {
    mockBuild.mockReturnValue({ complete: jest.fn() } as never)
    const deps = buildCalibrationRunDeps(null)
    expect(deps.judgeModel).toBe("(resolver default)")
  })

  it("wires now() and a calrun_-prefixed id generator", () => {
    mockBuild.mockReturnValue({ complete: jest.fn() } as never)
    const deps = buildCalibrationRunDeps(null)
    expect(typeof deps.now()).toBe("number")
    expect(deps.newRunId()).toMatch(/^calrun_/)
  })
})
