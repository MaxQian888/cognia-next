import type { EvalCase, EvalDataset, EvalSample, Score, Scorer } from "@/types/eval/eval"
import { runDatasetEval } from "./index"
import type { EvalTarget } from "./runner"

function dataset(): EvalDataset {
  return {
    id: "d1",
    name: "Tool use",
    capability: "chat.tool-use",
    version: 7,
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
    costUsd: 0.01,
    latencyMs: 50,
    stepCount: 1,
    degraded: false,
  }
}

const passScorer: Scorer = {
  id: "s1",
  dimension: "tool-use",
  requiresLlm: false,
  gating: true,
  score(): Score {
    return { scorerId: "s1", dimension: "tool-use", status: "scored", value: 1, passed: true }
  },
}

describe("runDatasetEval", () => {
  it("runs the dataset and returns a report stamped with dataset + target identity", async () => {
    const target: EvalTarget = { label: "opus", run: async () => sample() }
    const { report, results } = await runDatasetEval({
      dataset: dataset(),
      cases: [makeCase("a"), makeCase("b")],
      scorers: [passScorer],
      target,
      runId: "run-1",
      now: 999,
    })
    expect(results).toHaveLength(2)
    expect(report.runId).toBe("run-1")
    expect(report.datasetId).toBe("d1")
    expect(report.datasetVersion).toBe(7)
    expect(report.targetLabel).toBe("opus")
    expect(report.createdAt).toBe(999)
    expect(report.passAt1).toBe(1)
  })

  it("forwards an abort signal to the runner", async () => {
    const controller = new AbortController()
    controller.abort()
    const target: EvalTarget = { label: "t", run: async () => sample() }
    const { results } = await runDatasetEval({
      dataset: dataset(),
      cases: [makeCase("a")],
      scorers: [passScorer],
      target,
      runId: "r",
      now: 1,
      signal: controller.signal,
    })
    expect(results).toHaveLength(0)
  })

  it("honors the k repetition count in the report", async () => {
    const target: EvalTarget = { label: "t", run: async () => sample() }
    const { report } = await runDatasetEval({
      dataset: dataset(),
      cases: [makeCase("a")],
      scorers: [passScorer],
      target,
      runId: "r",
      now: 1,
      k: 3,
    })
    expect(report.k).toBe(3)
  })
})
