/** Eval workflow node executors (`eval.run`, `eval.gate`). */
import "."
import { getExecutor } from "../registry"
import { buildTargetSpec } from "."

jest.mock("@/lib/ai/eval/service", () => ({
  runEvalService: jest.fn(async () => ({
    reports: [{ runId: "r1", passAt1: 0.9, passHatK: 0.8, totalCostUsd: 0.4 }],
    gates: { r1: { passed: true, failures: [] } },
    gatePassed: true,
    deterministicOnly: true,
  })),
}))
jest.mock("@/lib/db/eval-runs", () => ({
  getRun: jest.fn(async (id: string) => {
    if (id === "r1") {
      return {
        runId: "r1",
        datasetId: "d1",
        passAt1: 0.9,
        passHatK: 0.8,
        totalCostUsd: 0.4,
        scorers: {},
      }
    }
    if (id === "r-ungraded") {
      // Nothing gradable: `passAt1` is 0 because no case produced a verdict.
      return {
        runId: "r-ungraded",
        datasetId: "d1",
        caseCount: 4,
        gradedCaseCount: 0,
        ungradedCaseCount: 4,
        passAt1: 0,
        passHatK: 0,
        totalCostUsd: 0.4,
        scorers: {},
      }
    }
    return undefined
  }),
}))
jest.mock("@/lib/db/eval-datasets", () => ({
  getDataset: jest.fn(async () => ({ id: "d1", gate: { minPassAt1: 0.95 } })),
}))
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: () => ({ settings: null }) },
}))

import { runEvalService } from "@/lib/ai/eval/service"

function ctx(params: Record<string, unknown>) {
  return {
    runId: "wfrun",
    workflowId: "wf",
    stepId: "s1",
    params,
    upstream: {},
    trigger: { type: "manual" },
    signal: new AbortController().signal,
    log: jest.fn(),
    resolveSecret: async () => undefined,
  } as never
}

beforeEach(() => {
  ;(runEvalService as jest.Mock).mockClear()
})

describe("eval.run", () => {
  it("registers and runs a single chat target, returning rates + gate", async () => {
    const exec = getExecutor("eval.run", 1)!
    expect(exec).toBeDefined()
    const res = await exec.execute(ctx({ datasetId: "d1", model: "claude-opus-4-8", k: 2 }))
    expect(runEvalService).toHaveBeenCalledWith(
      expect.objectContaining({
        datasetId: "d1",
        config: expect.objectContaining({
          k: 2,
          targets: [expect.objectContaining({ kind: "chat", model: "claude-opus-4-8" })],
        }),
        signal: expect.any(AbortSignal),
      })
    )
    expect(res.output).toEqual(
      expect.objectContaining({
        runIds: ["r1"],
        passAt1: 0.9,
        passHatK: 0.8,
        totalCostUsd: 0.4,
        gatePassed: true,
      })
    )
  })

  it("builds team / workflow targets and a subset from params", async () => {
    const exec = getExecutor("eval.run", 1)!
    await exec.execute(
      ctx({
        datasetId: "d1",
        targetKind: "team",
        teamId: "tm1",
        split: "test",
        capabilities: ["a"],
      })
    )
    expect(runEvalService).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          targets: [expect.objectContaining({ kind: "team", teamId: "tm1" })],
          subset: { split: "test", capabilities: ["a"] },
        }),
      })
    )
  })

  it("throws without datasetId or a target ref", async () => {
    const exec = getExecutor("eval.run", 1)!
    await expect(exec.execute(ctx({}))).rejects.toThrow(/datasetId/)
    await expect(exec.execute(ctx({ datasetId: "d1" }))).rejects.toThrow(/model/)
    await expect(exec.execute(ctx({ datasetId: "d1", targetKind: "team" }))).rejects.toThrow(
      /teamId/
    )
    await expect(exec.execute(ctx({ datasetId: "d1", targetKind: "workflow" }))).rejects.toThrow(
      /workflowId/
    )
  })

  it("buildTargetSpec defaults labels to the ref", () => {
    expect(buildTargetSpec({ model: "m" })).toEqual({ kind: "chat", label: "m", model: "m" })
    expect(buildTargetSpec({ targetKind: "workflow", workflowId: "w", label: "W" })).toEqual({
      kind: "workflow",
      label: "W",
      workflowId: "w",
    })
  })
})

describe("eval.gate", () => {
  it("gates a run against param thresholds (override wins over dataset gate)", async () => {
    const exec = getExecutor("eval.gate", 1)!
    const res = await exec.execute(ctx({ runId: "r1", minPassAt1: 0.8 }))
    expect(res.output).toEqual({
      passed: true,
      verdict: "pass",
      failures: [],
      inconclusiveReasons: [],
    })
    expect(res.decision).toBe("pass")
  })

  it("routes an inconclusive run to the fail branch, on purpose", async () => {
    // The gate is tri-state but this node has two branches. A run that graded
    // nothing must not proceed down `pass`, so it fails closed — while the
    // output still says `inconclusive` rather than pretending the agent failed.
    const exec = getExecutor("eval.gate", 1)!
    const res = await exec.execute(ctx({ runId: "r-ungraded", minPassAt1: 0.8 }))
    expect(res.decision).toBe("fail")
    expect((res.output as { verdict: string }).verdict).toBe("inconclusive")
    expect((res.output as { failures: string[] }).failures).toHaveLength(0)
    expect(
      (res.output as { inconclusiveReasons: string[] }).inconclusiveReasons.join(" ")
    ).toContain("no case produced a verdict")
  })

  it("falls back to the dataset gate and reports failures", async () => {
    const exec = getExecutor("eval.gate", 1)!
    const res = await exec.execute(ctx({ runId: "r1" })) // dataset gate 0.95 > 0.9
    expect((res.output as { passed: boolean }).passed).toBe(false)
    expect(res.decision).toBe("fail")
  })

  it("throws on unknown run or missing runId", async () => {
    const exec = getExecutor("eval.gate", 1)!
    await expect(exec.execute(ctx({ runId: "ghost" }))).rejects.toThrow(/not found/)
    await expect(exec.execute(ctx({}))).rejects.toThrow(/runId/)
  })

  it("throws when neither params nor the dataset define thresholds", async () => {
    const { getDataset } = jest.requireMock("@/lib/db/eval-datasets") as {
      getDataset: jest.Mock
    }
    getDataset.mockResolvedValueOnce({ id: "d1" }) // no gate field
    const exec = getExecutor("eval.gate", 1)!
    await expect(exec.execute(ctx({ runId: "r1" }))).rejects.toThrow(/no thresholds/)
  })
})

describe("eval.run output without a configured gate", () => {
  it("omits gatePassed and defaults k to 1 for non-numeric values", async () => {
    ;(runEvalService as jest.Mock).mockResolvedValueOnce({
      reports: [{ runId: "r2", passAt1: 1, passHatK: 1, totalCostUsd: 0 }],
      deterministicOnly: true,
    })
    const exec = getExecutor("eval.run", 1)!
    const res = await exec.execute(ctx({ datasetId: "d1", model: "m", k: "three" }))
    expect(runEvalService).toHaveBeenCalledWith(
      expect.objectContaining({ config: expect.objectContaining({ k: 1 }) })
    )
    expect(res.output).not.toHaveProperty("gatePassed")
  })

  it("throws when the service produces no report", async () => {
    ;(runEvalService as jest.Mock).mockResolvedValueOnce({ reports: [], deterministicOnly: true })
    const exec = getExecutor("eval.run", 1)!
    await expect(exec.execute(ctx({ datasetId: "d1", model: "m" }))).rejects.toThrow(/no report/)
  })
})
