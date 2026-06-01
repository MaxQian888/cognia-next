import type {
  EvalCase,
  EvalDataset,
  EvalReport,
  EvalSample,
  Score,
  Scorer,
} from "@/types/eval/eval"
import { runDatasetById, type RunControllerDeps } from "./run-controller"
import type { EvalTarget } from "./runner"

function dataset(): EvalDataset {
  return {
    id: "d1",
    name: "DS",
    capability: "chat.tool-use",
    version: 4,
    createdAt: 0,
    updatedAt: 0,
  }
}
function makeCase(id: string): EvalCase {
  return {
    id,
    datasetId: "d1",
    input: "x",
    capability: "chat.tool-use",
    source: "handwritten",
    createdAt: 0,
    updatedAt: 0,
  }
}
function sample(): EvalSample {
  return {
    output: "ok",
    toolCalls: [],
    retrievedChunks: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    costUsd: 0,
    latencyMs: 1,
    stepCount: 1,
    degraded: false,
  }
}
const passScorer: Scorer = {
  id: "s",
  dimension: "tool-use",
  requiresLlm: false,
  score(): Score {
    return { scorerId: "s", dimension: "tool-use", value: 1, passed: true }
  },
}

function deps(
  overrides: Partial<RunControllerDeps> = {}
): RunControllerDeps & { saved: EvalReport[] } {
  const saved: EvalReport[] = []
  const target: EvalTarget = { label: "opus", run: async () => sample() }
  return {
    saved,
    loadDataset: async () => dataset(),
    loadCases: async () => [makeCase("a"), makeCase("b")],
    saveRun: async (r) => {
      saved.push(r)
    },
    scorers: [passScorer],
    target,
    now: () => 555,
    newRunId: () => "run-fixed",
    ...overrides,
  }
}

describe("runDatasetById", () => {
  it("loads the dataset + cases, runs, and persists the report", async () => {
    const d = deps()
    const report = await runDatasetById("d1", d)
    expect(report.runId).toBe("run-fixed")
    expect(report.datasetVersion).toBe(4)
    expect(report.caseCount).toBe(2)
    expect(report.createdAt).toBe(555)
    expect(d.saved).toHaveLength(1)
    expect(d.saved[0].runId).toBe("run-fixed")
  })

  it("throws when the dataset is missing", async () => {
    const d = deps({ loadDataset: async () => undefined })
    await expect(runDatasetById("ghost", d)).rejects.toThrow(/not found/)
  })

  it("forwards k and onCaseComplete", async () => {
    const d = deps()
    const indices: number[] = []
    const report = await runDatasetById("d1", d, {
      k: 2,
      onCaseComplete: (_r, i) => indices.push(i),
    })
    expect(report.k).toBe(2)
    expect(indices).toEqual([0, 1])
  })
})
