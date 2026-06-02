import { runConfiguredEval, filterCases, type RunConfiguredDeps } from "./run-config"
import type { EvalCase, EvalDataset, EvalSample, Scorer } from "@/types/eval/eval"
import type { TargetSpec } from "@/types/eval/run-config"
import type { EvalTarget } from "./runner"

function caseRow(over: Partial<EvalCase>): EvalCase {
  return {
    id: "c1",
    datasetId: "d",
    input: "hi",
    capability: "chat",
    source: "handwritten",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

const sample: EvalSample = {
  output: "ok",
  toolCalls: [],
  retrievedChunks: [],
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0.001,
  latencyMs: 5,
  stepCount: 1,
  degraded: false,
}

const passScorer: Scorer = {
  id: "always-pass",
  dimension: "response-quality",
  requiresLlm: false,
  score: () => ({ scorerId: "always-pass", dimension: "response-quality", value: 1, passed: true }),
}

const dataset: EvalDataset = {
  id: "d",
  name: "D",
  capability: "chat",
  version: 3,
  createdAt: 0,
  updatedAt: 0,
}

describe("filterCases", () => {
  const cases = [
    caseRow({ id: "a", split: "test", capability: "chat", failureMode: "x" }),
    caseRow({ id: "b", split: "train", capability: "rag" }),
    caseRow({ id: "c", split: "test", capability: "rag", failureMode: "y" }),
  ]
  it("returns all when no subset", () => {
    expect(filterCases(cases).length).toBe(3)
  })
  it("filters by split / capability / failureMode / ids (AND)", () => {
    expect(filterCases(cases, { split: "test" }).map((c) => c.id)).toEqual(["a", "c"])
    expect(filterCases(cases, { capabilities: ["rag"] }).map((c) => c.id)).toEqual(["b", "c"])
    expect(filterCases(cases, { failureModes: ["y"] }).map((c) => c.id)).toEqual(["c"])
    expect(filterCases(cases, { caseIds: ["a", "b"] }).map((c) => c.id)).toEqual(["a", "b"])
    expect(filterCases(cases, { split: "test", capabilities: ["rag"] }).map((c) => c.id)).toEqual([
      "c",
    ])
  })
})

describe("runConfiguredEval", () => {
  function makeDeps(over: Partial<RunConfiguredDeps> = {}): {
    deps: RunConfiguredDeps
    saved: ReturnType<typeof jest.fn>
    savedCases: ReturnType<typeof jest.fn>
    snapshot: ReturnType<typeof jest.fn>
  } {
    const saved = jest.fn(async () => {})
    const savedCases = jest.fn(async () => {})
    const snapshot = jest.fn(async () => ({
      id: "ver_1",
      datasetId: "d",
      version: 3,
      cases: [],
      casesHash: "h",
      createdAt: 0,
    }))
    let n = 0
    const target: EvalTarget = { label: "tgt", run: async () => sample }
    const deps: RunConfiguredDeps = {
      loadDataset: async () => dataset,
      loadCases: async () => [caseRow({ id: "a" }), caseRow({ id: "b" }), caseRow({ id: "c" })],
      snapshot,
      buildTarget: () => target,
      allScorers: [passScorer],
      saveRun: saved,
      saveCaseResult: savedCases,
      now: () => 123,
      newRunId: () => `run_${n++}`,
      ...over,
    }
    return { deps, saved, savedCases, snapshot }
  }

  it("snapshots once and produces one pinned report per target", async () => {
    const { deps, saved, snapshot } = makeDeps()
    const targets: TargetSpec[] = [
      { kind: "chat", label: "A", model: "m1" },
      { kind: "chat", label: "B", model: "m2" },
    ]
    const reports = await runConfiguredEval("d", { targets, scorerIds: [], k: 1 }, deps)
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(saved).toHaveBeenCalledTimes(2)
    expect(reports).toHaveLength(2)
    expect(reports[0].datasetVersionId).toBe("ver_1")
    expect(reports[0].config?.targetKind).toBe("chat")
  })

  it("persists a per-case verdict row for every case×target", async () => {
    const { deps, savedCases } = makeDeps()
    await runConfiguredEval(
      "d",
      { targets: [{ kind: "chat", label: "A", model: "m" }], scorerIds: [], k: 1 },
      deps
    )
    // 3 cases × 1 target
    expect(savedCases).toHaveBeenCalledTimes(3)
    const firstRow = savedCases.mock.calls[0][0] as {
      passAt1: boolean
      scores: Record<string, unknown>
    }
    expect(firstRow.passAt1).toBe(true)
    expect(firstRow.scores["always-pass"]).toEqual({ value: 1, passed: true })
  })

  it("applies the case subset before running", async () => {
    const target: EvalTarget = { label: "t", run: jest.fn(async () => sample) }
    const { deps } = makeDeps({ buildTarget: () => target })
    await runConfiguredEval(
      "d",
      {
        targets: [{ kind: "chat", label: "A", model: "m" }],
        scorerIds: [],
        k: 1,
        subset: { caseIds: ["b"] },
      },
      deps
    )
    expect((target.run as jest.Mock).mock.calls).toHaveLength(1) // only case "b"
  })

  it("throws on a missing dataset", async () => {
    const { deps } = makeDeps({ loadDataset: async () => undefined })
    await expect(
      runConfiguredEval("nope", { targets: [], scorerIds: [], k: 1 }, deps)
    ).rejects.toThrow(/not found/)
  })
})
