import { runConfiguredEval, filterCases, type RunConfiguredDeps } from "./run-config"
import type { EvalCase, EvalDataset, EvalReport, EvalSample, Scorer } from "@/types/eval/eval"
import type { EvalDatasetVersion } from "@/types/eval/version"
import type { SaveCaseResultInput } from "@/lib/db/eval-run-cases"
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
  gating: true,
  score: () => ({
    scorerId: "always-pass",
    dimension: "response-quality",
    status: "scored",
    value: 1,
    passed: true,
  }),
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
    saved: jest.Mock<Promise<void>, [EvalReport]>
    savedCases: jest.Mock<Promise<void>, [SaveCaseResultInput]>
    snapshot: jest.Mock<Promise<EvalDatasetVersion>, [string]>
  } {
    const saved = jest.fn<Promise<void>, [EvalReport]>(async () => {})
    const savedCases = jest.fn<Promise<void>, [SaveCaseResultInput]>(async () => {})
    const snapshot = jest.fn<Promise<EvalDatasetVersion>, [string]>(async () => ({
      id: "ver_1",
      datasetId: "d",
      version: 3,
      caseIds: [],
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
    // Two per target: the "running" claim written before the first case, then
    // the settled report. The claim is what stops an interrupted run leaving
    // orphan per-case rows behind an id no row owns.
    expect(saved).toHaveBeenCalledTimes(4)
    expect(saved.mock.calls.map((c) => (c[0] as { status?: string }).status)).toEqual([
      "running",
      "completed",
      "running",
      "completed",
    ])
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
      verdict: string
      scores: Record<string, unknown>
    }
    expect(firstRow.verdict).toBe("pass")
    expect(firstRow.passAt1).toBe(true)
    expect(firstRow.scores["always-pass"]).toEqual({ value: 1, passed: true, status: "scored" })
  })

  it("carries judge reasoning onto the row and skips the key when absent", async () => {
    const withReasoning: Scorer = {
      id: "judge",
      dimension: "response-quality",
      requiresLlm: true,
      gating: true,
      score: () => ({
        scorerId: "judge",
        dimension: "response-quality",
        status: "scored",
        value: 1,
        passed: true,
        reasoning: "the answer covers every requested field",
      }),
    }
    const { deps, savedCases } = makeDeps({ allScorers: [withReasoning, passScorer] })
    await runConfiguredEval(
      "d",
      { targets: [{ kind: "chat", label: "A", model: "m" }], scorerIds: [], k: 1 },
      deps
    )
    const row = savedCases.mock.calls[0][0] as {
      scores: Record<string, { reasoning?: string }>
    }
    expect(row.scores.judge.reasoning).toBe("the answer covers every requested field")
    expect(row.scores["always-pass"]).not.toHaveProperty("reasoning")
  })

  it("persists the agent's answer, truncating at the configured cap", async () => {
    // Runs used to store scores and nothing else, so "case 7 failed" came with
    // no way to see what the model said or why the judge rejected it.
    const long = "x".repeat(50)
    const target: EvalTarget = { label: "t", run: async () => ({ ...sample, output: long }) }
    const { deps, savedCases } = makeDeps({
      buildTarget: () => target,
      maxStoredOutputChars: 10,
    })
    await runConfiguredEval(
      "d",
      { targets: [{ kind: "chat", label: "A", model: "m" }], scorerIds: [], k: 1 },
      deps
    )
    const row = savedCases.mock.calls[0][0] as { output: string; outputTruncated: boolean }
    expect(row.output).toBe("x".repeat(10))
    expect(row.outputTruncated).toBe(true)
  })

  it("stores the full answer when it fits, and none when the cap is 0", async () => {
    const target: EvalTarget = { label: "t", run: async () => ({ ...sample, output: "short" }) }
    const fits = makeDeps({ buildTarget: () => target, maxStoredOutputChars: 100 })
    await runConfiguredEval(
      "d",
      { targets: [{ kind: "chat", label: "A", model: "m" }], scorerIds: [], k: 1 },
      fits.deps
    )
    const kept = fits.savedCases.mock.calls[0][0] as { output?: string; outputTruncated?: boolean }
    expect(kept.output).toBe("short")
    expect(kept.outputTruncated).toBeUndefined()

    const off = makeDeps({ buildTarget: () => target, maxStoredOutputChars: 0 })
    await runConfiguredEval(
      "d",
      { targets: [{ kind: "chat", label: "A", model: "m" }], scorerIds: [], k: 1 },
      off.deps
    )
    expect(off.savedCases.mock.calls[0][0]).not.toHaveProperty("output")
  })

  it("records a run failure on the row instead of losing it", async () => {
    const target: EvalTarget = {
      label: "t",
      run: async () => {
        throw new Error("sidecar unavailable")
      },
    }
    const { deps, savedCases } = makeDeps({ buildTarget: () => target })
    await runConfiguredEval(
      "d",
      { targets: [{ kind: "chat", label: "A", model: "m" }], scorerIds: [], k: 1 },
      deps
    )
    expect((savedCases.mock.calls[0][0] as { sampleError: string }).sampleError).toBe(
      "sidecar unavailable"
    )
  })

  it("clamps a zero/absent k to 1 and forwards an abort signal", async () => {
    const { deps, saved } = makeDeps()
    const controller = new AbortController()
    const reports = await runConfiguredEval(
      "d",
      { targets: [{ kind: "chat", label: "A", model: "m" }], scorerIds: [], k: 0 },
      deps,
      controller.signal
    )
    expect(reports[0].k).toBe(1)
    expect(saved).toHaveBeenCalledTimes(2) // running claim + settled report
    // Aborting before the run starts yields a report over zero cases, not a throw.
    const pre = new AbortController()
    pre.abort()
    const aborted = await runConfiguredEval(
      "d",
      { targets: [{ kind: "chat", label: "A", model: "m" }], scorerIds: [], k: 1 },
      makeDeps().deps,
      pre.signal
    )
    expect(aborted[0].caseCount).toBe(0)
    // A run stopped part-way must not read as a completed one.
    expect(aborted[0].status).toBe("aborted")
  })

  it("writes the SAME verdict the report header uses (no second opinion)", async () => {
    // The row verdict used to be `scores.every(s => s.passed)`, which counted
    // not-applicable scores as failures while the report excluded them — the
    // run header said 100% and every row below it said FAIL. Both sides now
    // call `repetitionVerdict`, so a case only its non-applicable scorers
    // touched is `ungraded` in BOTH places.
    const naScorer: Scorer = {
      id: "needs-ref",
      dimension: "response-quality",
      requiresLlm: false,
      gating: true,
      score: () => ({
        scorerId: "needs-ref",
        dimension: "response-quality",
        status: "not-applicable",
        value: 0,
        passed: false,
        error: "not-applicable: no reference",
      }),
    }
    const { deps, savedCases } = makeDeps({ allScorers: [naScorer] })
    const reports = await runConfiguredEval(
      "d",
      { targets: [{ kind: "chat", label: "A", model: "m" }], scorerIds: [], k: 1 },
      deps
    )
    const rows = savedCases.mock.calls.map((c) => (c[0] as { verdict: string }).verdict)
    expect(rows).toEqual(["ungraded", "ungraded", "ungraded"])
    expect(reports[0].ungradedCaseCount).toBe(3)
    expect(reports[0].gradedCaseCount).toBe(0)
    expect(reports[0].passAt1).toBe(0)
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
