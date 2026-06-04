/** Service facade — progress fan-out + gate verdicts over runConfiguredEval. */
import { runEvalService, listDatasetSummaries, getRunDetail } from "./service"
import type { RunConfiguredDeps } from "./run-config"
import type { EvalCase, EvalDataset, Scorer } from "@/types/eval/eval"

jest.mock("@/lib/db/eval-datasets", () => ({
  listDatasets: jest.fn(async () => [
    { id: "d1", name: "DS", capability: "chat", version: 3, createdAt: 1, updatedAt: 2 },
  ]),
  listCases: jest.fn(async () => [{ id: "c1" }, { id: "c2" }]),
}))
jest.mock("@/lib/db/eval-runs", () => ({
  getRun: jest.fn(async (id: string) =>
    id === "r1" ? { runId: "r1", datasetId: "d1", passAt1: 1 } : undefined
  ),
  listRunsByDataset: jest.fn(async () => [
    { runId: "r1", passAt1: 1, createdAt: 9, targetLabel: "m" },
  ]),
}))
jest.mock("@/lib/db/eval-run-cases", () => ({
  listCaseResults: jest.fn(async () => [
    { id: "r1::c1", runId: "r1", caseId: "c1", scores: {}, passAt1: true },
  ]),
}))

const dataset: EvalDataset = {
  id: "d1",
  name: "DS",
  capability: "chat",
  version: 3,
  createdAt: 1,
  updatedAt: 2,
  gate: { minPassAt1: 0.99 },
}
const cases: EvalCase[] = [
  {
    id: "c1",
    datasetId: "d1",
    input: "hi",
    capability: "chat",
    source: "handwritten",
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "c2",
    datasetId: "d1",
    input: "yo",
    capability: "chat",
    source: "handwritten",
    createdAt: 1,
    updatedAt: 1,
  },
]
const passScorer: Scorer = {
  id: "assertion",
  dimension: "response-quality",
  requiresLlm: false,
  score: () => ({ scorerId: "assertion", dimension: "response-quality", value: 1, passed: true }),
}

function makeDeps(): RunConfiguredDeps {
  let n = 0
  return {
    loadDataset: async () => dataset,
    loadCases: async () => cases,
    snapshot: async () => ({ id: "v1", datasetId: "d1", version: 3, createdAt: 1, cases }) as never,
    buildTarget: () => ({
      label: "t",
      run: async () => ({
        output: "ok",
        toolCalls: [],
        retrievedChunks: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        costUsd: 0,
        latencyMs: 1,
        stepCount: 1,
        degraded: false,
      }),
    }),
    allScorers: [passScorer],
    saveRun: async () => {},
    saveCaseResult: async () => {},
    now: () => 123,
    newRunId: () => `run_${++n}`,
  }
}

describe("runEvalService", () => {
  it("runs, reports progress per case, and gates each report", async () => {
    const ticks: Array<{ done: number; total: number; passing: number }> = []
    const res = await runEvalService({
      datasetId: "d1",
      config: { targets: [{ kind: "chat", label: "t", model: "m" }], scorerIds: [], k: 1 },
      appSettings: null,
      deps: makeDeps(),
      onProgress: (p) => ticks.push({ ...p }),
    })
    expect(res.reports).toHaveLength(1)
    expect(ticks).toEqual([
      { done: 1, total: 2, passing: 1 },
      { done: 2, total: 2, passing: 2 },
    ])
    expect(res.gates?.["run_1"]?.passed).toBe(true)
    expect(res.gatePassed).toBe(true)
  })

  it("throws on unknown dataset", async () => {
    const deps = { ...makeDeps(), loadDataset: async () => undefined }
    await expect(
      runEvalService({
        datasetId: "ghost",
        config: { targets: [], scorerIds: [], k: 1 },
        appSettings: null,
        deps,
      })
    ).rejects.toThrow(/not found/)
  })

  it("omits gates when the dataset has no thresholds", async () => {
    const deps = { ...makeDeps(), loadDataset: async () => ({ ...dataset, gate: undefined }) }
    const res = await runEvalService({
      datasetId: "d1",
      config: { targets: [{ kind: "chat", label: "t", model: "m" }], scorerIds: [], k: 1 },
      appSettings: null,
      deps,
    })
    expect(res.gates).toBeUndefined()
    expect(res.gatePassed).toBeUndefined()
  })

  it("flags gatePassed=false when any report misses a threshold", async () => {
    const failingDataset = { ...dataset, gate: { minPassAt1: 2 } }
    const deps = { ...makeDeps(), loadDataset: async () => failingDataset }
    const res = await runEvalService({
      datasetId: "d1",
      config: { targets: [{ kind: "chat", label: "t", model: "m" }], scorerIds: [], k: 1 },
      appSettings: null,
      deps,
    })
    expect(res.gatePassed).toBe(false)
    expect(res.gates?.["run_1"]?.failures.length).toBeGreaterThan(0)
  })
})

describe("queries", () => {
  it("listDatasetSummaries folds case count and latest run", async () => {
    const rows = await listDatasetSummaries()
    expect(rows).toEqual([
      expect.objectContaining({
        id: "d1",
        caseCount: 2,
        latestRun: expect.objectContaining({ runId: "r1" }),
      }),
    ])
  })

  it("getRunDetail joins report and per-case rows", async () => {
    const detail = await getRunDetail("r1")
    expect(detail?.report.runId).toBe("r1")
    expect(detail?.cases).toHaveLength(1)
    expect(await getRunDetail("nope")).toBeUndefined()
  })
})
